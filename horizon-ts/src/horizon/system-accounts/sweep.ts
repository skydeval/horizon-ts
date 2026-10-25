/*
 * The sweep (system accounts design 6.5, SA-8): the one rule that decides
 * when a system account's device session is revoked. For each system entry
 * B, from one snapshot of the entries, the cached lists and the switcher
 * accounts:
 *
 * - `holders(B)`: the switcher accounts here whose cached list has B and
 *   holds (no `diedAt`, or one from this page load; SAR3-L5). A signed-out
 *   account has no list (the sign-out seam deletes it first, SA-21).
 * - pending: B's `pendingUntil` is in the future and its `addingFor` is a
 *   usable switcher account (SA-26).
 * - the grace: B's `addingSince` is under 2 minutes old and its `addingFor`
 *   is a usable switcher account (SAR2-L3).
 * - Keep B while it has holders, is pending or is in its grace.
 * - B a usable switcher account: its entry becomes (or stays) `switcher`,
 *   keeping any `needsSignIn`; with nothing keeping it, only the entry goes.
 *   A switcher session is never revoked.
 * - Otherwise: B is revoked and its entry deleted.
 *
 * The plan is computed once from the snapshot, then the revocations start
 * together, so order cannot change the result. Timers run the sweep again
 * when a grace or pending time ends, in every tab, from the stored entries.
 */

import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {type SessionAccount} from '#/state/session/types'
import {canAccountAct} from '#/horizon/session/accounts'
import {endPasswordSession, revokeOAuthGrant} from '#/horizon/session/revoke'
import {
  type CachedLists,
  getLists,
  getLoadStartedAt,
  listHolds,
} from './list-store'
import {
  deleteEntries,
  entrySessionAccount,
  getEntries,
  getEntry,
  putEntry,
  type SystemEntries,
  type SystemEntry,
} from './session-store'

/** How long a registration's result keeps its session without a holder. */
export const GRACE_MS = 2 * 60_000

/**
 * A registration's popup may return for the library's 5 minutes; one more
 * minute of slack (4.3 step 4).
 */
export const PENDING_MS = 6 * 60_000

export type SweepSnapshot = {
  entries: SystemEntries
  lists: CachedLists
  accounts: readonly SessionAccount[]
  now: number
  loadStartedAt: number
}

export type SweepPlan = {
  /** Entries to rewrite (the `switcher` conversion, a loss mark). */
  rewrite: SystemEntry[]
  /** Entries to delete without revoking (usable switcher accounts). */
  drop: string[]
  /** Entries to revoke and delete. */
  revoke: SystemEntry[]
  /**
   * Password sessions whose entry became `switcher`: their own server
   * session is ended; the entry stays.
   */
  retire: SystemEntry[]
  /** `switcher` entries for listed DIDs that are usable switcher accounts. */
  create: SystemEntry[]
}

/**
 * Whether `did` is a usable switcher account in `accounts`: it can act, and
 * Horizon did not see it die since it last signed in (vocabulary).
 */
export function isUsableSwitcher(
  did: string | undefined,
  accounts: readonly SessionAccount[],
  lists: CachedLists,
): boolean {
  if (!did) return false
  const account = accounts.find(a => a.did === did)
  if (!account || !canAccountAct(account)) return false
  return lists[did]?.diedAt === undefined
}

/** The switcher accounts whose cached list holds `did` (6.5). */
export function holdersOf(
  did: string,
  accounts: readonly SessionAccount[],
  lists: CachedLists,
  loadStartedAt: number,
): string[] {
  return accounts
    .map(account => account.did)
    .filter(registrar => {
      const list = lists[registrar]
      return (
        !!list &&
        listHolds(list, loadStartedAt) &&
        list.accounts.some(a => a.did === did)
      )
    })
}

function isPending(entry: SystemEntry, s: SweepSnapshot): boolean {
  return (
    entry.pendingUntil !== undefined &&
    entry.pendingUntil > s.now &&
    isUsableSwitcher(entry.addingFor, s.accounts, s.lists)
  )
}

function inGrace(entry: SystemEntry, s: SweepSnapshot): boolean {
  return (
    entry.addingSince !== undefined &&
    s.now - entry.addingSince < GRACE_MS &&
    isUsableSwitcher(entry.addingFor, s.accounts, s.lists)
  )
}

