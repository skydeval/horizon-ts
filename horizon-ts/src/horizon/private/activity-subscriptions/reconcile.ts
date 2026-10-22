/*
 * The reconcile (activity subscriptions design 2.3, AS-3): copies Bluesky's
 * list of the member's bells into prism, so bells set in other clients
 * notify for private posts too (D-2). Hourly, compare-and-set on prism's
 * clock.
 *
 * 1. Level dirty subjects first; a subject still dirty, in the store or in
 *    this tab's saver, belongs to the mirror and is skipped.
 * 2. Read prism's list (100 a page, at most 30 pages); the first page's
 *    `asOf` is T0.
 * 3. Read Bluesky's list (100 a page, at most 30 pages).
 * 4. The cut-off is C = T0 - G: a row prism changed after C is never
 *    written; one stamped exactly at C may be.
 * 5. Each Bluesky subject whose flags prism lacks or differs on is put with
 *    `ifNotChangedSince: C`.
 * 6. Removals only with `ACTIVITY_SUBSCRIPTION_REMOVALS` (off: no removal
 *    candidates and no profile reads).
 * 7. Each put re-checks the dirty set and the saver first.
 * 8. Writes two at a time. `Conflict` is answered; a 429, 5xx or network
 *    error stops the run; `LimitReached` is logged, stops turn-ons and
 *    leaves the run incomplete; `NotEnrolled` clears `reconciled:<did>`.
 * 9. `reconciled:<did>` is written only after a complete run.
 */

import {XrpcResponseError} from '@atproto/lex'

import {logger} from '#/logger'
import {
  classifyPrismError,
  failureName,
  listBlueskySubscriptions,
  listPrismSubscriptions,
  type PrismRow,
  putPrismSubscription,
  readBlueskyBell,
} from '#/horizon/private/activity-subscriptions/api'
import {
  type Flags,
  GRACE_MS,
  isOn,
  OFF,
  RECONCILE_INTERVAL_MS,
  sameFlags,
} from '#/horizon/private/activity-subscriptions/common'
import {
  type DirtyStore,
  type Mirror,
  type MirrorClients,
} from '#/horizon/private/activity-subscriptions/mirror'

/** Subscriptions per list request. */
export const RECONCILE_PAGE_SIZE = 100

/** Pages read of each list at most (3000 subscriptions). */
export const RECONCILE_MAX_PAGES = 30

/** Removal candidates read at most per run. */
export const RECONCILE_MAX_PROFILE_READS = 50

/** Writes and profile reads in flight at once. */
export const RECONCILE_CONCURRENCY = 2

export type ReconcileDeps = {
  store: DirtyStore
  mirror: Mirror
  /** Wall-clock time, for `reconciled:<did>`. */
  wallNow: () => number
  /** `ACTIVITY_SUBSCRIPTION_REMOVALS`. */
  removals: () => boolean
  /** A failed prism call, for membership (`reportPrismError`). */
  reportError: (did: string, error: unknown) => void
  onNotEnrolled: (did: string) => void
}

/** How a run ended. */
export type ReconcileResult = {
  complete: boolean
  /** Puts sent (turn-ons, flag changes and removals). */
  written: number
  stopped?: 'prism-read' | 'transient' | 'not-enrolled' | 'busy'
}

/** Whether `did`'s reconcile is due: no record, or one over an hour old. */
export function isReconcileDue(
  store: DirtyStore,
  did: string,
  wallNow: number,
): boolean {
  const at = store.readReconciled(did)
  return at === undefined || wallNow - at >= RECONCILE_INTERVAL_MS
}

