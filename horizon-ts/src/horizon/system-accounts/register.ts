/*
 * Registering, re-verifying and removing system accounts (system accounts
 * design 4.3 to 4.5, 5.3, 5.4.1; SA-4, SA-5, SA-11, SA-17, SA-22 to SA-26).
 *
 * The registration sign-in is not a client sign-in (SA-5): nothing here
 * imports the switcher's sign-in paths, dispatches `switched-to-account` or
 * adds a switcher entry. A session it makes lives in the system store.
 *
 * **The registry** (4.3 step 4) is module-level, so a registration outlives
 * its dialog: one registration at a time, with its popup attempts, at most
 * one of them pending. Each attempt has its own random window name. The
 * library's wait is never aborted (no `signal`): an unacknowledged result
 * would make the popup revoke the session it just stored. There is no
 * `closed` poll (SAR3-L2); the wait ends through the library's result, its
 * error, or its 5-minute timeout. **Start again** opens a new attempt
 * without closing the old window. A registration completes once.
 *
 * **When a result arrives** (4.3 step 5), in order: `held` is read before
 * anything is written; the entry for the returned DID is written first
 * (SA-26); a mismatched account is signed out unless Horizon holds it; a
 * result after the current account changed is discarded and a new grant
 * revoked (SA-24); then the registration settles, once, and the add is
 * sent.
 */

