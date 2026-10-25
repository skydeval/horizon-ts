/*
 * The system-session store (system accounts design 6.1, SA-7):
 * `horizon:systemSessions`, apart from the switcher's persisted accounts. One
 * entry per registered DID on this device, shared by every registering
 * account here; who holds it is worked out by the sweep, never stored.
 *
 * - `oauth`: the tokens stay in the OAuth library's store (one per DID on
 *   web, shared with the switcher, 6.2).
 * - `password`: the tokens are here, rotated at once, under a Web Lock
 *   across tabs (6.3, {@link withPasswordLock}).
 * - `switcher`: the DID is a usable switcher account; the switcher's stored
 *   account is used.
 * - No `kind`: a provisional entry written before a registration's popup
 *   opens (4.3 step 4), never "held".
 *
 * Only what Posting as and Act as need is kept (SAR3-N6): never the email
 * fields, `active` or `status`.
 */

import {useSyncExternalStore} from 'react'

import {type SessionAccount} from '#/state/session/types'
import {
  type GetSessionOutput,
  oauthAccountFrom,
} from '#/horizon/session/oauth-account'
import {readDevice, subscribeDevice, writeDevice} from './device'

export const SESSIONS_KEY = 'horizon:systemSessions'

export type SystemEntryKind = 'oauth' | 'password' | 'switcher'

/** One registered DID's device session (6.1). */
export type SystemEntry = {
  did: string
  handle?: string
  service?: string
  pdsUrl?: string
  /** Absent on a provisional entry. */
  kind?: SystemEntryKind
  /** The session ended; "Sign in again" (6.4). Survives `switcher`. */
  needsSignIn?: true
  /** A registration's result arrived (or the add was retried) at this time. */
  addingSince?: number
  /** The account that started the registration (SA-24). */
  addingFor?: string
  /** A registration popup may still return until this time (SA-26). */
  pendingUntil?: number
  /** `password` only. */
  accessJwt?: string
  refreshJwt?: string
}

export type SystemEntries = Readonly<Record<string, SystemEntry>>

const EMPTY: SystemEntries = Object.freeze({})

const FIELDS = [
  'did',
  'handle',
  'service',
  'pdsUrl',
  'kind',
  'needsSignIn',
  'addingSince',
  'addingFor',
  'pendingUntil',
  'accessJwt',
  'refreshJwt',
] as const

/** The entry with only the fields of 6.1, in a stable order. */
export function cleanEntry(value: Partial<SystemEntry> & {did: string}) {
  const out: Record<string, unknown> = {}
  for (const key of FIELDS) {
    const v = (value as Record<string, unknown>)[key]
    if (v === undefined || v === null || v === false) continue
    out[key] = v
  }
  if (out.kind !== 'password') {
    delete out.accessJwt
    delete out.refreshJwt
  }
  return out as SystemEntry
}

function parseEntry(value: unknown): SystemEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.did !== 'string' || !v.did.startsWith('did:')) return undefined
  const kind =
    v.kind === 'oauth' || v.kind === 'password' || v.kind === 'switcher'
      ? v.kind
      : undefined
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined)
  const num = (x: unknown) => (typeof x === 'number' ? x : undefined)
  return cleanEntry({
    did: v.did,
    handle: str(v.handle),
    service: str(v.service),
    pdsUrl: str(v.pdsUrl),
    kind,
    needsSignIn: v.needsSignIn === true ? true : undefined,
    addingSince: num(v.addingSince),
    addingFor: str(v.addingFor),
    pendingUntil: num(v.pendingUntil),
    accessJwt: str(v.accessJwt),
    refreshJwt: str(v.refreshJwt),
  })
}

let parsedRaw: string | undefined
let parsed: SystemEntries = EMPTY

/** Every entry, by DID. Stable between changes. */
export function getEntries(): SystemEntries {
  const raw = readDevice(SESSIONS_KEY)
  if (raw === parsedRaw) return parsed
  parsedRaw = raw
  parsed = EMPTY
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === 'object') {
        const out: Record<string, SystemEntry> = {}
        for (const [did, entry] of Object.entries(value)) {
          const read = parseEntry(entry)
          if (read && read.did === did) out[did] = read
        }
        parsed = Object.freeze(out)
      }
    } catch {
      // A damaged value reads as no entries.
    }
  }
  return parsed
}

/** `did`'s entry, or `undefined`. */
export function getEntry(did: string): SystemEntry | undefined {
  return getEntries()[did]
}

function writeEntries(next: Record<string, SystemEntry>) {
  const raw = Object.keys(next).length ? JSON.stringify(next) : undefined
  if (raw === readDevice(SESSIONS_KEY)) return
  writeDevice(SESSIONS_KEY, raw)
}

/** Store `entry` in place of `entry.did`'s. */
export function putEntry(entry: SystemEntry) {
  writeEntries({...getEntries(), [entry.did]: cleanEntry(entry)})
}

/**
 * Change some fields of `did`'s entry; a field set to `undefined` is
 * removed. Nothing happens when there is no entry.
 */