/** Run `work` over `items`, `limit` at a time; stops early when it says so. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<'continue' | 'stop'>,
): Promise<void> {
  let index = 0
  let stopped = false
  const lanes = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (!stopped && index < items.length) {
      const item = items[index++]
      if ((await work(item)) === 'stop') stopped = true
    }
  })
  await Promise.all(lanes)
}

export function createReconcile(deps: ReconcileDeps) {
  const locks = new Set<string>()

  async function readPrism(clients: MirrorClients) {
    const rows = new Map<string, PrismRow>()
    let asOf: string | undefined
    let cursor: string | undefined
    let complete = false
    for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
      const res = await listPrismSubscriptions(clients.prismClient, {
        limit: RECONCILE_PAGE_SIZE,
        cursor,
      })
      asOf ??= res.asOf
      for (const row of res.rows) rows.set(row.subject, row)
      if (!res.cursor || res.cursor === cursor) {
        complete = true
        break
      }
      cursor = res.cursor
    }
    return {rows, asOf: asOf as string, complete}
  }

  async function readBluesky(clients: MirrorClients) {
    const subjects = new Map<string, Flags>()
    let cursor: string | undefined
    let complete = false
    try {
      for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
        const res = await listBlueskySubscriptions(clients.appviewClient, {
          limit: RECONCILE_PAGE_SIZE,
          cursor,
        })
        for (const item of res.subscriptions) {
          if (isOn(item.flags)) subjects.set(item.subject, item.flags)
        }
        if (!res.cursor || res.cursor === cursor) {
          complete = true
          break
        }
        cursor = res.cursor
      }
    } catch (error) {
      logger.warn('activity subscriptions: Bluesky list read failed', {
        name: failureName(error),
      })
    }
    return {subjects, complete}
  }

  /**
   * Whether a removal candidate's profile shows the bell off with no block
   * either way. A failed read means no removal.
   */
  async function readsOff(clients: MirrorClients, subject: string) {
    try {
      const bell = await readBlueskyBell(clients.appviewClient, subject)
      return !bell.blocked && !isOn(bell.flags)
    } catch {
      return undefined
    }
  }

  async function runLocked(clients: MirrorClients): Promise<ReconcileResult> {
    const {did} = clients
    // 1. Dirty subjects belong to the mirror.
    await deps.mirror.levelAll(did)

    // 2. prism's list; T0 from its first page.
    let prism
    try {
      prism = await readPrism(clients)
    } catch (error) {
      deps.reportError(did, error)
      if (classifyPrismError(error) === 'not-enrolled') {
        deps.onNotEnrolled(did)
        return {complete: false, written: 0, stopped: 'not-enrolled'}
      }
      logger.warn('activity subscriptions: prism list read failed', {
        name: failureName(error),
      })
      return {complete: false, written: 0, stopped: 'prism-read'}
    }

    // 3. Bluesky's list.
    const bluesky = await readBluesky(clients)

    // 4. The cut-off, on prism's clock.
    const cutoffMs = Date.parse(prism.asOf) - GRACE_MS
    const cutoff = new Date(cutoffMs).toISOString()
    const changedAfterCutoff = (subject: string) => {
      const row = prism.rows.get(subject)
      return !!row && Date.parse(row.updatedAt) > cutoffMs
    }

    let complete = prism.complete && bluesky.complete

    // 5. Turn-ons and flag changes.
    const puts: {subject: string; flags: Flags; removal: boolean}[] = []
    for (const [subject, flags] of bluesky.subjects) {
      if (deps.mirror.isBusy(did, subject)) continue
      const row = prism.rows.get(subject)
      if (row && sameFlags(row.flags, flags)) continue
      puts.push({subject, flags, removal: false})
    }

    // 6. Removals, only with the switch on and a complete Bluesky read.
    if (deps.removals()) {
      const candidates = Array.from(prism.rows.keys()).filter(
        subject =>
          !bluesky.subjects.has(subject) && !deps.mirror.isBusy(did, subject),
      )
      if (!bluesky.complete) {
        // Nothing is removed after a failed or capped read.
      } else {
        if (candidates.length > RECONCILE_MAX_PROFILE_READS) complete = false
        const read = candidates.slice(0, RECONCILE_MAX_PROFILE_READS)
        await eachLimited(read, RECONCILE_CONCURRENCY, async subject => {
          const off = await readsOff(clients, subject)
          if (off === undefined) complete = false
          else if (off) puts.push({subject, flags: OFF, removal: true})
          return 'continue'
        })
      }
    }

    // 7, 8. The writes.
    let written = 0
    let stopped: ReconcileResult['stopped']
    let limitReached = false
    await eachLimited(puts, RECONCILE_CONCURRENCY, async item => {
      if (limitReached && !item.removal) return 'continue'
      // A row changed after C is skipped with no request.
      if (changedAfterCutoff(item.subject)) return 'continue'
      if (deps.mirror.isBusy(did, item.subject)) return 'continue'
      try {
        written++
        await putPrismSubscription(
          clients.prismClient,
          item.subject,
          item.flags,
          cutoff,
        )
        return 'continue'
      } catch (error) {
        deps.reportError(did, error)
        const kind = classifyPrismError(error)
        if (kind === 'conflict') return 'continue'
        if (kind === 'limit') {
          logger.warn('activity subscriptions: prism cap reached', {
            held: prism.rows.size,
          })
          limitReached = true
          complete = false
          return 'continue'
        }
        if (kind === 'not-enrolled') {
          deps.onNotEnrolled(did)
          stopped = 'not-enrolled'
          complete = false
          return 'stop'
        }
        if (kind === 'invalid') {
          logger.warn('activity subscriptions: reconcile put refused', {
            name: failureName(error),
          })
          complete = false
          return 'continue'
        }
        // A 429, 5xx or network error: the next run starts over.
        logger.warn('activity subscriptions: reconcile put failed', {
          name: failureName(error),
          status: error instanceof XrpcResponseError ? error.status : undefined,
        })
        stopped = 'transient'
        complete = false
        return 'stop'
      }
    })

    // 9. The record, only after a complete run.
    if (complete && !stopped) deps.store.writeReconciled(did, deps.wallNow())
    return {complete: complete && !stopped, written, stopped}
  }

  return {
    /**
     * One run for the current account's clients. Never two at once per
     * account in this tab.
     */
    async run(clients: MirrorClients): Promise<ReconcileResult> {
      if (locks.has(clients.did)) {
        return {complete: false, written: 0, stopped: 'busy'}
      }
      locks.add(clients.did)
      try {
        return await runLocked(clients)
      } finally {
        locks.delete(clients.did)
      }
    },

    isDue(did: string): boolean {
      return isReconcileDue(deps.store, did, deps.wallNow())
    },
  }
}
