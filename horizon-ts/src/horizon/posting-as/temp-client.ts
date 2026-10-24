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
 * While a client exists its account's identity records are read from its own
 * PDS through it (`registerOwnIdentityClient`).
 */

import {type Agent, type Client} from '@atproto/lex'
import {
  PasswordSession,
  type PasswordSessionOptions,
} from '@atproto/lex-password-session'
import {t} from '@lingui/core/macro'

import {isJwtExpired} from '#/lib/jwt'
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
import {getPrismClient} from '#/horizon/routing/prism'
import {isOauthAccount, isSignedInAccount} from '#/horizon/session/accounts'
import {createOAuthTransport} from '#/horizon/session/oauth-transport'
import {storeRotatedAccount} from '#/horizon/session/stored-account'

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
  return isSignedInAccount(
    account,
    !!account.refreshJwt && !isJwtExpired(account.refreshJwt),
  )
}

/** The stored account for `did`, as persisted now. */
export function storedAccountFor(did: string): SessionAccount | undefined {
  return persisted.get('session').accounts.find(account => account.did === did)
}

/** The DIDs of every account stored on this device. */
export function storedAccountDids(): string[] {
  return persisted.get('session').accounts.map(account => account.did)
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

function buildPassword(account: SessionAccount): Built {
  let killed = false
  const hooks: PasswordSessionOptions = {
    fetch: (input, init) => {
      if (killed) throw new Error('temporary client disposed')
      return networkAwareFetch(input, init)
    },
    onUpdated(data) {
      if (killed) return
      const rotated = sessionDataToSessionAccount(
        data,
        data.service,
        account.pdsUrl,
      )
      if (rotated && !storeRotatedAccount(rotated)) {
        logger.warn('posting as: rotated tokens could not be stored')
      }
    },
    onDeleted() {
      // The server refused the session: requests fail; nothing is stored.
      killed = true
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
export function createTemporaryClient(account: SessionAccount): Built {
  if (!canActAs(account)) throw new TemporaryClientUnavailableError(account.did)
  return isOauthAccount(account) ? buildOAuth(account) : buildPassword(account)
}

type Entry = {
  built: Built
  refs: number
  unregister: () => void
}

const entries = new Map<string, Entry>()

/**
 * Hold `did`'s temporary client, making it when none is held. Call
 * {@link releaseTemporaryClient} once for every acquire.
 */
export function acquireTemporaryClient(did: string): PostingClients {
  const held = entries.get(did)
  if (held) {
    held.refs++
    return held.built.clients
  }
  const account = storedAccountFor(did)
  if (!account) throw new TemporaryClientUnavailableError(did)
  const built = createTemporaryClient(account)
  entries.set(did, {
    built,
    refs: 1,
    unregister: registerOwnIdentityClient(did, built.clients.pdsClient),
  })
  return built.clients
}

/** `did`'s temporary client while one is held, else `undefined`. */
export function peekTemporaryClient(did: string): PostingClients | undefined {
  return entries.get(did)?.built.clients
}

/**
 * Let go of one hold; the last one stops the client's requests and
 * unregisters its identity reads.
 */
export function releaseTemporaryClient(did: string) {
  const held = entries.get(did)
  if (!held) return
  held.refs--
  if (held.refs > 0) return
  entries.delete(did)
  held.unregister()
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
  void settled.finally(() => releaseTemporaryClient(did))
}

/** Test-only: drop every client. */
export function resetTemporaryClients() {
  for (const [did, held] of entries) {
    entries.delete(did)
    held.unregister()
    held.built.dispose()
  }
}
