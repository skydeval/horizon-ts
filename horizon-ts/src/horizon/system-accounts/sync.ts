/*
 * Reading a list from prism in the background (system accounts design 5.5,
 * 5.3): on app open, composer open and tab open when the cache is over 5
 * minutes old, and always after a write. The answer is applied unless its
 * `rev` is older than the cache's; then the sweep runs, a registration whose
 * add the answer confirms leaves its grace, and accounts the answer dropped
 * are reported (a composer posting as one goes back to the current account).
 */

import {useSyncExternalStore} from 'react'
import {type Client} from '@atproto/lex'

import {logger} from '#/logger'
import {servesFeature} from '#/horizon/routing/features'
import {SYSTEM_ACCOUNTS} from '#/horizon/switches'
import {applyListAnswer, getList, LIST_STALE_MS} from './list-store'
import {
  systemAccountsApi,
  SystemAccountsError,
  systemAccountsStubActive,
} from './prism'
import {getEntries, putEntry} from './session-store'
import {runSweep} from './sweep'

/** How the last read of a list went, for the section. */
export type ListLoadState = 'idle' | 'loading' | 'error' | 'unavailable'

const states = new Map<string, ListLoadState>()
const inFlight = new Map<string, Promise<boolean>>()
const listeners = new Set<() => void>()

function setState(registrar: string, state: ListLoadState) {
  if (states.get(registrar) === state) return
  states.set(registrar, state)
  listeners.forEach(listener => listener())
}

/** The last read's state for `registrar`'s list. */
export function getListLoadState(registrar: string | undefined): ListLoadState {
  return (registrar && states.get(registrar)) || 'idle'
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** {@link getListLoadState}, kept current. */
export function useListLoadState(registrar: string | undefined) {
  return useSyncExternalStore(subscribe, () => getListLoadState(registrar))
}

type DroppedListener = (registrar: string, dids: readonly string[]) => void
const droppedListeners = new Set<DroppedListener>()

/**
 * Called when a read drops accounts from a list (another device removed
 * them, or they left). Returns the unsubscribe function.
 */
export function onAccountsDropped(listener: DroppedListener) {
  droppedListeners.add(listener)
  return () => {
    droppedListeners.delete(listener)
  }
}

/** Report accounts gone from `registrar`'s list (a read, or a remove). */
export function reportDropped(registrar: string, dids: readonly string[]) {
  if (!dids.length) return
  droppedListeners.forEach(listener => listener(registrar, dids))
}

/** Whether prism serves the system-account methods for `did` (10). */
export function systemAccountsServed(did: string | undefined): boolean {
  if (!SYSTEM_ACCOUNTS || !did) return false
  return (
    systemAccountsStubActive() || servesFeature('account.systemAccounts', did)
  )
}

/**
 * A registration whose add a list read (at a `rev` at least the add's)
 * confirms leaves its grace (5.3): `addingSince` and `addingFor` cleared.
 */
function confirmAdds(registrar: string) {
  const listed = new Set(getList(registrar)?.accounts.map(a => a.did) ?? [])
  for (const entry of Object.values(getEntries())) {
    if (entry.addingFor !== registrar || !listed.has(entry.did)) continue
    if (entry.kind === undefined || entry.pendingUntil !== undefined) continue
    putEntry({...entry, addingSince: undefined, addingFor: undefined})
  }
}

/**
 * Read `registrar`'s list as `pdsClient` (its own client) and apply it.
 * Skipped while the cache is fresh, unless `force`. Resolves to whether a
 * read succeeded (or was not needed); never rejects.
 */
export function readList(
  registrar: string,
  pdsClient: Client,
  {force = false}: {force?: boolean} = {},
): Promise<boolean> {
  if (!SYSTEM_ACCOUNTS) return Promise.resolve(false)
  if (!systemAccountsServed(registrar)) {
    setState(registrar, 'unavailable')
    return Promise.resolve(false)
  }
  const cached = getList(registrar)
  if (!force && cached && Date.now() - cached.syncedAt < LIST_STALE_MS) {
    return Promise.resolve(true)
  }
  const running = inFlight.get(registrar)
  if (running && !force) return running
  setState(registrar, 'loading')
  const read = systemAccountsApi()
    .getSystemAccounts(pdsClient)
    .then(answer => {
      const {applied, dropped} = applyListAnswer(registrar, answer)
      setState(registrar, 'idle')
      if (applied) {
        confirmAdds(registrar)
        void runSweep()
        reportDropped(registrar, dropped)
      }
      return true
    })
    .catch(error => {
      logger.info('system accounts: the list could not be read', {
        safeMessage: error,
      })
      // prism's 501 MethodNotImplemented: the feature is off there.
      const off =
        error instanceof SystemAccountsError && error.reason === 'unavailable'
      setState(registrar, off ? 'unavailable' : 'error')
      return false
    })
    .finally(() => {
      if (inFlight.get(registrar) === read) inFlight.delete(registrar)
    })
  inFlight.set(registrar, read)
  return read
}

/** Test-only: forget the load states and reads in flight. */
export function resetSyncForTests() {
  states.clear()
  inFlight.clear()
  droppedListeners.clear()
}
