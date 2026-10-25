/*
 * The device cache of each account's system list (system accounts design
 * 5.5, SA-6, SA-19, SA-21): `horizon:systemAccounts`, per registering DID,
 * `{accounts: [{did, handle?, displayName?, avatar?, addedAt}], rev,
 * syncedAt, diedAt?}`.
 *
 * - Read synchronously, so Posting as, Act as and the section open at once;
 *   prism is read in the background (`sync.ts`).
 * - prism's answer replaces the DIDs unless its `rev` is lower than the
 *   cache's (an older answer, SAR2-N3); display fields are kept for DIDs
 *   still listed.
 * - `diedAt` (SAR3-L5) marks a registering account whose session Horizon saw
 *   end. The sweep counts such a list as a holder only within the page load
 *   in which it died ({@link listHolds}).
 * - Two in-memory overlays, never stored: rows hidden while a remove is in
 *   flight (4.5) and rows shown as "Adding..." while an add runs (4.3 step 7).
 *   Neither changes what the menus offer.
 */

import {useSyncExternalStore} from 'react'

import {readDevice, subscribeDevice, writeDevice} from './device'

export const LISTS_KEY = 'horizon:systemAccounts'

/** A listed system account. Display fields are SA-19's only. */
export type ListAccount = {
  did: string
  handle?: string
  displayName?: string
  avatar?: string
  addedAt: string
}

/** One registering account's cached list. */
export type CachedList = {
  accounts: ListAccount[]
  rev: string
  syncedAt: number
  diedAt?: number
}

export type CachedLists = Readonly<Record<string, CachedList>>

/** The cap prism enforces (SQ-7): with the current account, the TID clock's 32 ids. */
export const MAX_SYSTEM_ACCOUNTS = 31

/** A list read older than this is read again in the background (5.5). */
export const LIST_STALE_MS = 5 * 60_000

const EMPTY: CachedLists = Object.freeze({})

let loadStartedAt = Date.now()

/**
 * When this page load started (6.4, SAR3-L5): a `diedAt` before it means the
 * death was seen in an earlier load.
 */
export function getLoadStartedAt(): number {
  return loadStartedAt
}

/** Test-only: pretend the page load started at `at`. */
export function setLoadStartedAtForTests(at: number) {
  loadStartedAt = at
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function parseAccount(value: unknown): ListAccount | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (!isString(v.did) || !v.did.startsWith('did:')) return undefined
  return {
    did: v.did,
    ...(isString(v.handle) ? {handle: v.handle} : {}),
    ...(isString(v.displayName) ? {displayName: v.displayName} : {}),
    ...(isString(v.avatar) ? {avatar: v.avatar} : {}),
    addedAt: isString(v.addedAt) ? v.addedAt : '',
  }
}

function parseList(value: unknown): CachedList | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.accounts)) return undefined
  const accounts = v.accounts
    .map(parseAccount)
    .filter((a): a is ListAccount => !!a)
  return {
    accounts,
    rev: isString(v.rev) ? v.rev : '',
    syncedAt: typeof v.syncedAt === 'number' ? v.syncedAt : 0,
    ...(typeof v.diedAt === 'number' ? {diedAt: v.diedAt} : {}),
  }
}

let parsedRaw: string | undefined
let parsed: CachedLists = EMPTY

/** Every cached list, by registering DID. Stable between changes. */
export function getLists(): CachedLists {
  const raw = readDevice(LISTS_KEY)
  if (raw === parsedRaw) return parsed
  parsedRaw = raw
  parsed = EMPTY
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === 'object') {
        const out: Record<string, CachedList> = {}
        for (const [did, list] of Object.entries(value)) {
          const read = parseList(list)
          if (read && did.startsWith('did:')) out[did] = read
        }
        parsed = Object.freeze(out)
      }
    } catch {
      // A damaged value reads as no lists.
    }
  }
  return parsed
}

/** `registrar`'s cached list, or `undefined` (none on this device). */
export function getList(registrar: string): CachedList | undefined {
  return getLists()[registrar]
}

function writeLists(next: Record<string, CachedList>) {
  const raw = Object.keys(next).length ? JSON.stringify(next) : undefined
  if (raw === readDevice(LISTS_KEY)) return
  // The device store tells this tab's subscribers (and other tabs').
  writeDevice(LISTS_KEY, raw)
}

