/*
 * prism's health for one account (prism busy design 2), in memory only: why
 * prism is not serving right now, if it is not, and when a call may go
 * again. Fed by every private read (`reportedPrismCall`) and write
 * (`reportedPrismWrite`) with its own outcome, once, and by the membership
 * probe (`reportProbeStatus`). It never reads membership and makes no call
 * of its own.
 *
 * Causes, each set and cleared on matching evidence (2.1):
 * - `catching-up`: a call's `NotReady` or `Reindexing`, or the probe's
 *   `reindexing`; cleared only by an answered probe status other than
 *   `reindexing`.
 * - `unavailable`: any other transient failure (a 5xx that is not a named
 *   `Unavailable`, network, 429, a read's deadline); cleared by the next
 *   private 2xx. Account-wide when a failure was (network, 429,
 *   `UpstreamFailure`) or when method-specific failures reached two methods.
 * - `degraded`: an answer with `degraded: true` sent after the latest fresh
 *   one; it expires at its `retryAfter` (else 30 s), or, under
 *   `private.degraded`, is cleared by a fresh answer of a listed method sent
 *   after the latest degraded one.
 *
 * Answers are ordered by when they were sent (`seq`, a per-account counter
 * taken at send), so a late answer never undoes a newer one.
 */

import {useSyncExternalStore} from 'react'

import {DEGRADED_METHODS} from '#/horizon/private/api/degraded'
import {
  classifyPrismCall,
  isAccountWidePrismError,
  isPrismUnavailable,
  leadErrorOf,
  retryAfterMs,
} from '#/horizon/private/api/transient'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {servesFeature} from '#/horizon/routing/features'

export type HealthCause = 'catching-up' | 'unavailable' | 'degraded'

export type PrismHealth = {
  /** Empty: healthy. */
  causes: ReadonlySet<HealthCause>
  /** `unavailable` is account-wide (2.1). */
  accountWide: boolean
  /** Methods failed method-specifically since the last private 2xx. */
  failedMethods: ReadonlySet<string>
  /** The start of this episode (the first cause set while healthy). */
  since: number
  /** The next time a retry may go. */
  retryAt: number
  /** Consecutive transient failures. */
  failures: number
}

/** The curve's top before the hint (2.2). */
export const THROTTLE_CURVE_MAX_MS = 60_000
/** The longest throttle step, hint included. */
export const THROTTLE_MAX_MS = 5 * 60_000
/** How long a `degraded` answer without `retryAfter` holds the cause. */
export const DEGRADED_DEFAULT_MS = 30_000

/** The clock, timers and randomness health uses; injectable for tests. */
export type HealthEnvironment = {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  random: () => number
}

function defaultEnvironment(): HealthEnvironment {
  return {
    now: Date.now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    random: Math.random,
  }
}

let env = defaultEnvironment()
let launchAt = env.now()
/** Raised by every reset, so timers set before one can tell (the catch-up). */
let generation = 0

/** The reset generation: timers set before a reset do nothing after it. */
export function healthGeneration(): number {
  return generation
}

/** The environment in use (the call deadline and the waiters read it too). */
export function healthEnvironment(): HealthEnvironment {
  return env
}

type State = {
  causes: Set<HealthCause>
  accountWide: boolean
  failedMethods: Set<string>
  since: number
  retryAt: number
  failures: number
  /** The next `seq` to hand out. */
  nextSeq: number
  /** The highest `seq` of a fresh listed 2xx (under `private.degraded`). */
  clearedSeq: number
  /** The highest `seq` of a degraded answer. */
  degradedSeq: number
  degradedTimer: unknown
  /**
   * A private read answered 2xx since the last account-wide cause cleared
   * (at launch: since launch).
   */
  answered: boolean
  /** Set while unconfirmed (2.1). */
  floor: number | undefined
  snapshot: PrismHealth
}

const HEALTHY: PrismHealth = Object.freeze({
  causes: new Set<HealthCause>(),
  accountWide: false,
  failedMethods: new Set<string>(),
  since: 0,
  retryAt: 0,
  failures: 0,
})

const states = new Map<string, State>()
const listeners = new Set<() => void>()

function stateOf(did: string): State {
  let state = states.get(did)
  if (!state) {
    state = {
      causes: new Set(),
      accountWide: false,
      failedMethods: new Set(),
      since: 0,
      retryAt: 0,
      failures: 0,
      nextSeq: 1,
      clearedSeq: 0,
      degradedSeq: 0,
      degradedTimer: undefined,
      answered: false,
      floor: launchAt,
      snapshot: HEALTHY,
    }
    states.set(did, state)
  }
  return state
}

