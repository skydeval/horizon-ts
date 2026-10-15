/*
 * Membership in Horizon's network, per account, driven by prism's answers.
 * In memory only: `not-member` is never persisted, because several of prism's
 * refusal reasons are transient, so every sign-in, resume and app start asks
 * again.
 */

import {useSyncExternalStore} from 'react'
import {type Client, XrpcResponseError} from '@atproto/lex'

import {logger} from '#/logger'
import {app} from '#/lexicons'

/**
 * - `unknown`: not answered yet (default experience).
 * - `indexing`: enrolled, first sync running (default experience, plus a
 *   notice).
 * - `member`: ready; in-network features on.
 * - `not-member`: not in the network (default experience).
 */
export type MembershipState = 'unknown' | 'indexing' | 'member' | 'not-member'

/**
 * The client's own retry schedule, used when the response carries no
 * `Retry-After` (aurora-locus's proxy does not forward it). After the last
 * entry, every {@link RETRY_STEADY_MS}.
 */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  5_000, 10_000, 20_000, 40_000,
]

/**
 * The retry interval after the schedule runs out.
 */
export const RETRY_STEADY_MS = 60_000

/**
 * `unknown` retries stop after this many attempts, until the next resume or
 * the tab becoming visible.
 */
export const MAX_UNKNOWN_ATTEMPTS = 10

const states = new Map<string, MembershipState>()
const listeners = new Set<() => void>()
const enteredIndexingListeners = new Set<(did: string) => void>()

function setState(did: string, next: MembershipState) {
  const previous = states.get(did) ?? 'unknown'
  if (previous === next) return
  states.set(did, next)
  logger.info('membership', {did, state: next})
  listeners.forEach(listener => listener())
  if (next === 'indexing') {
    enteredIndexingListeners.forEach(listener => listener(did))
  }
}

/**
 * The membership state of an account (`unknown` when never answered).
 */
export function getMembership(did: string | undefined): MembershipState {
  return (did && states.get(did)) || 'unknown'
}

/**
 * Subscribe to any membership change. Returns the unsubscribe function.
 */
export function subscribeMembership(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Called whenever an account enters `indexing`. Returns the unsubscribe
 * function.
 */
export function onEnteredIndexing(listener: (did: string) => void) {
  enteredIndexingListeners.add(listener)
  return () => {
    enteredIndexingListeners.delete(listener)
  }
}

/**
 * The membership state of an account, kept current.
 */
export function useMembership(did: string | undefined): MembershipState {
  return useSyncExternalStore(subscribeMembership, () => getMembership(did))
}

/**
 * Forget every state (tests).
 */
export function resetMembership() {
  states.clear()
}

/**
 * What a prism answer means for membership: `member` on success, `indexing`
 * for `NotReady`, `not-member` for `NotEnrolled`, and `undefined` (no
 * change, retry) for anything else, including network failures, 5xx and
 * proxy errors. Matched on the XRPC error name, not the status.
 */
export function membershipFromError(
  error: unknown,
): MembershipState | undefined {
  if (error instanceof XrpcResponseError) {
    if (error.error === 'NotReady') return 'indexing'
    if (error.error === 'NotEnrolled') return 'not-member'
  }
  return undefined
}

/**
 * For later phases: a private or Thread Lens call answered with an error that
 * may move the state (`NotEnrolled`, `NotReady`).
 */
export function reportPrismError(did: string, error: unknown) {
  const next = membershipFromError(error)
  if (next) setState(did, next)
}

function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof XrpcResponseError)) return undefined
  const value = error.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

/**
 * The timers and visibility the probe uses; injectable for tests.
 */
export type ProbeEnvironment = {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  isHidden: () => boolean
  /** Call `callback` whenever the page becomes visible; returns unsubscribe. */
  onVisible: (callback: () => void) => () => void
}

function defaultEnvironment(): ProbeEnvironment {
  const hasDocument = typeof document !== 'undefined'
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    isHidden: () => hasDocument && document.visibilityState === 'hidden',
    onVisible: callback => {
      if (!hasDocument) return () => {}
      const listener = () => {
        if (document.visibilityState === 'visible') callback()
      }
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}

/**
 * Start asking prism about `did` through `prismClient`. Until prism has a
 * membership query, the probe is `app.bsky.feed.getTimeline` with `limit: 1`,
 * which also enrolls an eligible account; its body is discarded. Returns the
 * cancel function; any account change must call it.
 */
export function startMembershipProbe(
  did: string,
  prismClient: Client,
  env: ProbeEnvironment = defaultEnvironment(),
): () => void {
  let cancelled = false
  let timer: unknown
  let attempt = 0
  let waitingForVisible = false

  const schedule = (ms: number) => {
    timer = env.setTimeout(() => {
      timer = undefined
      run()
    }, ms)
  }

  const nextDelay = (error: unknown) =>
    retryAfterMs(error) ?? RETRY_SCHEDULE_MS[attempt - 1] ?? RETRY_STEADY_MS

  const run = () => {
    if (cancelled) return
    if (env.isHidden()) {
      waitingForVisible = true
      return
    }
    attempt += 1
    prismClient.call(app.bsky.feed.getTimeline, {limit: 1}).then(
      () => {
        if (cancelled) return
        setState(did, 'member')
      },
      (error: unknown) => {
        if (cancelled) return
        const next = membershipFromError(error)
        if (next) setState(did, next)
        if (next === 'not-member') return
        if (next !== 'indexing' && attempt >= MAX_UNKNOWN_ATTEMPTS) {
          // Give up until the tab becomes visible again.
          waitingForVisible = true
          return
        }
        schedule(nextDelay(error))
      },
    )
  }

  const unsubscribeVisible = env.onVisible(() => {
    if (cancelled || !waitingForVisible || timer !== undefined) return
    waitingForVisible = false
    attempt = 0
    run()
  })

  run()

  return () => {
    cancelled = true
    if (timer !== undefined) env.clearTimeout(timer)
    unsubscribeVisible()
  }
}
