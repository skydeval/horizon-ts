/*
 * What the section, Posting as and Act as read (system accounts design 4.2,
 * 8.1): the current account's listed accounts, each with its state on this
 * device, from the device stores (synchronously, no felt lag), and the
 * staggered handle lookups for rows the cache has no handle for (SA-19).
 */

import {useEffect, useSyncExternalStore} from 'react'

import {isJwtExpired} from '#/lib/jwt'
import {type SessionAccount} from '#/state/session/types'
import {canAccountAct} from '#/horizon/session/accounts'
import {SYSTEM_ACCOUNTS} from '#/horizon/switches'
import {handleForDid} from './identity'
import {
  addingRows,
  getLists,
  getOverlayVersion,
  isRowHidden,
  type ListAccount,
  setDisplayFields,
  subscribeLists,
} from './list-store'
import {getEntries, subscribeEntries, type SystemEntry} from './session-store'

/** A listed account's state on this device (4.2). */
export type RowState = 'ready' | 'signIn' | 'signInAgain' | 'adding'

export type SystemAccountRow = ListAccount & {state: RowState}

/**
 * The state of `did` on this device: "Ready", "Sign in on this device" (no
 * session here), "Sign in again" (it ended). A `switcher` entry is ready
 * while that switcher account can act.
 */
export function rowState(
  entry: SystemEntry | undefined,
  switcher: readonly SessionAccount[],
): RowState {
  if (!entry || entry.kind === undefined) return 'signIn'
  if (entry.needsSignIn) return 'signInAgain'
  if (entry.kind === 'switcher') {
    const account = switcher.find(a => a.did === entry.did)
    return account && canAccountAct(account) ? 'ready' : 'signInAgain'
  }
  if (entry.kind === 'password') {
    return entry.refreshJwt && !isJwtExpired(entry.refreshJwt)
      ? 'ready'
      : 'signInAgain'
  }
  return 'ready'
}

/**
 * `registrar`'s rows, in the order added: the cached list without the rows a
 * remove is hiding, then the rows being added. Pure.
 */
export function rowsFor(
  registrar: string | undefined,
  switcher: readonly SessionAccount[],
): SystemAccountRow[] {
  if (!registrar) return []
  const list = getLists()[registrar]
  const entries = getEntries()
  const rows: SystemAccountRow[] = (list?.accounts ?? [])
    .filter(account => !isRowHidden(registrar, account.did))
    .map(account => ({
      ...account,
      state: rowState(entries[account.did], switcher),
    }))
  for (const account of addingRows(registrar)) {
    if (rows.some(row => row.did === account.did)) continue
    rows.push({...account, state: 'adding'})
  }
  return rows
}

function subscribeAll(listener: () => void) {
  const a = subscribeLists(listener)
  const b = subscribeEntries(listener)
  return () => {
    a()
    b()
  }
}

function snapshotKey(registrar: string | undefined): string {
  if (!registrar) return ''
  return [
    JSON.stringify(getLists()[registrar] ?? null),
    JSON.stringify(getEntries()),
    getOverlayVersion(),
  ].join('|')
}

/**
 * The current account's rows, kept current. `switcher` is the stock
 * session's accounts (a `switcher` entry's state reads them).
 */
export function useSystemAccountRows(
  registrar: string | undefined,
  switcher: readonly SessionAccount[],
): SystemAccountRow[] {
  // Rows are read from mutable stores; memoising them would keep stale rows.
  'use no memo'
  const key = useSyncExternalStore(subscribeAll, () => snapshotKey(registrar))
  void key
  if (!SYSTEM_ACCOUNTS) return []
  return rowsFor(registrar, switcher)
}

/* Staggered handle lookups (4.2, SAR2-N8): one DID at a time, a gap between. */

/** The gap between two handle lookups. */
export const HANDLE_LOOKUP_GAP_MS = 1_500

const queued: string[] = []
const tried = new Set<string>()
let running = false

async function drain() {
  if (running) return
  running = true
  try {
    while (queued.length) {
      const did = queued.shift()!
      const handle = await handleForDid(did)
      if (handle) setDisplayFields(did, {handle})
      if (queued.length) {
        await new Promise(resolve => setTimeout(resolve, HANDLE_LOOKUP_GAP_MS))
      }
    }
  } finally {
    running = false
  }
}

/** Look up the handles of `dids` (each once per page load), one at a time. */
export function queueHandleLookups(dids: readonly string[]) {
  for (const did of dids) {
    if (tried.has(did)) continue
    tried.add(did)
    queued.push(did)
  }
  void drain()
}

/** Queue lookups for the rows the cache has no handle for. */
export function useRowHandles(rows: readonly SystemAccountRow[]) {
  const missing = rows
    .filter(row => !row.handle && row.state !== 'adding')
    .map(row => row.did)
  const key = missing.join(' ')
  useEffect(() => {
    if (key) queueHandleLookups(key.split(' '))
  }, [key])
}

/** Test-only: forget the lookup queue. */
export function resetHandleLookupsForTests() {
  queued.length = 0
  tried.clear()
  running = false
}