function update(fn: (lists: Record<string, CachedList>) => boolean) {
  const next = {...getLists()}
  if (fn(next)) writeLists(next)
}

/**
 * Compare two `rev`s: prism's `rev` is monotonic per list (SAR2-N3). Two
 * decimal integers compare as numbers, anything else as strings (a TID-like
 * rev sorts by its characters). An empty rev is older than any other.
 */
export function compareRev(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return -1
  if (!b) return 1
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    return a.length === b.length ? (a < b ? -1 : 1) : a.length - b.length
  }
  return a < b ? -1 : 1
}

/** prism's answer for one list. */
export type ListAnswer = {
  accounts: readonly {did: string; addedAt: string}[]
  rev: string
}

/**
 * Apply prism's answer for `registrar` (5.5). Ignored when its `rev` is
 * lower than the cache's. Display fields are kept for DIDs still listed.
 * Returns whether it applied and the DIDs it dropped.
 */
export function applyListAnswer(
  registrar: string,
  answer: ListAnswer,
  now: number = Date.now(),
): {applied: boolean; dropped: string[]} {
  const cached = getList(registrar)
  if (cached && compareRev(answer.rev, cached.rev) < 0) {
    return {applied: false, dropped: []}
  }
  const known = new Map(cached?.accounts.map(a => [a.did, a]) ?? [])
  const accounts: ListAccount[] = []
  const seen = new Set<string>()
  for (const item of answer.accounts) {
    if (seen.has(item.did)) continue
    seen.add(item.did)
    const before = known.get(item.did)
    accounts.push({...(before ?? {did: item.did}), addedAt: item.addedAt})
  }
  const dropped = (cached?.accounts ?? [])
    .map(a => a.did)
    .filter(did => !seen.has(did))
  update(lists => {
    lists[registrar] = {
      accounts,
      rev: answer.rev,
      syncedAt: now,
      ...(cached?.diedAt !== undefined ? {diedAt: cached.diedAt} : {}),
    }
    return true
  })
  return {applied: true, dropped}
}

/**
 * Put `account` on `registrar`'s list after a confirmed add, at `rev` (the
 * add's own answer counts as a read at that rev, 5.3).
 */
export function addToList(
  registrar: string,
  account: ListAccount,
  rev: string,
) {
  update(lists => {
    const cached = lists[registrar]
    const accounts = (cached?.accounts ?? []).filter(a => a.did !== account.did)
    const before = cached?.accounts.find(a => a.did === account.did)
    accounts.push({...before, ...account})
    const newer = !cached || compareRev(rev, cached.rev) > 0
    lists[registrar] = {
      accounts,
      rev: newer ? rev : cached.rev,
      syncedAt: cached?.syncedAt ?? 0,
      ...(cached?.diedAt !== undefined ? {diedAt: cached.diedAt} : {}),
    }
    return true
  })
}

/** Take `did` off `registrar`'s list after a confirmed remove, at `rev`. */
export function removeFromList(registrar: string, did: string, rev: string) {
  update(lists => {
    const cached = lists[registrar]
    if (!cached) return false
    lists[registrar] = {
      ...cached,
      accounts: cached.accounts.filter(a => a.did !== did),
      rev: compareRev(rev, cached.rev) > 0 ? rev : cached.rev,
    }
    return true
  })
}

/** Delete the lists of `dids` (SA-21: their accounts signed out here). */
export function deleteLists(dids: readonly string[]) {
  update(lists => {
    let changed = false
    for (const did of dids) {
      if (lists[did]) {
        delete lists[did]
        changed = true
      }
    }
    return changed
  })
}

/** Set `diedAt` on `registrar`'s list, if it has one (6.4). */
export function markListDied(registrar: string, at: number = Date.now()) {
  update(lists => {
    const cached = lists[registrar]
    if (!cached || cached.diedAt !== undefined) return false
    lists[registrar] = {...cached, diedAt: at}
    return true
  })
}

