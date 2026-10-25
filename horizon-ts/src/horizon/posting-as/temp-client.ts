/*
 * The temporary client (Phase 5 design PP-16, 8.5; Phase 1 deferred it as
 * `createEphemeralClient`): lex clients for a stored account that is not the
 * current one, so the composer can post from it without switching.
 *
 * - An OAuth account sends through its own OAuth transport, which restores
 *   the session from the library's shared store on every request, so tokens
 *   rotate in one place for every tab and client.
 * - A password account gets a password session with no reducer hooks, whose
 *   rotated tokens are stored at once through `updated-stored-account`
 *   (PA-4): the old refresh token is spent, and the next resume of that
 *   account reads the stored copy.
 *
 * Dropping a temporary client never signs the account out and never touches
 * the stored session: it only stops its own requests. One client per
 * account, counted: the composer holds it while that account is chosen, and
 * a publish holds it until its front write and background work settle.
 * While the composer holds a client its account's identity records are read
 * from its own PDS through it (`registerOwnIdentityClient`); an act-as
 * action (`act-as.ts`) holds the same client without that, so the account's
 * records stay on prism for display (PP-20).
 *
 * System accounts (system accounts design 6.1, SA-H1): the account comes
 * from the system-session store, for a DID on the current account's cached
 * list only ({@link sessionAccountFor}); a switcher account that is not
 * listed is no longer found (S-1). A system password session rotates into
 * the system store, under a Web Lock across tabs (6.3).
 */

import {type Agent, type Client} from '@atproto/lex'
import {
  PasswordSession,
  type PasswordSessionOptions,
} from '@atproto/lex-password-session'
import {t} from '@lingui/core/macro'

import {canParseUrl} from '#/lib/strings/url-helpers'
import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {
  buildAppviewClient,
  buildChatClient,
  buildPdsClient,
  routeSessionToPds,
} from '#/state/session/clients'
import {networkAwareFetch} from '#/state/session/network'
import {
  sessionAccountToSessionData,
  sessionDataToSessionAccount,
} from '#/state/session/session-data'
import {type SessionAccount} from '#/state/session/types'
import {registerOwnIdentityClient} from '#/horizon/identity/reads'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {getPrismClient} from '#/horizon/routing/prism'
import {canAccountAct, isOauthAccount} from '#/horizon/session/accounts'
import {createOAuthTransport} from '#/horizon/session/oauth-transport'
import {storeRotatedAccount} from '#/horizon/session/stored-account'
import {
  getList,
  getLists,
  markListDied,
} from '#/horizon/system-accounts/list-store'
import {
  entrySessionAccount,
  getEntries,
  getEntry,
  markNeedsSignIn,
  patchEntry,
  subscribeEntries,
  withPasswordLock,
} from '#/horizon/system-accounts/session-store'

/** An account's clients, as the composer posts with them. */
export type PostingClients = {
  did: string
  handle: string
  pdsClient: Client
  appviewClient: Client
  chatClient: Client
  prismClient: Client
}

/**
 * The account cannot act from this device now: not stored, signed out, or
 * its session ended.
 */
export class TemporaryClientUnavailableError extends Error {
  constructor(readonly did: string) {
    super(t`That account isn’t signed in on this device.`)
    this.name = 'TemporaryClientUnavailableError'
  }
}

/**
 * Whether a stored account can act (Phase 1 4.5's predicates): an OAuth
 * account not marked signed out, a password account with an unexpired
 * refresh token.
 */
export function canActAs(account: SessionAccount): boolean {
  return canAccountAct(account)
}

/** The stored account for `did`, as persisted now. */
export function storedAccountFor(did: string): SessionAccount | undefined {
  return persisted.get('session').accounts.find(account => account.did === did)
}

/**
 * Every DID of the user's on this device (6.1): the switcher accounts, every
 * system session, and every DID on any cached system list and its owner.
 * `assertOwnGates` refuses their lists; wider is safer there (PP-19).
 */
export function storedAccountDids(): string[] {
  const dids = new Set<string>(
    persisted.get('session').accounts.map(account => account.did),
  )
  for (const did of Object.keys(getEntries())) dids.add(did)
  for (const [registrar, list] of Object.entries(getLists())) {
    dids.add(registrar)
    for (const account of list.accounts) dids.add(account.did)
  }
  return [...dids]
}

/** Where a temporary client's account came from, and so where it rotates. */
export type AccountSource = 'switcher' | 'system'

/**
 * The account `did` can act as from the current account (6.1, SA-H1): its
 * system-store entry, for a DID on the current account's cached list, not
 * marked "Sign in again", else nothing. A `switcher` entry uses the
 * switcher's stored account. With `SYSTEM_ACCOUNTS` off no list is read or
 * offered (SA-16), so nothing is found here either.
 */
