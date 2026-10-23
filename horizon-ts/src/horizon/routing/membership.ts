/*
 * Membership in Horizon's network, per account, driven by prism's answers.
 *
 * The last answered state (`member`, `not-member` or `indexing`) is kept per
 * account in Horizon's device keys, with the private-tier features prism
 * answered alongside it (`membership-record.ts`), so a launch starts from it
 * at once and private reads begin without waiting for the probe. Every
 * sign-in, resume and app start still asks again in the background (several
 * of prism's refusal reasons are transient), and a changed answer replaces it
 * as any answer does. A persisted state is never confirmation: it only lets
 * reads start, which prism checks on every call; anything that writes on the
 * strength of membership asks `isMembershipConfirmed`.
 */

import {useSyncExternalStore} from 'react'
import {
  type Client,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'

import {logger} from '#/logger'
import {nearhorizon} from '#/horizon/lexicons'
import {devPrismFault} from '#/horizon/private/api/dev-fault'
import {
  parseRetryAfter,
  PRISM_HINT_FALLBACK_MS,
  retryAfterMs,
  secondsToMs,
} from '#/horizon/private/api/transient'
import {
  answerPrismFeatures,
  featuresAnswered,
  getPrismFeatures,
  loadPrismFeatures,
  type PrismFeatureList,
  servesFeature,
} from '#/horizon/routing/features'
import {reportProbeStatus} from '#/horizon/routing/health'
import {
  type AnsweredMembershipState,
  readMembershipRecord,
  writeMembershipRecord,
} from '#/horizon/routing/membership-record'
import {MEMBERSHIP_PROBE_FALLBACK, MEMBERSHIP_QUERY} from '#/horizon/switches'
import {app} from '#/lexicons'

export {membershipStorageKey} from '#/horizon/routing/membership-record'

/**
 * - `unknown`: not answered yet (default experience).
 * - `indexing`: enrolled, first sync running (default experience, plus a
 *   notice).
 * - `member`: ready; in-network features on.
 * - `not-member`: not in the network (default experience).
 */
export type MembershipState = 'unknown' | 'indexing' | 'member' | 'not-member'

/**
 * The client's own retry schedule: the fallback for an answer with no hint
 * (no body `retryAfter`, no `Retry-After`; a stock PDS proxy strips both).
 * After the last entry, every {@link RETRY_STEADY_MS}.
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

/**
 * A recheck (`requestMembershipRecheck`) asks again only when the probe's
 * last answer is at least this old, unless forced.
 */
export const MEMBERSHIP_RECHECK_MIN_MS = 60_000

/**
 * A forced recheck (a call's `NotReady` or `Reindexing`, prism busy design
 * 2.1) waits at least this long.
 */
export const FORCED_RECHECK_MIN_MS = 2_000

const states = new Map<string, MembershipState>()
/** Accounts whose state prism answered in this run. */
const confirmed = new Set<string>()
/**
 * `permissions.privateIndexed` of the last answer naming a state in this run,
 * for accounts whose answer carried it (2K design PA-1a). Not persisted: the
 * posting route acts only on this run's answer.
 */
const privateIndexed = new Map<string, boolean>()
const listeners = new Set<() => void>()
const enteredIndexingListeners = new Set<(did: string) => void>()
/** One more ask, per account with a running probe. */
const rechecks = new Map<string, (options?: RecheckOptions) => void>()

/**
 * The state held for `did`, loading the persisted record on first use (its
 * features go to the feature store, silently).
 */
function stateOf(did: string): MembershipState {
  const held = states.get(did)
  if (held) return held
  const record = readMembershipRecord(did)
  loadPrismFeatures(did, record?.features)
  const persisted = record?.state ?? 'unknown'
  states.set(did, persisted)
  return persisted
}

/**
 * Record an answer naming a state. `features` is the list answered with it
 * (`null` from a prism without the membership query); `undefined` when the
 * answer carried none (a private read's `NotEnrolled`), which keeps the
 * held list. `indexed` is the answer's `permissions.privateIndexed`;
 * `undefined` (an answer without it, or one from a read) forgets the held
 * one, so the status decides again.
 */
function setState(
  did: string,
  next: MembershipState,
  features?: PrismFeatureList,
  indexed?: boolean,
) {
  const newlyConfirmed = !confirmed.has(did)
  const indexedChanged = privateIndexed.get(did) !== indexed
  if (indexed === undefined) privateIndexed.delete(did)
  else privateIndexed.set(did, indexed)
  confirmed.add(did)
  const previous = stateOf(did)
  if (features !== undefined) answerPrismFeatures(did, features)
  if (next !== 'unknown') {
    writeMembershipRecord(did, {state: next, features: getPrismFeatures(did)})
  }
  if (previous === next) {
    // The same state, now answered in this run (or with new permissions).
    if (newlyConfirmed || indexedChanged) {
      listeners.forEach(listener => listener())
    }
    return
  }
  states.set(did, next)
  logger.info('membership', {did, state: next})
  listeners.forEach(listener => listener())
  if (next === 'indexing') {
    enteredIndexingListeners.forEach(listener => listener(did))
  }
}

/**
 * The membership state of an account: the last one prism answered, in this
 * run or a previous one (`unknown` when never answered).
 */
export function getMembership(did: string | undefined): MembershipState {
  return did ? stateOf(did) : 'unknown'
}

/**
 * Whether `did` is a member of a prism that serves the private read methods
 * (the `private` family; a prism without the membership query serves them).
 * A member of a prism whose answered list lacks `private` gets the default
 * experience. Lives here rather than in `features.ts` so that module stays
 * free of this one.
 */
export function isPrivateMember(did: string | undefined): did is string {
  return (
    !!did && getMembership(did) === 'member' && servesFeature('private', did)
  )
}

/**
 * Whether `did`'s membership answer may be acted on for a write or for the
 * posting route (2K design PA-1a), per facet: `membership` (the state) and
 * `features` (the feature list). The two differ: a `getMembership` answer
 * with an unknown status records features without a state, and a
 * `NotEnrolled` from a private read answers a state without features (a
 * read's `NotReady` or `Reindexing` answers nothing, prism busy BR-1). The only test of "answered"; today each facet is "answered by
 * prism in this run". Fast reads (chainlink #5) adds a persisted answer still
 * inside its validity here, and nowhere else.
 */
export function answerCurrent(did: string | undefined): {
  membership: boolean
  features: boolean
} {
  return {
    membership: !!did && confirmed.has(did),
    features: featuresAnswered(did),
  }
}

/**
 * `permissions.privateIndexed` from `did`'s answer in this run: whether the
 * private posts it writes are indexed (prism: "when false, don't offer
 * private posting"). `undefined` when that answer carried no `permissions`
 * (an older prism), or nothing was answered; the status decides then.
 */
export function getPrivateIndexed(
  did: string | undefined,
): boolean | undefined {
  return did ? privateIndexed.get(did) : undefined
}

/**
 * Whether `did`'s state was answered by prism in this run, rather than read
 * from the device. Writes that rely on membership need this.
 */
export function isMembershipConfirmed(did: string | undefined): boolean {
  return answerCurrent(did).membership
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
 * Whether `did` is a member answered by prism in this run, kept current.
 */
export function useConfirmedMember(did: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeMembership,
    () => getMembership(did) === 'member' && isMembershipConfirmed(did),
  )
}

/**
 * Forget every state held in memory (tests); persisted states are read again
 * on next use.
 */
export function resetMembership() {
  states.clear()
  confirmed.clear()
  privateIndexed.clear()
}

/**
 * What a probe's answer means for membership: `member` on success,
 * `indexing` for `NotReady`, `not-member` for `NotEnrolled`, and `undefined`
 * (no change, retry) for anything else, including `Reindexing` (never
 * `indexing`, prism busy design 2.3), network failures, 5xx and proxy
 * errors. Matched on the XRPC error name, not the status. A private call's
 * `NotReady` never moves the state (BR-1); see {@link reportPrismError}.
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
 * prism's answer for a feature-gated method it does not serve (any more):
 * 501 `MethodNotImplemented`.
 */
function isMethodNotImplemented(error: unknown) {
  return (
    error instanceof XrpcResponseError &&
    error.status === 501 &&
    error.error === 'MethodNotImplemented'
  )
}

/** A call's `NotReady` or `Reindexing`: the account, not the content. */
function isCatchingUpError(error: unknown) {
  return (
    error instanceof XrpcResponseError &&
    (error.error === 'NotReady' || error.error === 'Reindexing')
  )
}

/**
 * A private or Thread Lens call's failure, for membership (prism busy design
 * BR-1, 2.1):
 * - `NotEnrolled` moves the state to `not-member`;
 * - `NotReady` and `Reindexing` never move it: they force one more probe, at
 *   prism's hint (at least {@link FORCED_RECHECK_MIN_MS}; a hintless
 *   `Reindexing` waits 30 s, a hintless `NotReady` the first step of
 *   {@link RETRY_SCHEDULE_MS}), and only the probe's answer moves the state,
 *   with the toast;
 * - 501 `MethodNotImplemented` asks the probe to read the feature list again.
 */
export function reportPrismError(did: string, error: unknown) {
  if (isCatchingUpError(error)) {
    const hint = retryAfterMs(error) ?? RETRY_SCHEDULE_MS[0]
    requestMembershipRecheck(did, {
      force: true,
      atMs: Math.max(hint, FORCED_RECHECK_MIN_MS),
    })
    return
  }
  if (membershipFromError(error) === 'not-member') setState(did, 'not-member')
  if (isMethodNotImplemented(error)) requestMembershipRecheck(did)
}

/**
 * How a recheck asks. `force` (a call's `NotReady` or `Reindexing`) skips
 * {@link MEMBERSHIP_RECHECK_MIN_MS}, stays single-flight (nothing while an
 * ask is in flight) and moves a later pending retry earlier; `atMs` is how
 * long from now it asks.
 */
export type RecheckOptions = {force?: boolean; atMs?: number}

/**
 * Ask `did`'s running probe once more (2H design 3.4), when it is not
 * cancelled, has no retry pending and last answered at least
 * {@link MEMBERSHIP_RECHECK_MIN_MS} ago; or, forced, as
 * {@link RecheckOptions} says. Without a running probe, nothing.
 */
export function requestMembershipRecheck(
  did: string,
  options?: RecheckOptions,
) {
  rechecks.get(did)?.(options)
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
  /** The clock for the recheck's minimum age (default `Date.now`). */
  now?: () => number
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
 * prism answers every public method with 501 `NotImplemented` while its
 * public indexing is off.
 */
function isNotImplemented(error: unknown) {
  return error instanceof XrpcResponseError && error.error === 'NotImplemented'
}

/**
 * The server has no `getMembership`: 404, or 501 with any error name (prism's
 * catch-all for an unknown method is `MethodNotImplemented`), whether or not
 * the body is XRPC JSON.
 */
function isMembershipQueryAbsent(error: unknown) {
  const status =
    error instanceof XrpcResponseError
      ? error.status
      : error instanceof XrpcInvalidResponseError
        ? error.response.status
        : undefined
  return status === 404 || status === 501
}

/**
 * What one ask learned.
 * - `state`: an answer naming a state, with the features answered with it.
 *   `reindexing` is an answered `member` (prism busy design 2.3), polled
 *   again like `indexing`.
 * - `features`: a `getMembership` answer with a status Horizon does not
 *   know: features recorded, retried as an unanswered attempt.
 */
type ProbeOutcome =
  | {
      kind: 'state'
      state: AnsweredMembershipState
      features: PrismFeatureList
      /** `permissions.privateIndexed`, when the answer carried it. */
      indexed?: boolean
      retryMs?: number
      /** The status was `reindexing`. */
      reindexing?: boolean
    }
  | {kind: 'features'; features: PrismFeatureList; retryMs?: number}

/**
 * Start asking prism about `did` through `prismClient`. Returns the cancel
 * function; any account change must call it.
 *
 * With `MEMBERSHIP_QUERY`, the probe asks
 * `app.nearhorizon.actor.getMembership`, which answers the status and the
 * private-tier features and enrolls an eligible account. `member` ends the
 * probe for this run, `indexing` retries after the response's `Retry-After`
 * (else the client schedule), `notEligible` stops until the next start; an
 * unknown status or a 429 retries as an unanswered attempt. `reindexing`
 * (prism busy design 2.3) is an answered `member` that sets health's
 * `catching-up` and polls at `Retry-After`, else `validForSecs` (else 30 s),
 * with no cap; any other answered status clears `catching-up`.
 *
 * Where that method is absent (404 or 501), or with `MEMBERSHIP_QUERY` off,
 * the probe is the Phase 2 one for the rest of this run, with no features:
 * `app.bsky.feed.getTimeline` with `limit: 1`, which also enrolls; and when
 * prism's public indexing is off (501 `NotImplemented`) and
 * `MEMBERSHIP_PROBE_FALLBACK` is on, `app.nearhorizon.private.getTimeline`,
 * which never enrolls (P-10).
 *
 * While the probe runs, `requestMembershipRecheck` asks once more (3.4), or,
 * forced by a call's `NotReady` or `Reindexing`, at that call's hint.
 */
export function startMembershipProbe(
  did: string,
  prismClient: Client,
  env: ProbeEnvironment = defaultEnvironment(),
): () => void {
  const now = env.now ?? Date.now
  let cancelled = false
  let timer: unknown
  let attempt = 0
  let waitingForVisible = false
  let inFlight = false
  let lastAnswerAt: number | undefined
  let legacy = !MEMBERSHIP_QUERY
  let privateProbe = false

  const askLegacy = async (): Promise<ProbeOutcome> => {
    const member: ProbeOutcome = {
      kind: 'state',
      state: 'member',
      features: null,
    }
    if (privateProbe) {
      await prismClient.call(nearhorizon.privateGetTimeline, {limit: 1})
      return member
    }
    try {
      await prismClient.call(app.bsky.feed.getTimeline, {limit: 1})
    } catch (error) {
      if (!MEMBERSHIP_PROBE_FALLBACK || !isNotImplemented(error)) throw error
      privateProbe = true
      if (cancelled) throw error
      await prismClient.call(nearhorizon.privateGetTimeline, {limit: 1})
    }
    return member
  }

  const ask = async (): Promise<ProbeOutcome> => {
    if (legacy) return askLegacy()
    let res
    try {
      res = await prismClient.xrpc(nearhorizon.getMembership)
    } catch (error) {
      if (!isMembershipQueryAbsent(error)) throw error
      legacy = true
      if (cancelled) throw error
      return askLegacy()
    }
    const {status, features, permissions, validForSecs} = res.body
    // The development fault switch (L-0): the probe answers `reindexing`.
    const fault = devPrismFault()
    const faulted = fault === 'reindexing' || fault === 'reindexing-bare'
    const retryMs = faulted
      ? undefined
      : parseRetryAfter(res.headers.get('retry-after'))
    const indexed =
      typeof permissions?.privateIndexed === 'boolean'
        ? permissions.privateIndexed
        : undefined
    /*
     * The development fault switch: a removed member after the purge, or a
     * non-member (appearance storage choice design 11.1).
     */
    if (fault === 'not-enrolled') {
      return {kind: 'state', state: 'not-member', features, indexed}
    }
    if (status === 'reindexing' || faulted) {
      /*
       * A member being re-indexed (prism busy design 2.3): an answered
       * `member`, polled again at `Retry-After`, else `validForSecs`.
       */
      const valid = faulted
        ? fault === 'reindexing'
          ? 30
          : undefined
        : validForSecs
      return {
        kind: 'state',
        state: 'member',
        features,
        indexed,
        retryMs: retryMs ?? secondsToMs(valid),
        reindexing: true,
      }
    }
    if (status === 'member') {
      return {kind: 'state', state: 'member', features, indexed}
    }
    if (status === 'indexing') {
      return {kind: 'state', state: 'indexing', features, indexed, retryMs}
    }
    if (status === 'notEligible') {
      return {kind: 'state', state: 'not-member', features, indexed}
    }
    return {kind: 'features', features, retryMs}
  }

  /** When the pending timer fires. */
  let timerAt = 0

  const schedule = (ms: number) => {
    timerAt = now() + ms
    timer = env.setTimeout(() => {
      timer = undefined
      run()
    }, ms)
  }

  const scheduleDelay = () => RETRY_SCHEDULE_MS[attempt - 1] ?? RETRY_STEADY_MS

  /** Retry an unanswered attempt, or wait for visibility past the cap. */
  const retryUnanswered = (ms: number | undefined) => {
    if (attempt >= MAX_UNKNOWN_ATTEMPTS) {
      // Give up until the tab becomes visible again.
      waitingForVisible = true
      return
    }
    schedule(ms ?? scheduleDelay())
  }

  const run = () => {
    if (cancelled) return
    if (env.isHidden()) {
      waitingForVisible = true
      return
    }
    attempt += 1
    inFlight = true
    ask().then(
      outcome => {
        inFlight = false
        if (cancelled) return
        lastAnswerAt = now()
        if (outcome.kind === 'features') {
          answerPrismFeatures(did, outcome.features)
          retryUnanswered(outcome.retryMs)
          return
        }
        reportProbeStatus(
          did,
          outcome.reindexing ? 'reindexing' : outcome.state,
        )
        setState(did, outcome.state, outcome.features, outcome.indexed)
        if (outcome.reindexing) {
          // A state outcome: the unanswered cap never applies.
          schedule(outcome.retryMs ?? PRISM_HINT_FALLBACK_MS)
          return
        }
        if (outcome.state === 'indexing') {
          schedule(outcome.retryMs ?? scheduleDelay())
        }
      },
      (error: unknown) => {
        inFlight = false
        if (cancelled) return
        const next = membershipFromError(error)
        if (next) {
          lastAnswerAt = now()
          if (next !== 'unknown') reportProbeStatus(did, next)
          setState(did, next, legacy ? null : undefined)
        }
        if (next === 'not-member') return
        if (next === 'indexing') {
          schedule(retryAfterMs(error) ?? scheduleDelay())
          return
        }
        retryUnanswered(retryAfterMs(error))
      },
    )
  }

  const recheck = (options?: RecheckOptions) => {
    if (options?.force) {
      // Single-flight: an ask in flight answers this too.
      if (cancelled || inFlight) return
      const ms = Math.max(0, options.atMs ?? 0)
      if (timer !== undefined) {
        // Only ever earlier.
        if (timerAt <= now() + ms) return
        env.clearTimeout(timer)
        timer = undefined
      }
      waitingForVisible = false
      attempt = 0
      schedule(ms)
      return
    }
    if (cancelled || inFlight || timer !== undefined) return
    if (lastAnswerAt !== undefined) {
      if (now() - lastAnswerAt < MEMBERSHIP_RECHECK_MIN_MS) return
    }
    waitingForVisible = false
    attempt = 0
    run()
  }
  rechecks.set(did, recheck)

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
    if (rechecks.get(did) === recheck) rechecks.delete(did)
    unsubscribeVisible()
  }
}