/** The sweep's plan for one snapshot. Pure. */
export function planSweep(s: SweepSnapshot): SweepPlan {
  const plan: SweepPlan = {
    rewrite: [],
    drop: [],
    revoke: [],
    retire: [],
    create: [],
  }
  for (const entry of Object.values(s.entries)) {
    const keep =
      holdersOf(entry.did, s.accounts, s.lists, s.loadStartedAt).length > 0 ||
      isPending(entry, s) ||
      inGrace(entry, s)
    if (isUsableSwitcher(entry.did, s.accounts, s.lists)) {
      if (entry.kind === 'password') plan.retire.push(entry)
      if (!keep) {
        plan.drop.push(entry.did)
      } else if (entry.kind !== 'switcher') {
        // SAR2-N14: deterministic; any `needsSignIn` is kept (SAR3-N7).
        plan.rewrite.push({
          ...entry,
          kind: 'switcher',
          accessJwt: undefined,
          refreshJwt: undefined,
        })
      }
      continue
    }
    if (!keep) {
      plan.revoke.push(entry)
      continue
    }
    if (entry.kind === 'switcher' && !entry.needsSignIn) {
      // Its switcher session is gone (signed out or removed): "Sign in again".
      plan.rewrite.push({...entry, needsSignIn: true})
    }
  }
  // SAR1-N7: a listed DID that is a usable switcher account is "Ready" at once.
  const seen = new Set<string>()
  for (const account of s.accounts) {
    const list = s.lists[account.did]
    if (!list || !listHolds(list, s.loadStartedAt)) continue
    for (const listed of list.accounts) {
      if (s.entries[listed.did] || seen.has(listed.did)) continue
      if (!isUsableSwitcher(listed.did, s.accounts, s.lists)) continue
      seen.add(listed.did)
      const switcher = s.accounts.find(a => a.did === listed.did)
      plan.create.push({
        did: listed.did,
        handle: switcher?.handle ?? listed.handle,
        kind: 'switcher',
      })
    }
  }
  return plan
}

let accountsSource: () => readonly SessionAccount[] = () =>
  persisted.get('session').accounts

/**
 * Where the sweep reads the switcher accounts: the session provider's store
 * while it is mounted (`runtime.ts`), else the persisted copy.
 */
export function setSwitcherAccountsSource(
  source: (() => readonly SessionAccount[]) | undefined,
) {
  accountsSource = source ?? (() => persisted.get('session').accounts)
}

/** The switcher accounts as the sweep reads them now. */
export function getSwitcherAccounts(): readonly SessionAccount[] {
  return accountsSource()
}

/** The snapshot of now, with `accounts` in place of the switcher's when given. */
export function takeSnapshot(
  accounts: readonly SessionAccount[] = getSwitcherAccounts(),
): SweepSnapshot {
  return {
    entries: getEntries(),
    lists: getLists(),
    accounts,
    now: Date.now(),
    loadStartedAt: getLoadStartedAt(),
  }
}

/**
 * End one entry's session (6.5): OAuth through the library's `revoke`
 * (a provisional or `switcher` entry too, since a popup may have stored a
 * session for it), a password session's tokens forgotten at once and ended
 * on the server, best effort. Never throws.
 */
export async function revokeEntry(entry: SystemEntry): Promise<void> {
  if (entry.kind === 'password') {
    const account = entrySessionAccount(entry)
    if (account) await endPasswordSession(account)
    return
  }
  await revokeOAuthGrant(entry.did)
}

/**
 * Apply a plan: rewrite and delete the entries at once, then start every
 * revocation together. Resolves when they settle; never rejects.
 */
export function applySweep(plan: SweepPlan): Promise<void> {
  for (const entry of plan.rewrite) {
    // An entry deleted meanwhile is left to the next sweep.
    if (getEntry(entry.did)) putEntry(entry)
  }
  for (const entry of plan.create) {
    if (!getEntry(entry.did)) putEntry(entry)
  }
  const gone = [...plan.drop, ...plan.revoke.map(entry => entry.did)]
  if (gone.length) deleteEntries(gone)
  const ends: Promise<void>[] = [
    ...plan.revoke.map(revokeEntry),
    // A password entry turned into `switcher` leaves its own server session.
    ...plan.retire.map(revokeEntry),
  ]
  return Promise.all(ends).then(
    () => undefined,
    error => {
      logger.warn('system accounts: a revocation failed', {safeMessage: error})
    },
  )
}

/**
 * Run the sweep now. `accounts` replaces the switcher accounts for this run
 * (the sign-out seam passes the accounts after its dispatch). Schedules the
 * next grace or pending timer. Resolves when the revocations settle.
 */
export function runSweep(accounts?: readonly SessionAccount[]): Promise<void> {
  const snapshot = takeSnapshot(accounts)
  const done = applySweep(planSweep(snapshot))
  scheduleSweepTimer()
  return done
}

let timer: ReturnType<typeof setTimeout> | undefined
let timerAt: number | undefined

/**
 * Set one timer at the earliest grace or pending end among the stored
 * entries, so the grace ends on time with no other event (SAR2-L3), in
 * every tab.
 */
export function scheduleSweepTimer(now: number = Date.now()) {
  let next = Number.POSITIVE_INFINITY
  for (const entry of Object.values(getEntries())) {
    if (entry.pendingUntil !== undefined && entry.pendingUntil > now) {
      next = Math.min(next, entry.pendingUntil)
    }
    if (entry.addingSince !== undefined) {
      const end = entry.addingSince + GRACE_MS
      if (end > now) next = Math.min(next, end)
    }
  }
  if (next === Number.POSITIVE_INFINITY) {
    if (timer) clearTimeout(timer)
    timer = undefined
    timerAt = undefined
    return
  }
  if (timer && timerAt === next) return
  if (timer) clearTimeout(timer)
  timerAt = next
  timer = setTimeout(
    () => {
      timer = undefined
      timerAt = undefined
      void runSweep()
    },
    Math.max(0, next - now) + 1,
  )
}

/** Test-only: stop the timer. */
export function resetSweepForTests() {
  if (timer) clearTimeout(timer)
  timer = undefined
  timerAt = undefined
  setSwitcherAccountsSource(undefined)
}