export function sessionAccountFor(
  did: string,
  currentDid: string | undefined = getCurrentDid(),
): {account: SessionAccount; source: AccountSource} | undefined {
  if (!currentDid || did === currentDid) return undefined
  const listed = getList(currentDid)?.accounts.some(a => a.did === did)
  if (!listed) return undefined
  const entry = getEntry(did)
  if (!entry || entry.needsSignIn) return undefined
  if (entry.kind === 'switcher') {
    const account = storedAccountFor(did)
    return account && canActAs(account)
      ? {account, source: 'switcher'}
      : undefined
  }
  const account = entrySessionAccount(entry)
  return account && canActAs(account) ? {account, source: 'system'} : undefined
}

type Built = {clients: PostingClients; dispose: () => void}

function buildOAuth(account: SessionAccount): Built {
  const lifecycle = {killed: false}
  const transport = createOAuthTransport(account.did, lifecycle)
  return {
    clients: clientsOver(account, transport),
    dispose: () => {
      lifecycle.killed = true
    },
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function bearerOf(init: RequestInit | undefined): string | undefined {
  const value = new Headers(init?.headers).get('authorization')
  return value?.startsWith('Bearer ')
    ? value.slice('Bearer '.length)
    : undefined
}

const REFRESH_PATH = '/xrpc/com.atproto.server.refreshSession'

/**
 * A system password session's fetch (6.3): a refresh runs inside the Web
 * Lock `horizon-system-password-<did>` and re-reads the stored tokens first.
 * When another tab already rotated them, the stored pair is answered without
 * spending the old refresh token again; otherwise the refresh is sent and
 * its answer stored before the lock is let go.
 */
function systemPasswordFetch(did: string): typeof fetch {
  return (input, init) => {
    if (!new URL(urlOf(input)).pathname.endsWith(REFRESH_PATH)) {
      return networkAwareFetch(input, init)
    }
    return withPasswordLock(did, async () => {
      const stored = getEntry(did)
      const sent = bearerOf(init)
      if (
        stored?.kind === 'password' &&
        stored.refreshJwt &&
        stored.accessJwt &&
        sent &&
        stored.refreshJwt !== sent
      ) {
        return new Response(
          JSON.stringify({
            did,
            handle: stored.handle ?? did,
            accessJwt: stored.accessJwt,
            refreshJwt: stored.refreshJwt,
            active: true,
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        )
      }
      const response = await networkAwareFetch(input, init)
      if (response.ok) {
        try {
          const body = (await response.clone().json()) as {
            accessJwt?: unknown
            refreshJwt?: unknown
          }
          if (
            typeof body.accessJwt === 'string' &&
            typeof body.refreshJwt === 'string'
          ) {
            patchEntry(did, {
              accessJwt: body.accessJwt,
              refreshJwt: body.refreshJwt,
            })
          }
        } catch {
          // Not JSON: the session's own hook reports the failure.
        }
      }
      return response
    })
  }
}

function buildPassword(
  account: SessionAccount,
  source: AccountSource = 'switcher',
): Built {
  let killed = false
  const send =
    source === 'system' ? systemPasswordFetch(account.did) : undefined
  const hooks: PasswordSessionOptions = {
    fetch: (input, init) => {
      if (killed) throw new Error('temporary client disposed')
      return send ? send(input, init) : networkAwareFetch(input, init)
    },
    onUpdated(data) {
      if (killed) return
      const rotated = sessionDataToSessionAccount(
        data,
        data.service,
        account.pdsUrl,
      )
      if (!rotated) return
      if (source === 'system') {
        // The system store's sink (SA-H6): the switcher is never written.
        patchEntry(account.did, {
          accessJwt: rotated.accessJwt,
          refreshJwt: rotated.refreshJwt,
        })
        return
      }
      if (!storeRotatedAccount(rotated)) {
        logger.warn('posting as: rotated tokens could not be stored')
      }
    },
    onDeleted() {
      // The server refused the session: requests fail; nothing is stored.
      killed = true
      if (source === 'system') {
        // "Sign in again" (6.4), and a registering account's death mark.
        markNeedsSignIn(account.did)
        markListDied(account.did)
      }
    },
    onUpdateFailure() {},
  }
  const session = new PasswordSession(
    sessionAccountToSessionData(account),
    hooks,
  )
  const agent: Agent =
    account.pdsUrl && canParseUrl(account.pdsUrl)
      ? routeSessionToPds(session, account.pdsUrl)
      : session
  return {
    clients: clientsOver(account, agent),
    dispose: () => {
      killed = true
    },
  }
}

/**
 * The account's clients. None sends the per-install device and session ids
 * (SA-12): they would tie this account's requests to the current account's
 * by an exact id. The session builders leave them off for every account
 * (SQ-10), and the PDS and prism clients never carried them.
 */
function clientsOver(account: SessionAccount, agent: Agent): PostingClients {
  const pdsClient = buildPdsClient(agent)
  return {
    did: account.did,
    handle: account.handle,
    pdsClient,
    appviewClient: buildAppviewClient(agent),
    chatClient: buildChatClient(agent),
    prismClient: getPrismClient(pdsClient),
  }
}

/**
 * Build a temporary client for a stored account that can act. Throws
 * {@link TemporaryClientUnavailableError} otherwise.
 */
export function createTemporaryClient(
  account: SessionAccount,
  source: AccountSource = 'switcher',
): Built {
  if (!canActAs(account)) throw new TemporaryClientUnavailableError(account.did)
  return isOauthAccount(account)
    ? buildOAuth(account)
    : buildPassword(account, source)
}

type Entry = {
  built: Built
  refs: number
  /** The holds that read the account's identity records through it. */
  identityRefs: number
  unregister: (() => void) | undefined
  /** The account's system entry went away: the client was stopped. */
  stale?: boolean
}

/** Whether a hold reads the account's identity records through the client. */
export type TemporaryHold = {identity?: boolean}

const entries = new Map<string, Entry>()

let unwatchEntries: (() => void) | undefined

/**
 * Stop each held client whose account can no longer act from here (6.3,
 * "Tabs and the store"): a removal, a sign-out or a "Sign in again" mark in
 * this tab or another one. Its holds stay counted; the next acquire builds
 * it again if the account came back.
 */
function watchSystemEntries() {
  if (unwatchEntries) return
  unwatchEntries = subscribeEntries(() => {
    for (const [did, held] of entries) {
      if (held.stale || sessionAccountFor(did)) continue
      held.stale = true
      held.unregister?.()
      held.unregister = undefined
      held.built.dispose()
    }
  })
}

/**
 * Hold `did`'s temporary client, making it when none is held. Call
 * {@link releaseTemporaryClient} once for every acquire, with the same
 * `identity`. One client per account whoever holds it, so a password
 * session's tokens rotate in one place. Throws
 * {@link TemporaryClientUnavailableError} for a DID the current account
 * cannot act as (not listed, no session here, or "Sign in again").
 */
export function acquireTemporaryClient(
  did: string,
  {identity = true}: TemporaryHold = {},
): PostingClients {
  let held = entries.get(did)
  if (!held || held.stale) {
    const found = sessionAccountFor(did)
    if (!found) throw new TemporaryClientUnavailableError(did)
    const built = createTemporaryClient(found.account, found.source)
    if (held) {
      held.built = built
      held.stale = false
      if (held.identityRefs > 0) {
        held.unregister = registerOwnIdentityClient(
          did,
          built.clients.pdsClient,
        )
      }
    } else {
      held = {built, refs: 0, identityRefs: 0, unregister: undefined}
      entries.set(did, held)
    }
    watchSystemEntries()
  }
  held.refs++
  if (identity && held.identityRefs++ === 0) {
    held.unregister = registerOwnIdentityClient(
      did,
      held.built.clients.pdsClient,
    )
  }
  return held.built.clients
}

/** `did`'s temporary client while one is held, else `undefined`. */
export function peekTemporaryClient(did: string): PostingClients | undefined {
  const held = entries.get(did)
  return held && !held.stale ? held.built.clients : undefined
}

/**
 * Let go of one hold; the last one stops the client's requests and
 * unregisters its identity reads.
 */
export function releaseTemporaryClient(
  did: string,
  {identity = true}: TemporaryHold = {},
) {
  const held = entries.get(did)
  if (!held) return
  held.refs--
  if (identity && held.identityRefs > 0 && --held.identityRefs === 0) {
    held.unregister?.()
    held.unregister = undefined
  }
  if (held.refs > 0) return
  entries.delete(did)
  held.unregister?.()
  held.built.dispose()
}

/**
 * Hold `did`'s client until `settled` settles (a publish's background work).
 */
export function holdTemporaryClientUntil(
  did: string,
  settled: Promise<unknown>,
) {
  if (!entries.has(did)) return
  entries.get(did)!.refs++
  void settled.finally(() => releaseTemporaryClient(did, {identity: false}))
}

/** Test-only: drop every client. */
export function resetTemporaryClients() {
  for (const [did, held] of entries) {
    entries.delete(did)
    held.unregister?.()
    held.built.dispose()
  }
}