function hasAccountWideCause(state: State): boolean {
  return (
    state.causes.has('catching-up') ||
    state.causes.has('degraded') ||
    (state.causes.has('unavailable') && state.accountWide)
  )
}

function confirmed(state: State): boolean {
  return state.answered && !hasAccountWideCause(state)
}

function addCause(state: State, cause: HealthCause, now: number) {
  if (state.causes.size === 0) state.since = now
  state.causes.add(cause)
}

/**
 * After a change: the snapshot, the confirmation floor, and the listeners.
 * `accountWideFailure` is a call's account-wide failure (or any failure once
 * the episode is account-wide), which raises the floor while unconfirmed.
 */
function commit(
  state: State,
  wasConfirmed: boolean,
  now: number,
  accountWideFailure = false,
) {
  const isConfirmed = confirmed(state)
  if (isConfirmed) {
    state.floor = undefined
  } else if (wasConfirmed) {
    state.floor = now
  } else if (accountWideFailure) {
    state.floor = Math.max(state.floor ?? now, now)
  }
  state.snapshot = Object.freeze({
    causes: new Set(state.causes),
    accountWide: state.accountWide,
    failedMethods: new Set(state.failedMethods),
    since: state.since,
    retryAt: state.retryAt,
    failures: state.failures,
  })
  listeners.forEach(listener => listener())
}

/** An account-wide cause cleared: a new private 2xx must confirm again. */
function clearCause(state: State, cause: HealthCause) {
  if (!state.causes.delete(cause)) return
  if (cause !== 'unavailable' || state.accountWide) state.answered = false
}

/** One transient failure's throttle step (2.2): the hint is a floor. */
function throttle(state: State, hintMs: number | undefined, now: number) {
  state.failures += 1
  const curve =
    Math.min(THROTTLE_CURVE_MAX_MS, 1000 * 2 ** state.failures) *
    (0.5 + env.random() * 0.5)
  const step = Math.min(THROTTLE_MAX_MS, Math.max(hintMs ?? 0, curve))
  state.retryAt = now + step
}

/** The `degraded` cause ends `ms` from now, unless renewed first. */
function armDegradedExpiry(state: State, ms: number) {
  if (state.degradedTimer !== undefined) env.clearTimeout(state.degradedTimer)
  state.degradedTimer = env.setTimeout(() => {
    state.degradedTimer = undefined
    if (!state.causes.has('degraded')) return
    const wasConfirmed = confirmed(state)
    clearCause(state, 'degraded')
    commit(state, wasConfirmed, env.now())
  }, ms)
}

/**
 * A private call's own outcome, as the wrappers report it, once per call (a
 * waiter that took its lead's outcome reports nothing).
 * - `answered`: a 2xx, with the answer's `degraded` and `retryAfter`;
 * - `failed`: any error. A cancellation, a permanent error and a named
 *   `Unavailable` (`getPostThread`'s anchor miss) take and clear nothing.
 */
export type ReadOutcome =
  | {
      kind: 'answered'
      method: string
      seq: number
      /** A read (a write's 2xx clears `unavailable` but confirms nothing). */
      read: boolean
      degraded: boolean
      retryAfterMs: number | undefined
    }
  | {kind: 'failed'; method: string; seq: number; error: unknown}

/**
 * The `seq` of a call about to be sent for `did`: answers are judged in the
 * order they were sent.
 */
export function nextAnswerSeq(did: string): number {
  const state = stateOf(did)
  return state.nextSeq++
}