export function patchEntry(did: string, patch: Partial<SystemEntry>) {
  const entry = getEntry(did)
  if (!entry) return
  putEntry({...entry, ...patch, did})
}

/** Delete the entries of `dids`. */
export function deleteEntries(dids: readonly string[]) {
  const next = {...getEntries()}
  let changed = false
  for (const did of dids) {
    if (next[did]) {
      delete next[did]
      changed = true
    }
  }
  if (changed) writeEntries(next)
}

/** Delete `did`'s entry. */
export function deleteEntry(did: string) {
  deleteEntries([did])
}

/** Delete every entry (with "Sign out of every account", SA-21). */
export function clearEntries() {
  writeEntries({})
}

/** Mark `did`'s entry "Sign in again" (6.4), if it has one. */
export function markNeedsSignIn(did: string) {
  const entry = getEntry(did)
  if (entry && !entry.needsSignIn) putEntry({...entry, needsSignIn: true})
}

/** A successful sign-in for `did` clears its mark (4.4, SAR3-N7). */
export function clearNeedsSignIn(did: string) {
  const entry = getEntry(did)
  if (entry?.needsSignIn) putEntry({...entry, needsSignIn: undefined})
}

/** Whether the entry is provisional: no session of its own yet. */
export function isProvisional(entry: SystemEntry | undefined): boolean {
  return !!entry && entry.kind === undefined
}

/** Whether the entry is a complete `oauth` entry (vocabulary, "held"). */
export function isCompleteOAuthEntry(entry: SystemEntry | undefined): boolean {
  return entry?.kind === 'oauth'
}

/**
 * The entry for an OAuth session, built with the stock helper and then cut
 * down to 6.1's fields (SAR3-N6: no email in plain device storage).
 */
export function oauthEntryFrom(
  session: {issuer: string; aud: string},
  data: GetSessionOutput,
): SystemEntry {
  const account = oauthAccountFrom(session, data)
  return cleanEntry({
    did: account.did,
    handle: account.handle,
    service: account.service,
    pdsUrl: account.pdsUrl,
    kind: 'oauth',
  })
}

/** The entry for an app-password session, from its stored account. */
export function passwordEntryFrom(account: SessionAccount): SystemEntry {
  return cleanEntry({
    did: account.did,
    handle: account.handle,
    service: account.service,
    pdsUrl: account.pdsUrl,
    kind: 'password',
    accessJwt: account.accessJwt,
    refreshJwt: account.refreshJwt,
  })
}

/**
 * The account the temporary client is built from (6.1): the entry's fields,
 * the email fields left empty. `undefined` for a provisional or `switcher`
 * entry (the switcher's own stored account is used for `switcher`).
 */
export function entrySessionAccount(
  entry: SystemEntry,
): SessionAccount | undefined {
  if (entry.kind !== 'oauth' && entry.kind !== 'password') return undefined
  if (!entry.service) return undefined
  return {
    service: entry.service,
    did: entry.did as SessionAccount['did'],
    handle: entry.handle ?? entry.did,
    email: undefined,
    emailConfirmed: false,
    emailAuthFactor: false,
    refreshJwt: entry.kind === 'password' ? entry.refreshJwt : undefined,
    accessJwt: entry.kind === 'password' ? entry.accessJwt : undefined,
    signupQueued: false,
    active: true,
    status: undefined,
    pdsUrl: entry.pdsUrl,
    isSelfHosted: true,
    ...(entry.kind === 'oauth' ? {isOauthSession: true} : {}),
  }
}

type LockManager = {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>
}

function lockManager(): LockManager | undefined {
  const nav = (globalThis as {navigator?: {locks?: LockManager}}).navigator
  return nav?.locks && typeof nav.locks.request === 'function'
    ? nav.locks
    : undefined
}

/**
 * Run `fn` holding the Web Lock `horizon-system-password-<did>` (6.3): a
 * password refresh token is single use, so one tab refreshes at a time and
 * the next reads what it stored. Without Web Locks there is one runtime, so
 * no race.
 */
export function withPasswordLock<T>(
  did: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = lockManager()
  if (!locks) return fn()
  return locks.request(`horizon-system-password-${did}`, fn)
}

/* Subscriptions. */

const listeners = new Set<() => void>()
let watching: (() => void) | undefined

function notify() {
  listeners.forEach(listener => listener())
}

/**
 * Call `listener` on any change, in this tab or another one. Returns the
 * unsubscribe function.
 */
export function subscribeEntries(listener: () => void): () => void {
  listeners.add(listener)
  if (!watching) watching = subscribeDevice(SESSIONS_KEY, notify)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && watching) {
      watching()
      watching = undefined
    }
  }
}

/** {@link getEntries}, kept current. */
export function useSystemEntries(): SystemEntries {
  return useSyncExternalStore(subscribeEntries, getEntries)
}

/** Test-only: forget the parse cache. */
export function resetSessionStoreForTests() {
  parsedRaw = undefined
  parsed = EMPTY
}
