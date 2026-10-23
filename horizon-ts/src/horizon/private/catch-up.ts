/*
 * The catch-up (prism busy design 2.4). When the account turns healthy
 * (`degraded` expiring included), one catch-up runs after 0 to 2 s of
 * jitter, once per episode, no sooner than `CATCHUP_MIN_MS` after the last
 * (30 s, doubling to 10 min while episodes recur). It never refetches an
 * infinite query in place:
 *
 * - active non-infinite private queries in error, and held ones (a thread,
 *   post 1, the reply anchor label), refetch with `cancelRefetch: false`; one
 *   with no data between retries is restarted (`restartPrivateQuery`), since
 *   a refetch would wait out its sleep;
 * - every other private query, infinite or inactive, is marked stale
 *   (`refetchType: 'none'`), so a revisit refetches;
 * - the steps registered with {@link registerCatchUpStep} run: the held
 *   quotes' one batched read and the pending store's confirmation.
 *
 * Every mounted gated surface and slot recovers through the gate's own lift
 * (4.1), which is not rate-limited. Started on the first private read
 * (`reads.ts`); importing this module has no side effect.
 */

import {type Query, type QueryClient} from '@tanstack/react-query'

import {restartPrivateQuery} from '#/horizon/private/api/transient'
import {isHeld, releaseUnspecificHolds} from '#/horizon/private/known'
import {PP_COLLECTION} from '#/horizon/private/uri'
import {
  getCurrentClients,
  getCurrentDid,
} from '#/horizon/routing/current-clients'
import {
  getPrismHealth,
  healthEnvironment,
  healthGeneration,
  subscribePrismHealth,
} from '#/horizon/routing/health'

/** The shortest gap between two catch-ups (2.4). */
export const CATCHUP_MIN_MS = 30_000

/** The gap doubles up to this while episodes recur (2.4). */
export const CATCHUP_MAX_MS = 10 * 60_000

/** A catch-up waits 0 to this long once the account turns healthy (2.4). */
export const CATCHUP_JITTER_MS = 2_000

/** One part of the catch-up beyond the queries (the quotes, the pending store). */
export type CatchUpStep = (did: string, queryClient: QueryClient) => void

const steps = new Set<CatchUpStep>()

/** Run `step` on every catch-up. Returns the unregister function. */
export function registerCatchUpStep(step: CatchUpStep): () => void {
  steps.add(step)
  return () => {
    steps.delete(step)
  }
}

type Episode = {
  unwell: boolean
  /** When the last catch-up ran; 0 before any. */
  lastRun: number
  /** The gap the next catch-up keeps from the last. */
  gap: number
  timer: unknown
}

const episodes = new Map<string, Episode>()
let watching = false
let unsubscribe: (() => void) | undefined

function episodeOf(did: string): Episode {
  let episode = episodes.get(did)
  if (!episode) {
    episode = {unwell: false, lastRun: 0, gap: CATCHUP_MIN_MS, timer: undefined}
    episodes.set(did, episode)
  }
  return episode
}

/** Whether a query holds private data: Horizon's private roots, a member's key, a private URI. */
export function isPrivateQuery(query: Pick<Query, 'queryKey'>): boolean {
  const [root] = query.queryKey
  if (typeof root === 'string' && root.startsWith('horizon-private')) {
    return true
  }
  let key: string
  try {
    key = JSON.stringify(query.queryKey)
  } catch {
    return false
  }
  return key.includes(PP_COLLECTION) || key.includes('"horizonPrivate"')
}

function isInfinite(query: Query): boolean {
  const options = query.options as {getNextPageParam?: unknown}
  if (typeof options.getNextPageParam === 'function') return true
  const data = query.state.data as {pages?: unknown; pageParams?: unknown}
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray(data.pages) &&
    Array.isArray(data.pageParams)
  )
}

/**
 * One catch-up of `did`'s private queries in `queryClient` (2.4), and the
 * registered steps.
 */
export function runCatchUp(queryClient: QueryClient, did: string): void {
  for (const query of queryClient.getQueryCache().getAll()) {
    if (!isPrivateQuery(query)) continue
    const queryKey = query.queryKey
    const due =
      !isInfinite(query) &&
      query.isActive() &&
      (query.state.status === 'error' || isHeld(did, queryKey))
    if (!due) {
      void queryClient.invalidateQueries(
        {queryKey, exact: true, refetchType: 'none'},
        {cancelRefetch: false},
      )
      continue
    }
    const sleeping =
      query.state.data === undefined &&
      query.state.fetchStatus === 'fetching' &&
      query.state.fetchFailureCount > 0
    if (sleeping) {
      void restartPrivateQuery(queryClient, queryKey)
    } else {
      void queryClient.invalidateQueries(
        {queryKey, exact: true},
        {cancelRefetch: false},
      )
    }
  }
  // Their refetches are out: holds with no URI end here (HR2-L3).
  releaseUnspecificHolds(did)
  steps.forEach(step => step(did, queryClient))
}

function schedule(did: string, episode: Episode) {
  const env = healthEnvironment()
  if (episode.timer !== undefined) env.clearTimeout(episode.timer)
  const now = env.now()
  const jitter = env.random() * CATCHUP_JITTER_MS
  const at = Math.max(now + jitter, episode.lastRun + episode.gap)
  const generation = healthGeneration()
  episode.timer = env.setTimeout(() => {
    episode.timer = undefined
    // Health was reset since (an account's state forgotten): nothing to catch up.
    if (healthGeneration() !== generation) return
    // Unwell again: the end of that episode runs it.
    if (getPrismHealth(did).causes.size > 0) return
    if (getCurrentDid() !== did) return
    const queryClient = getCurrentClients()?.queryClient
    if (!queryClient) return
    episode.lastRun = healthEnvironment().now()
    runCatchUp(queryClient, did)
  }, at - now)
}

let seenGeneration = healthGeneration()

function onHealth() {
  if (seenGeneration !== healthGeneration()) {
    seenGeneration = healthGeneration()
    episodes.clear()
  }
  const did = getCurrentDid()
  if (!did) return
  const episode = episodeOf(did)
  const unwell = getPrismHealth(did).causes.size > 0
  if (unwell === episode.unwell) return
  episode.unwell = unwell
  const env = healthEnvironment()
  if (unwell) {
    // A new episode: recurring within the gap doubles it, else it resets.
    const recurring =
      episode.lastRun > 0 && env.now() - episode.lastRun < episode.gap
    episode.gap = recurring
      ? Math.min(CATCHUP_MAX_MS, episode.gap * 2)
      : CATCHUP_MIN_MS
    if (episode.timer !== undefined) {
      env.clearTimeout(episode.timer)
      episode.timer = undefined
    }
    return
  }
  schedule(did, episode)
}

/** Start watching health for the catch-up, once. */
export function startCatchUp(): void {
  if (watching) return
  watching = true
  unsubscribe = subscribePrismHealth(onHealth)
  onHealth()
}

/** Forget every episode and stop watching (tests). */
export function resetCatchUp(): void {
  const env = healthEnvironment()
  episodes.forEach(episode => {
    if (episode.timer !== undefined) env.clearTimeout(episode.timer)
  })
  episodes.clear()
  unsubscribe?.()
  unsubscribe = undefined
  watching = false
}