/** Record one call's own outcome (2.1, 2.2). */
export function reportReadOutcome(did: string, outcome: ReadOutcome): void {
  const state = stateOf(did)
  const now = env.now()
  const wasConfirmed = confirmed(state)
  if (outcome.kind === 'failed') {
    const error = outcome.error
    if (classifyPrismCall(error) !== 'transient') return
    if (isPrismUnavailable(error)) return
    const lead = leadErrorOf(error) as {error?: unknown}
    const name = typeof lead?.error === 'string' ? lead.error : undefined
    if (name === 'NotReady' || name === 'Reindexing') {
      if (!state.causes.has('catching-up')) state.answered = false
      addCause(state, 'catching-up', now)
    } else {
      if (isAccountWidePrismError(error)) {
        state.accountWide = true
      } else {
        state.failedMethods.add(outcome.method)
        if (state.failedMethods.size >= 2) state.accountWide = true
      }
      if (state.accountWide) state.answered = false
      addCause(state, 'unavailable', now)
    }
    throttle(state, retryAfterMs(error, now), now)
    commit(
      state,
      wasConfirmed,
      now,
      isAccountWidePrismError(error) || state.accountWide,
    )
    return
  }

  // A 2xx.
  state.failures = 0
  state.failedMethods.clear()
  state.retryAt = now
  clearCause(state, 'unavailable')
  state.accountWide = false
  if (outcome.degraded) {
    if (outcome.seq > state.clearedSeq) {
      if (!state.causes.has('degraded')) state.answered = false
      addCause(state, 'degraded', now)
      state.degradedSeq = Math.max(state.degradedSeq, outcome.seq)
      armDegradedExpiry(state, outcome.retryAfterMs ?? DEGRADED_DEFAULT_MS)
    }
  } else if (
    DEGRADED_METHODS.has(outcome.method) &&
    servesFeature('private.degraded', did)
  ) {
    state.clearedSeq = Math.max(state.clearedSeq, outcome.seq)
    if (state.causes.has('degraded') && outcome.seq > state.degradedSeq) {
      clearCause(state, 'degraded')
      if (state.degradedTimer !== undefined) {
        env.clearTimeout(state.degradedTimer)
        state.degradedTimer = undefined
      }
    }
  }
  if (outcome.read && !hasAccountWideCause(state)) state.answered = true
  commit(state, wasConfirmed, now)
}

/**
 * The membership probe's answered status for `did` (2.1, 2.3): `reindexing`
 * sets `catching-up`; any other answered status clears it, whether or not it
 * moves the state. An unanswered probe reports nothing.
 */
export function reportProbeStatus(
  did: string,
  status: 'member' | 'indexing' | 'not-member' | 'reindexing',
): void {
  const state = stateOf(did)
  const now = env.now()
  const wasConfirmed = confirmed(state)
  if (status === 'reindexing') {
    if (!state.causes.has('catching-up')) state.answered = false
    addCause(state, 'catching-up', now)
  } else {
    if (!state.causes.has('catching-up')) return
    clearCause(state, 'catching-up')
  }
  commit(state, wasConfirmed, now)
}

/** `did`'s health (default: the published account); healthy when unknown. */
export function getPrismHealth(did: string | undefined = getCurrentDid()) {
  if (!did) return HEALTHY
  return states.get(did)?.snapshot ?? HEALTHY
}

/**
 * Whether calls for `did` go one at a time (2.2): while `catching-up` or
 * `unavailable` is set. `degraded` alone does not throttle.
 */
export function isPrismThrottled(did: string): boolean {
  const causes = states.get(did)?.causes
  return !!causes && (causes.has('catching-up') || causes.has('unavailable'))
}

/**
 * No account-wide cause, and a private read answered 2xx since the last one
 * cleared (at launch: since launch) (2.1, BR-7).
 */
export function isPrismConfirmed(did: string | undefined = getCurrentDid()) {
  if (!did) return false
  return confirmed(stateOf(did))
}

/**
 * While unconfirmed: the arrival of the answer that ended confirmation (at
 * launch, the launch time), raised to every account-wide failure since.
 * `undefined` while confirmed.
 */
export function floorSince(
  did: string | undefined = getCurrentDid(),
): number | undefined {
  if (!did) return undefined
  const state = stateOf(did)
  return confirmed(state) ? undefined : state.floor
}

/** Subscribe to any health change. Returns the unsubscribe function. */
export function subscribePrismHealth(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** {@link getPrismHealth}, kept current. */
export function usePrismHealth(did?: string): PrismHealth {
  return useSyncExternalStore(subscribePrismHealth, () => getPrismHealth(did))
}

/** {@link isPrismConfirmed}, kept current. */
export function usePrismConfirmed(did?: string): boolean {
  return useSyncExternalStore(subscribePrismHealth, () =>
    isPrismConfirmed(did),
  )
}

/**
 * Forget every account's health and start a new "launch" (tests), with an
 * optional environment replacing the default.
 */
export function resetPrismHealth(next?: Partial<HealthEnvironment>) {
  states.forEach(state => {
    if (state.degradedTimer !== undefined) env.clearTimeout(state.degradedTimer)
  })
  states.clear()
  generation++
  env = {...defaultEnvironment(), ...next}
  launchAt = env.now()
  listeners.forEach(listener => listener())
}