import {type Client} from '@atproto/lex'
import {
  LexAuthFactorError,
  PasswordSession,
} from '@atproto/lex-password-session'
import {type BrowserOAuthClient} from '@atproto/oauth-client-browser'
import {type DidString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {jwtDecode} from 'jwt-decode'

import {createLexClient} from '#/lib/lexClient'
import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {networkAwareFetch} from '#/state/session/network'
import {sessionDataToSessionAccount} from '#/state/session/session-data'
import {type SessionAccount} from '#/state/session/types'
import {createTemporaryClient} from '#/horizon/posting-as/temp-client'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {
  canAccountAct,
  isOauthAccount,
  isOAuthSignedOut,
} from '#/horizon/session/accounts'
import {getOAuthClient} from '#/horizon/session/oauth-client'
import {OAUTH_SCOPE} from '#/horizon/session/oauth-metadata'
import {revokeOAuthGrant} from '#/horizon/session/revoke'
import {com} from '#/lexicons'
import {onAbandonRegistrations} from './abandon'
import {announce, type AnnouncementKind} from './announce'
import {
  addToList,
  clearAdding,
  getList,
  hideRow,
  type ListAccount,
  MAX_SYSTEM_ACCOUNTS,
  removeFromList,
  setDisplayFields,
  showAdding,
  unhideRow,
} from './list-store'
import {
  systemAccountsApi,
  SystemAccountsError,
  type SystemAccountsFailure,
} from './prism'
import {
  deleteEntry,
  entrySessionAccount,
  getEntry,
  isCompleteOAuthEntry,
  oauthEntryFrom,
  passwordEntryFrom,
  patchEntry,
  putEntry,
  type SystemEntry,
} from './session-store'
import {
  getSwitcherAccounts,
  PENDING_MS,
  runSweep,
  scheduleSweepTimer,
} from './sweep'
import {readList, reportDropped} from './sync'

/** **Start again** is offered this long after a press (4.3 step 4). */
export const START_AGAIN_AFTER_MS = 5_000

/* The environment, replaceable in tests. */

/** The OAuth session the popup returns, as this module uses it. */
export type PopupSession = {
  did: DidString
  serverMetadata: {issuer: string}
  getTokenInfo(refresh?: boolean): Promise<{aud: string}>
  signOut(): Promise<void>
  fetchHandler(pathname: string, init?: RequestInit): Promise<Response>
}

export type RegistrationEnv = {
  now(): number
  windowName(): string
  /** The pre-open in the press: `null` when the browser blocked it. */
  openWindow(name: string): Window | null
  /** The library's popup sign-in, started in the same press. */
  signIn(did: string, name: string): Promise<PopupSession>
  currentDid(): string | undefined
  currentPdsClient(): Client | undefined
  revoke(did: string): Promise<void>
}

function randomName(): string {
  const c = (globalThis as {crypto?: {randomUUID?: () => string}}).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

const defaultEnv: RegistrationEnv = {
  now: () => Date.now(),
  windowName: randomName,
  openWindow: name =>
    window.open(
      'about:blank',
      name,
      // The library's own features, so its `window.open` reuses this window.
      'width=600,height=600,menubar=no,toolbar=no',
    ),
  // `signIn` with `display: 'popup'` is this call; it takes the window name.
  signIn: (did, name) => {
    /*
     * Popup sign-in is web only: the app's client has none, and the dialog
     * offers the app-password path there instead
     */
    const client = getOAuthClient() as Partial<BrowserOAuthClient>
    if (!client.signInPopup) {
      return Promise.reject(new Error('Popup sign-in is only on the web'))
    }
    return client.signInPopup(did, {
      display: 'popup',
      popupName: name,
      prompt: 'login',
      scope: OAUTH_SCOPE,
    })
  },
  currentDid: () => getCurrentClients()?.did,
  currentPdsClient: () => getCurrentClients()?.pdsClient,
  revoke: did => revokeOAuthGrant(did),
}

let env = defaultEnv

/** Test-only: replace parts of the environment (undefined resets). */
export function setRegistrationEnvForTests(next?: Partial<RegistrationEnv>) {
  env = next ? {...defaultEnv, ...next} : defaultEnv
}

/* The registry. */

export type RegistrationMode = 'add' | 'reverify'

export type RegistrationOutcome =
  | {kind: 'idle'}
  | {kind: 'waiting'}
  | {kind: 'blocked'}
  | {kind: 'timeout'}
  | {kind: 'signInFailed'; message: string}
  | {kind: 'mismatch'; got: string}
  | {kind: 'switched'}
  | {kind: 'adding'}
  | {kind: 'added'}
  | {kind: 'signedIn'}
  | {kind: 'signedInFor'}
  | {kind: 'addFailed'; reason: SystemAccountsFailure}
  | {kind: 'needsAuthFactor'}
  | {kind: 'mainPassword'}

type Attempt = {
  name: string
  popup: Window | null
  startedAt: number
  done: boolean
  abandoned: boolean
}

/** The account being registered or re-verified, and for whom. */
export type Registration = {
  id: number
  did: string
  handle: string | undefined
  pdsUrl: string | undefined
  /** The account that started it (SA-24). */
  addingFor: string
  addingForHandle: string | undefined
  mode: RegistrationMode
  settled: boolean
  abandoned: boolean
  attempts: Attempt[]
  outcome: RegistrationOutcome
}

let registration: Registration | undefined
let nextId = 1
let dialogOpen = 0
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version++
  listeners.forEach(listener => listener())
}

/** The current registration, if any. */
export function getRegistration(): Registration | undefined {
  return registration
}

/** A number that changes with every registry change. */
export function getRegistrationVersion(): number {
  return version
}

/** Subscribe to registry changes. Returns the unsubscribe function. */
export function subscribeRegistration(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A dialog showing the registration is open: outcomes are shown and read
 * there, not by the shell announcer (4.6). Returns the close function.
 */
export function registrationDialogOpened(): () => void {
  dialogOpen++
  let closed = false
  return () => {
    if (closed) return
    closed = true
    dialogOpen = Math.max(0, dialogOpen - 1)
    // An Add dialog closing runs the sweep (6.5).
    void runSweep()
  }
}

function pendingAttempt(reg: Registration): Attempt | undefined {
  return reg.attempts.find(a => !a.done && !a.abandoned)
}

/** Whether `reg` has a popup attempt in flight. */
export function hasPendingAttempt(reg: Registration | undefined): boolean {
  return !!reg && !reg.settled && !reg.abandoned && !!pendingAttempt(reg)
}

/** When **Start again** may be offered for `reg`, or `undefined`. */
export function startAgainAt(
  reg: Registration | undefined,
): number | undefined {
  const pending =
    reg && hasPendingAttempt(reg) ? pendingAttempt(reg) : undefined
  return pending ? pending.startedAt + START_AGAIN_AFTER_MS : undefined
}

function setOutcome(reg: Registration, outcome: RegistrationOutcome) {
  reg.outcome = outcome
  changed()
  if (dialogOpen === 0 && registration === reg) {
    const message = outcomeMessage(reg)
    if (message) announce(message.text, message.kind)
  }
}

function name(handle: string | undefined, did: string): string {
  return handle ? `@${handle}` : did
}

/**
 * The text of an outcome, for the dialog and, once it closed, the shell
 * announcer (4.6). `undefined` when there is nothing to say.
 */
export function outcomeMessage(
  reg: Registration,
): {text: string; kind: AnnouncementKind} | undefined {
  const lala = name(reg.handle, reg.did)
  const a = name(reg.addingForHandle, reg.addingFor)
  const o = reg.outcome
  switch (o.kind) {
    case 'waiting':
      return {
        text: t`Waiting for the sign-in window at your server.`,
        kind: 'polite',
      }
    case 'blocked':
      return {
        text: t`Your browser blocked the sign-in window. Allow pop-ups for this site and try again, or use an app password.`,
        kind: 'alert',
      }
    case 'timeout':
      return {
        text: t`The sign-in window timed out after 5 minutes. If it is still open, close it. Try again, or use an app password.`,
        kind: 'alert',
      }
    case 'signInFailed':
      return {text: o.message, kind: 'alert'}
    case 'mismatch':
      return {
        text: t`Your server signed in ${o.got}, not ${lala}. Sign out of ${o.got} on your server’s website, then try again.`,
        kind: 'alert',
      }
    case 'switched':
      return {
        text: t`Registration was for ${a}. Switch back to ${a} and add ${lala} again.`,
        kind: 'alert',
      }
    case 'added':
      return {text: t`${lala} added to your system accounts`, kind: 'polite'}
    case 'signedIn':
      return {text: t`${lala} is ready on this device.`, kind: 'polite'}
    case 'signedInFor':
      return {text: t`Signed in to ${lala} for ${a}.`, kind: 'polite'}
    case 'addFailed':
      return {text: addFailureMessage(o.reason, lala), kind: 'alert'}
    case 'needsAuthFactor':
      return {
        text: t`Enter the code your server sent you to finish signing in.`,
        kind: 'polite',
      }
    case 'mainPassword':
      return {
        text: t`That’s your account password. Create an app password at your server and use that instead.`,
        kind: 'alert',
      }
    default:
      return undefined
  }
}

/** The message for a failed add (5.3). */
export function addFailureMessage(
  reason: SystemAccountsFailure,
  lala: string,
): string {
  switch (reason) {
    case 'proof':
      return t`${lala}’s server didn’t confirm the account. Try again.`
    case 'full':
      return t`Up to 31 system accounts`
    case 'limited':
      return t`Too many tries just now. Wait a moment, then try again.`
    case 'unavailable':
      return t`System accounts aren’t available right now.`
    case 'refused':
      return t`Couldn’t add ${lala}. Try again.`
    default:
      return t`Couldn’t reach Horizon’s server. Try again.`
  }
}

/**
 * Begin registering (or re-verifying) `target` for the current account. A
 * pending registration is kept and returned instead (one at a time); the
 * caller says "Finish signing in to @lala first, or start again." for a
 * different DID.
 */
export function beginRegistration(
  target: {did: string; handle?: string; pdsUrl?: string},
  mode: RegistrationMode,
): Registration | undefined {
  if (hasPendingAttempt(registration)) return registration
  const addingFor = env.currentDid()
  if (!addingFor) {
    logger.warn('system accounts: registration not started, no current account')
    return undefined
  }
  const current = getCurrentClients()
  registration = {
    id: nextId++,
    did: target.did,
    handle: target.handle,
    pdsUrl: target.pdsUrl,
    addingFor,
    addingForHandle: current?.did === addingFor ? current.handle : undefined,
    mode,
    settled: false,
    abandoned: false,
    attempts: [],
    outcome: {kind: 'idle'},
  }
  changed()
  return registration
}

/** Forget a registration that is not pending (its dialog's state). */
export function clearRegistration(reg: Registration | undefined) {
  if (!reg || registration !== reg || hasPendingAttempt(reg)) return
  registration = undefined
  changed()
}

/**
 * **Sign in at your server**, in the press handler, before any `await`
 * (4.3 step 4). With an attempt pending it only tries to bring that window
 * forward. Returns what happened.
 */
export function pressSignIn(): 'started' | 'focused' | 'blocked' | 'none' {
  const reg = registration
  if (!reg || reg.settled || reg.abandoned) return 'none'
  const pending = pendingAttempt(reg)
  if (pending) {
    try {
      pending.popup?.focus()
    } catch {
      // Best effort: a severed handle or a refusing browser.
    }
    return 'focused'
  }
  return startAttempt(reg)
}

/**
 * **Start again** (4.3 step 4): the pending attempt is abandoned in Horizon
 * (its listener is left to run out, so a result from the old window is
 * still acknowledged and handled), and a new attempt opens in the same
 * press, without trying to close the old window. `target` starts again for
 * another DID, abandoning the pending registration.
 */
export function startAgain(target?: {
  did: string
  handle?: string
  pdsUrl?: string
  mode: RegistrationMode
}): 'started' | 'blocked' | 'none' {
  let reg = registration
  if (!reg) return 'none'
  for (const attempt of reg.attempts) attempt.abandoned = true
  if (target && target.did !== reg.did) {
    reg.abandoned = true
    registration = undefined
    reg = beginRegistration(target, target.mode)
    if (!reg) return 'none'
  }
  if (reg.settled) return 'none'
  const result = startAttempt(reg)
  return result === 'blocked' ? 'blocked' : 'started'
}

/** **Use an app password instead**: the pending attempt is abandoned. */
export function abandonPendingAttempt() {
  const reg = registration
  if (!reg) return
  for (const attempt of reg.attempts) attempt.abandoned = true
  // The popup's own states don't carry over to the app password step.
  const kind = reg.outcome.kind
  if (kind === 'waiting' || kind === 'blocked' || kind === 'timeout') {
    reg.outcome = {kind: 'idle'}
  }
  changed()
}

/**
 * The sign-out seam (6.5 step 1): abandon every registration `which`
 * picks. A result that still arrives is discarded (step 5.5) and a new
 * grant revoked.
 */
export function abandonRegistrations(which: (reg: Registration) => boolean) {
  const reg = registration
  if (!reg || !which(reg)) return
  reg.abandoned = true
  for (const attempt of reg.attempts) attempt.abandoned = true
  changed()
}

// The sign-out seam reaches the registry through `abandon.ts`.
onAbandonRegistrations(which => abandonRegistrations(which))

function startAttempt(reg: Registration): 'started' | 'blocked' {
  const now = env.now()
  const windowName = env.windowName()
  // The provisional entry, or `pendingUntil` on the entry the DID has (SA-26).
  const existing = getEntry(reg.did)
  const wroteProvisional = !existing
  if (existing) {
    putEntry({
      ...existing,
      pendingUntil: now + PENDING_MS,
      addingFor: existing.addingFor ?? reg.addingFor,
    })
  } else {
    putEntry({
      did: reg.did,
      handle: reg.handle,
      addingSince: now,
      addingFor: reg.addingFor,
      pendingUntil: now + PENDING_MS,
    })
  }
  const popup = env.openWindow(windowName)
  if (!popup) {
    if (wroteProvisional) deleteEntry(reg.did)
    else patchEntry(reg.did, {pendingUntil: undefined})
    setOutcome(reg, {kind: 'blocked'})
    return 'blocked'
  }
  const attempt: Attempt = {
    name: windowName,
    popup,
    startedAt: now,
    done: false,
    abandoned: false,
  }
  reg.attempts.push(attempt)
  // `signInPopup` opens its window synchronously, before any await.
  const result = env.signIn(reg.did, windowName)
  setOutcome(reg, {kind: 'waiting'})
  scheduleSweepTimer(now)
  result.then(
    session => {
      attempt.done = true
      void onResult(reg, session).catch(error => {
        logger.warn('system accounts: a registration result failed', {
          safeMessage: error,
        })
      })
    },
    error => {
      attempt.done = true
      onAttemptError(reg, attempt, error)
    },
  )
  return 'started'
}

function onAttemptError(reg: Registration, attempt: Attempt, error: unknown) {
  if (reg.settled || reg.abandoned || attempt.abandoned) {
    changed()
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'Timeout') {
    setOutcome(reg, {kind: 'timeout'})
  } else {
    setOutcome(reg, {kind: 'signInFailed', message: cleanError(message)})
  }
}

/**
 * "Horizon holds an OAuth session for `did`" (vocabulary, SAR3-L3): a
 * usable OAuth switcher account (stock's test), or a complete `oauth`
 * system entry.
 */
export function isHeld(did: string): boolean {
  const switcher = getSwitcherAccounts().some(
    account =>
      account.did === did &&
      isOauthAccount(account) &&
      !isOAuthSignedOut(account),
  )
  return switcher || isCompleteOAuthEntry(getEntry(did))
}

async function displayName(did: string, fallback?: string): Promise<string> {
  if (fallback) return `@${fallback}`
  try {
    const identity = await getOAuthClient().identityResolver.resolve(did)
    return identity.handle && identity.handle !== 'handle.invalid'
      ? `@${identity.handle}`
      : did
  } catch {
    return did
  }
}

/** Fill in the entry's PDS and handle from the session itself. */
async function fillOAuthEntry(session: PopupSession, reg: Registration) {
  try {
    const {aud} = await session.getTokenInfo(false)
    const data = await createLexClient({
      did: session.did,
      fetchHandler: (path, init) => session.fetchHandler(path, init),
    }).call(com.atproto.server.getSession, {})
    const entry = getEntry(session.did)
    if (entry?.kind !== 'oauth') return
    const full = oauthEntryFrom(
      {issuer: session.serverMetadata.issuer, aud},
      data,
    )
    putEntry({
      ...full,
      needsSignIn: entry.needsSignIn,
      addingSince: entry.addingSince,
      addingFor: entry.addingFor,
      pendingUntil: entry.pendingUntil,
    })
    if (session.did === reg.did && data.handle) reg.handle ??= data.handle
    setDisplayFields(session.did, {handle: data.handle})
  } catch (error) {
    logger.info('system accounts: the session details could not be read', {
      safeMessage: error,
    })
  }
}

/** Step 5 (4.3), in order. */
async function onResult(reg: Registration, session: PopupSession) {
  const did = session.did
  const now = env.now()
  // `held` before 5.1 writes anything.
  const held = isHeld(did)

  // 5.1: the entry first, for whatever DID came back (SA-26).
  if (!held) {
    putEntry({
      ...getEntry(did),
      did,
      kind: 'oauth',
      service: new URL(session.serverMetadata.issuer).toString(),
      handle: did === reg.did ? reg.handle : getEntry(did)?.handle,
      needsSignIn: undefined,
      addingSince: now,
      addingFor: reg.addingFor,
      pendingUntil: undefined,
    })
  } else if (did === reg.did) {
    // A re-verify of a held entry, or an add of a held account.
    const entry = getEntry(did)
    if (entry) {
      putEntry({
        ...entry,
        needsSignIn: undefined,
        pendingUntil: undefined,
        ...(reg.mode === 'add'
          ? {addingSince: now, addingFor: reg.addingFor}
          : {}),
      })
    }
  }
  if (did !== reg.did) {
    // No session came back for the expected DID.
    const expected = getEntry(reg.did)
    if (expected && expected.kind === undefined) deleteEntry(reg.did)
    else if (expected) patchEntry(reg.did, {pendingUntil: undefined})
  }

  // 5.2: the mismatch check.
  if (did !== reg.did) {
    if (!held) {
      try {
        await session.signOut()
      } catch {
        // Deleted locally whatever the server answers.
      }
      deleteEntry(did)
    }
    const got = await displayName(did)
    if (!reg.settled) setOutcome(reg, {kind: 'mismatch', got})
    void runSweep()
    return
  }

  // 5.5: the registering account must still be current (SA-24).
  if (reg.abandoned || env.currentDid() !== reg.addingFor) {
    if (reg.settled) return
    reg.settled = true
    if (reg.mode === 'reverify' && !reg.abandoned) {
      // Already on `addingFor`'s list: a holder decides (4.4).
      void fillOAuthEntry(session, reg)
      setOutcome(reg, {kind: 'signedInFor'})
      void runSweep()
      return
    }
    if (!held) {
      await env.revoke(did)
      deleteEntry(did)
    }
    setOutcome(reg, {kind: 'switched'})
    void runSweep()
    return
  }

  // 5.6: settle once, then add.
  if (reg.settled) return
  reg.settled = true
  await fillOAuthEntry(session, reg)
  if (reg.mode === 'reverify') {
    setOutcome(reg, {kind: 'signedIn'})
    void runSweep()
    return
  }
  await sendAdd(reg)
}

/** The added account's PDS client, for its proof, and how to let it go. */
function addedClient(
  entry: SystemEntry,
): {pdsClient: Client; dispose: () => void} | undefined {
  let account: SessionAccount | undefined
  let source: 'switcher' | 'system' = 'system'
  if (entry.kind === 'switcher') {
    account = getSwitcherAccounts().find(a => a.did === entry.did)
    source = 'switcher'
  } else {
    account = entrySessionAccount(entry)
  }
  if (!account || !canAccountAct(account)) return undefined
  try {
    const built = createTemporaryClient(account, source)
    return {pdsClient: built.clients.pdsClient, dispose: built.dispose}
  } catch {
    return undefined
  }
}

/** Whether a read of `registrar`'s list (now) has `did`. */
async function listHas(registrar: string, did: string): Promise<boolean> {
  const pds = env.currentPdsClient()
  if (!pds || env.currentDid() !== registrar) return false
  const ok = await readList(registrar, pds, {force: true})
  return ok && !!getList(registrar)?.accounts.some(a => a.did === did)
}

function added(reg: Registration, rev: string) {
  const account: ListAccount = {
    did: reg.did,
    ...(reg.handle ? {handle: reg.handle} : {}),
    addedAt: new Date(env.now()).toISOString(),
  }
  addToList(reg.addingFor, account, rev)
  // The add's own answer counts as a read at its rev (5.3).
  const entry = getEntry(reg.did)
  if (entry?.addingFor === reg.addingFor) {
    patchEntry(reg.did, {addingSince: undefined, addingFor: undefined})
  }
  setOutcome(reg, {kind: 'added'})
  const pds = env.currentPdsClient()
  if (pds) void readList(reg.addingFor, pds, {force: true})
}

/**
 * The add (5.3): the current account must still be `addingFor`; the added
 * account's client mints the proof, the current account's client sends the
 * call direct to prism. No answer is unknown, not failure: the list is read
 * once before reporting.
 */
async function sendAdd(reg: Registration) {
  const registrar = reg.addingFor
  const pds = env.currentPdsClient()
  if (env.currentDid() !== registrar || !pds) {
    setOutcome(reg, {kind: 'switched'})
    return
  }
  const entry = getEntry(reg.did)
  const client = entry ? addedClient(entry) : undefined
  if (!client) {
    setOutcome(reg, {kind: 'addFailed', reason: 'proof'})
    return
  }
  setOutcome(reg, {kind: 'adding'})
  showAdding(registrar, {
    did: reg.did,
    ...(reg.handle ? {handle: reg.handle} : {}),
    addedAt: '',
  })
  try {
    const api = systemAccountsApi()
    const {rev} = await api.addSystemAccount(pds, reg.did, () =>
      api.mintProof(client.pdsClient),
    )
    added(reg, rev)
  } catch (error) {
    const reason =
      error instanceof SystemAccountsError ? error.reason : 'unknown'
    if (reason === 'unknown' && (await listHas(registrar, reg.did))) {
      setOutcome(reg, {kind: 'added'})
    } else {
      setOutcome(reg, {
        kind: 'addFailed',
        reason: reason === 'unknown' ? 'unreachable' : reason,
      })
    }
  } finally {
    client.dispose()
    clearAdding(registrar, reg.did)
  }
}

/**
 * **Try again** after a failed add (5.3): `addingSince` refreshed first, so
 * a retry after a long outage starts a new grace. If the session was swept
 * meanwhile, `'signIn'`: the dialog goes back to the sign-in step.
 */
export async function retryAdd(): Promise<'sent' | 'signIn' | 'none'> {
  const reg = registration
  if (!reg || reg.mode !== 'add') return 'none'
  const entry = getEntry(reg.did)
  if (!entry || entry.needsSignIn || entry.kind === undefined) {
    reg.settled = false
    reg.attempts = []
    setOutcome(reg, {kind: 'idle'})
    return 'signIn'
  }
  if (env.currentDid() !== reg.addingFor) {
    setOutcome(reg, {kind: 'switched'})
    return 'none'
  }
  putEntry({...entry, addingSince: env.now(), addingFor: reg.addingFor})
  await sendAdd(reg)
  return 'sent'
}

/**
 * Add a usable switcher account (4.3 step 2, SA-11): no new sign-in, one
 * confirm. The proof is minted with its switcher session.
 */
export async function addSwitcherAccount(reg: Registration) {
  if (env.currentDid() !== reg.addingFor) {
    setOutcome(reg, {kind: 'switched'})
    return
  }
  const account = getSwitcherAccounts().find(a => a.did === reg.did)
  if (!account || !canAccountAct(account)) {
    setOutcome(reg, {kind: 'addFailed', reason: 'proof'})
    return
  }
  const existing = getEntry(reg.did)
  putEntry({
    ...existing,
    did: reg.did,
    handle: account.handle,
    kind: 'switcher',
    addingSince: env.now(),
    addingFor: reg.addingFor,
    accessJwt: undefined,
    refreshJwt: undefined,
  })
  reg.handle ??= account.handle
  reg.settled = true
  await sendAdd(reg)
}

/** Whether `did` is a usable switcher account (SA-11; not a system-only session). */
export function isUsableSwitcherAccount(did: string): boolean {
  const account = getSwitcherAccounts().find(a => a.did === did)
  return !!account && canAccountAct(account)
}

function accessScope(accessJwt: string): string | undefined {
  try {
    const payload = jwtDecode<{scope?: unknown}>(accessJwt)
    return typeof payload.scope === 'string' ? payload.scope : undefined
  } catch {
    return undefined
  }
}

/**
 * The app password form (4.3 step 6): `login` to the account's own PDS from
 * the DID document resolved on Next, never the stock default, and never
 * through the stock `login`. The returned DID must be the expected one; a
 * full-access token, where the token says so, is refused; after a switch the
 * new tokens are discarded. Then the add (or, for a re-verify, nothing).
 */
export async function signInWithAppPassword({
  password,
  authFactorToken,
}: {
  password: string
  authFactorToken?: string
}): Promise<void> {
  const reg = registration
  if (!reg) return
  abandonPendingAttempt()
  const service = reg.pdsUrl
  if (!service) {
    setOutcome(reg, {kind: 'addFailed', reason: 'unreachable'})
    return
  }
  let session: PasswordSession
  try {
    session = await PasswordSession.login({
      service,
      identifier: reg.handle ?? reg.did,
      password,
      authFactorToken,
      fetch: networkAwareFetch,
    })
  } catch (error) {
    if (error instanceof LexAuthFactorError) {
      setOutcome(reg, {kind: 'needsAuthFactor'})
      return
    }
    setOutcome(reg, {
      kind: 'signInFailed',
      message: cleanError(
        error instanceof Error ? error.message : String(error),
      ),
    })
    return
  }
  const discard = async () => {
    try {
      await session.logout()
    } catch {
      // Best effort: the tokens are forgotten here either way.
    }
  }
  const data = session.session
  if (data.did !== reg.did) {
    await discard()
    setOutcome(reg, {kind: 'mismatch', got: `@${data.handle}`})
    return
  }
  if (accessScope(data.accessJwt) === 'com.atproto.access') {
    await discard()
    setOutcome(reg, {kind: 'mainPassword'})
    return
  }
  if (reg.abandoned || env.currentDid() !== reg.addingFor) {
    await discard()
    setOutcome(reg, {kind: 'switched'})
    return
  }
  const account = sessionDataToSessionAccount(data, service, service)
  if (!account) return
  const before = getEntry(reg.did)
  if (before?.kind === 'oauth' && !isHeldBySwitcher(reg.did)) {
    // The app password replaces an OAuth grant this store alone referenced.
    void revokeOAuthGrant(reg.did)
  }
  putEntry({
    ...passwordEntryFrom(account),
    ...(reg.mode === 'add'
      ? {addingSince: env.now(), addingFor: reg.addingFor}
      : {}),
  })
  reg.handle ??= data.handle
  setDisplayFields(reg.did, {handle: data.handle})
  if (reg.settled) return
  reg.settled = true
  if (reg.mode === 'reverify') {
    setOutcome(reg, {kind: 'signedIn'})
    void runSweep()
    return
  }
  await sendAdd(reg)
}

function isHeldBySwitcher(did: string): boolean {
  return getSwitcherAccounts().some(
    account =>
      account.did === did &&
      isOauthAccount(account) &&
      !isOAuthSignedOut(account),
  )
}

/* Remove (4.5) and leave (5.4.1). */

type RemovingListener = (did: string, removing: boolean) => void
const removingListeners = new Set<RemovingListener>()

/**
 * Called when a remove starts and settles, so a composer posting as that
 * account holds Post meanwhile ("Removing @lala..."). Returns the
 * unsubscribe function.
 */
export function onRemoving(listener: RemovingListener) {
  removingListeners.add(listener)
  return () => {
    removingListeners.delete(listener)
  }
}

/**
 * Remove `did` from the current account's list (4.5): hidden at once
 * through an overlay a list read cannot undo; on success the cache, the
 * sweep and then a composer's reset; on a refusal the row comes back and
 * nothing was revoked. No answer is unknown: the list is read once.
 */
export async function removeSystemAccount(
  registrar: string,
  did: string,
  handle: string | undefined,
): Promise<'removed' | 'failed'> {
  const lala = name(handle, did)
  const pds = env.currentPdsClient()
  if (env.currentDid() !== registrar || !pds) {
    announce(t`Couldn’t remove ${lala}. Try again.`, 'alert')
    return 'failed'
  }
  hideRow(registrar, did)
  removingListeners.forEach(listener => listener(did, true))
  let removed = false
  try {
    const {rev} = await systemAccountsApi().removeSystemAccount(pds, did)
    removeFromList(registrar, did, rev)
    removed = true
  } catch (error) {
    const reason =
      error instanceof SystemAccountsError ? error.reason : 'unknown'
    if (reason === 'unknown') {
      const ok = await readList(registrar, pds, {force: true})
      removed = ok && !getList(registrar)?.accounts.some(a => a.did === did)
    }
  }
  unhideRow(registrar, did)
  removingListeners.forEach(listener => listener(did, false))
  if (!removed) {
    announce(t`Couldn’t remove ${lala}. Try again.`, 'alert')
    return 'failed'
  }
  await runSweep()
  // The reset runs on success only (SAR2-N10).
  reportDropped(registrar, [did])
  announce(t`${lala} removed from your system accounts`)
  void readList(registrar, pds, {force: true})
  return 'removed'
}

/** The registered account's status (5.4.1): `undefined` until read. */
export async function readRegisteredStatus(): Promise<boolean | undefined> {
  const pds = env.currentPdsClient()
  if (!pds) return undefined
  try {
    const {registered} = await systemAccountsApi().getSystemAccountStatus(pds)
    return registered
  } catch {
    return undefined
  }
}

/** **Leave every system** (5.4.1), as the current account. */
export async function leaveEverySystem(): Promise<boolean> {
  const pds = env.currentPdsClient()
  if (!pds) return false
  try {
    await systemAccountsApi().leaveSystemAccounts(pds)
    return true
  } catch {
    return false
  }
}

/** Whether `registrar`'s list is at the cap (4.2). */
export function atCap(registrar: string): boolean {
  return (getList(registrar)?.accounts.length ?? 0) >= MAX_SYSTEM_ACCOUNTS
}

/** Test-only: forget the registry. */
export function resetRegistrationForTests() {
  registration = undefined
  dialogOpen = 0
  version = 0
  removingListeners.clear()
  setRegistrationEnvForTests(undefined)
}