/** Clear `diedAt` on `registrar`'s list: it signed in again. */
export function clearListDied(registrar: string) {
  update(lists => {
    const cached = lists[registrar]
    if (cached?.diedAt === undefined) return false
    const {diedAt: _diedAt, ...rest} = cached
    lists[registrar] = rest
    return true
  })
}

/**
 * Whether a cached list holds its accounts' sessions (6.5): it has no
 * `diedAt`, or one from this page load.
 */
export function listHolds(
  list: CachedList,
  startedAt: number = getLoadStartedAt(),
): boolean {
  return list.diedAt === undefined || list.diedAt >= startedAt
}

/**
 * Fill in display fields for `did` on every list that has it (SA-19: from
 * the add itself, the DID document, or the account's own client).
 */
export function setDisplayFields(
  did: string,
  fields: {handle?: string; displayName?: string; avatar?: string},
) {
  update(lists => {
    let changed = false
    for (const [registrar, list] of Object.entries(lists)) {
      const index = list.accounts.findIndex(a => a.did === did)
      if (index < 0) continue
      const before = list.accounts[index]
      const after: ListAccount = {...before}
      for (const key of ['handle', 'displayName', 'avatar'] as const) {
        const value = fields[key]
        if (value !== undefined && value !== '') after[key] = value
      }
      if (JSON.stringify(after) === JSON.stringify(before)) continue
      const accounts = [...list.accounts]
      accounts[index] = after
      lists[registrar] = {...list, accounts}
      changed = true
    }
    return changed
  })
}

/* The in-memory overlays (4.3 step 7, 4.5). */

const hidden = new Map<string, Set<string>>()
const adding = new Map<string, ListAccount[]>()
let overlayVersion = 0

/** Hide `did`'s row on `registrar`'s list while its remove runs. */
export function hideRow(registrar: string, did: string) {
  const set = hidden.get(registrar) ?? new Set()
  set.add(did)
  hidden.set(registrar, set)
  overlayChanged()
}

/** Show `did`'s row again (the remove settled either way). */
export function unhideRow(registrar: string, did: string) {
  const set = hidden.get(registrar)
  if (!set?.delete(did)) return
  if (!set.size) hidden.delete(registrar)
  overlayChanged()
}

/** Whether `did`'s row on `registrar`'s list is hidden by a remove. */
export function isRowHidden(registrar: string, did: string): boolean {
  return hidden.get(registrar)?.has(did) ?? false
}

/** Show `account` as "Adding..." on `registrar`'s list. */
export function showAdding(registrar: string, account: ListAccount) {
  const rows = (adding.get(registrar) ?? []).filter(a => a.did !== account.did)
  adding.set(registrar, [...rows, account])
  overlayChanged()
}

/** Stop showing `did` as "Adding...". */
export function clearAdding(registrar: string, did: string) {
  const rows = adding.get(registrar)
  if (!rows?.some(a => a.did === did)) return
  const next = rows.filter(a => a.did !== did)
  if (next.length) adding.set(registrar, next)
  else adding.delete(registrar)
  overlayChanged()
}

/** The rows shown as "Adding..." on `registrar`'s list. */
export function addingRows(registrar: string): readonly ListAccount[] {
  return adding.get(registrar) ?? []
}

/* Subscriptions. */

const listeners = new Set<() => void>()
let watching: (() => void) | undefined

function notify() {
  listeners.forEach(listener => listener())
}

function overlayChanged() {
  overlayVersion++
  notify()
}

/** A number that changes with every overlay change. */
export function getOverlayVersion(): number {
  return overlayVersion
}

/**
 * Call `listener` on any change: a write in this tab or another one, or an
 * overlay change. Returns the unsubscribe function.
 */
export function subscribeLists(listener: () => void): () => void {
  listeners.add(listener)
  if (!watching) watching = subscribeDevice(LISTS_KEY, notify)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && watching) {
      watching()
      watching = undefined
    }
  }
}

/** {@link getLists}, kept current. */
export function useCachedLists(): CachedLists {
  return useSyncExternalStore(subscribeLists, getLists)
}

/** Test-only: forget the overlays and the parse cache. */
export function resetListStoreForTests() {
  hidden.clear()
  adding.clear()
  overlayVersion = 0
  parsedRaw = undefined
  parsed = EMPTY
}
