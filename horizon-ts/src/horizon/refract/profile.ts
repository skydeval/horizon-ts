/*
 * The profile of a restored account (refract client design 4.1).
 *
 * `refractProfileQuery` wraps the profile query's stock `getProfile`:
 *
 * - With Refract off, stock runs as today.
 * - **Prewarm.** For a DID noted restored, or opened from a view with the
 *   marker, stock and `fill` start together and the first answer paints. A
 *   later stock success always replaces a restored view.
 * - Otherwise, when stock fails with a non-transient error (`AccountTakedown`,
 *   `NotFound`, "Profile not found", any other 4xx but 401 and 429), the DID
 *   is classified and its schedule (`fill.ts`, 5.4) is waited on while the
 *   query stays pending, so the screen shows its loading state, never the
 *   error first.
 * - A profile is the query's data. Stock's error ("Account has been
 *   suspended") is rethrown only for a definitive "not restored", a restore
 *   that ended, or the 10 min "not restored" skip.
 * - Anything else throws {@link ProfileUnavailableError}: `'transient'` (the
 *   call failed or was skipped), `'pending'` or `'unconfirmed'` (prism
 *   answered, not definitively). The hooked line in `Profile.tsx` titles it
 *   "Oops!" and sets its message (`useRefractProfileError`).
 * - **A refetch keeps what is on screen:** over a restored view, every
 *   answer that isn't positive or definitive returns the cached view at once.
 */

import {useState} from 'react'
import {XrpcResponseError} from '@atproto/lex'
import {useLingui} from '@lingui/react/macro'
import {type FetchStatus, type QueryClient} from '@tanstack/react-query'

import {RefractClearedError} from '#/horizon/refract/api'
import {
  connectionText,
  profileNotNowText,
  transientText,
} from '#/horizon/refract/copy'
import {
  type HoldReason,
  isDefinitelyNotRestored,
  markStockFailed,
  refractRetry,
  type ScheduleResult,
  waitOnSchedule,
} from '#/horizon/refract/fill'
import {refractActive} from '#/horizon/refract/gate'
import {
  fromRefract,
  isNotedRestored,
  readRestored,
} from '#/horizon/refract/marker'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type ProfileView = app.bsky.actor.defs.ProfileViewDetailed

/**
 * prism couldn't answer definitively for a profile whose stock read failed.
 * Its message is never shown: the hooked line sets the text by `reason`.
 */
export class ProfileUnavailableError extends Error {
  readonly reason: HoldReason
  constructor(reason: HoldReason) {
    super('Profile unavailable for now')
    this.name = 'ProfileUnavailableError'
    this.reason = reason
  }
}

/**
 * Whether a profile on screen is a restored account's (its marker or stamp,
 * not the reader's own): its Feeds, Lists and Starter Packs tabs are hidden
 * and its counts are not links until prism serves those lists (D5, Q5,
 * RF-S3).
 */
export function isRestoredProfile(profile: unknown): boolean {
  return refractActive() && !!readRestored(profile)
}

function profileKey(did: string) {
  return ['profile', did]
}

/** A stock failure that hands the profile to Refract (4.1). */
export function isRefractableProfileError(error: unknown): boolean {
  if (!(error instanceof XrpcResponseError)) return false
  const status = error.status
  return status >= 400 && status < 500 && status !== 401 && status !== 429
}

function isMounted(qc: QueryClient | undefined, did: string) {
  return () =>
    (qc
      ?.getQueryCache()
      .find({queryKey: profileKey(did)})
      ?.getObserversCount() ?? 0) > 0
}

function refreshFeeds(qc: QueryClient | undefined, did: string) {
  setTimeout(() => {
    void qc?.invalidateQueries({
      predicate: query =>
        query.queryKey[0] === 'post-feed' &&
        typeof query.queryKey[1] === 'string' &&
        query.queryKey[1].startsWith(`author|${did}|`),
    })
  }, 0)
}

async function waitForProfile(
  did: string,
  hold: boolean,
  qc: QueryClient | undefined,
): Promise<ScheduleResult> {
  const mounted = isMounted(qc, did)
  const late = {
    live: mounted,
    onAnswer: (verdict: {kind: string}) => {
      // A positive answer is written by the batcher; a definitive one turns
      // the neutral text into stock's through a refetch (no second fill).
      if (verdict.kind === 'not-restored' || verdict.kind === 'ended') {
        void qc?.invalidateQueries({queryKey: profileKey(did)})
      }
    },
  }
  // The run itself waits while its hold lasts (at most 5.4's cap); after
  // it, the later re-asks go only while the profile is on screen.
  const running = () => true
  try {
    return await waitOnSchedule(did, {
      kind: 'profile',
      hold,
      live: running,
      late,
    })
  } catch (error) {
    // The caches were cleared during the wait: ask again if still active.
    if (error instanceof RefractClearedError && refractActive()) {
      return waitOnSchedule(did, {kind: 'profile', hold, live: running, late})
    }
    throw error
  }
}

function settle(
  did: string,
  result: ScheduleResult,
  stockError: unknown,
  cached: ProfileView | undefined,
  qc: QueryClient | undefined,
): ProfileView {
  switch (result.kind) {
    case 'positive':
      if (!cached) refreshFeeds(qc, did)
      if (result.lateVisitor) {
        setTimeout(
          () => void qc?.invalidateQueries({queryKey: profileKey(did)}),
          0,
        )
      }
      return result.profile
    case 'definitive':
      throw stockError
    case 'unavailable':
      if (cached) return cached
      throw new ProfileUnavailableError(result.reason)
  }
}

/**
 * The profile query's `queryFn` with Refract's fallback. `stock` is the
 * stock `getProfile`; `placeholder` the unstable-cache view it was opened
 * from, if any.
 */
export async function refractProfileQuery(
  did: string,
  stock: () => Promise<ProfileView>,
  placeholder?: unknown,
): Promise<ProfileView> {
  if (!did || !refractActive()) return stock()
  const qc = getCurrentClients()?.queryClient
  const existing = qc?.getQueryData<ProfileView>(profileKey(did))
  const cached = existing && fromRefract(existing) ? existing : undefined

  if (isNotedRestored(did) || readRestored(placeholder)) {
    // Prewarm: both start together, the first answer paints.
    const stockRun = stock()
    const fillRun = waitForProfile(did, !cached, qc)
    type First =
      | {side: 'stock'; profile: ProfileView}
      | {side: 'stock-error'; error: unknown}
      | {side: 'fill'; result: ScheduleResult}
    const first = await Promise.race<First>([
      stockRun.then(
        profile => ({side: 'stock', profile}),
        error => ({side: 'stock-error', error}),
      ),
      fillRun.then(
        result => ({side: 'fill', result}),
        error => ({side: 'stock-error', error}),
      ),
    ])
    if (first.side === 'stock') return first.profile
    if (first.side === 'fill' && first.result.kind === 'positive') {
      // A later stock success replaces the restored view.
      stockRun.then(
        profile => qc?.setQueryData(profileKey(did), profile),
        () => {},
      )
      return settle(did, first.result, undefined, cached, qc)
    }
    let stockError: unknown
    try {
      return await stockRun
    } catch (error) {
      stockError = error
    }
    if (!isRefractableProfileError(stockError)) throw stockError
    const result =
      first.side === 'fill'
        ? first.result
        : await waitForProfile(did, !cached, qc)
    return settle(did, result, stockError, cached, qc)
  }

  let stockError: unknown
  try {
    return await stock()
  } catch (error) {
    stockError = error
  }
  if (!isRefractableProfileError(stockError)) throw stockError
  if (isDefinitelyNotRestored(did)) throw stockError
  markStockFailed(did)
  const result = await waitForProfile(did, !cached, qc)
  return settle(did, result, stockError, cached, qc)
}

/**
 * The profile screen's error, for the hooked lines in `Profile.tsx`:
 * `ProfileUnavailableError` gets "Oops!" and its text by reason, and Try
 * again calls {@link refractRetry} before the refetch, showing the loading
 * state until the refetch it started settles (never while `'paused'`
 * offline). `null` leaves the stock error as it is.
 */
export function useRefractProfileError({
  did,
  error,
  fetchStatus,
  refetch,
}: {
  did: string | undefined
  error: unknown
  fetchStatus: FetchStatus
  refetch: () => Promise<unknown>
}): {
  loading: boolean
  title: string | undefined
  message: string | undefined
  onRetry: (() => void) | undefined
} {
  const {t: l} = useLingui()
  const [retrying, setRetrying] = useState(false)
  const unavailable = error instanceof ProfileUnavailableError ? error : null
  const offline = fetchStatus === 'paused'
  const onRetry =
    did && unavailable
      ? () => {
          refractRetry(did)
          setRetrying(true)
          void refetch().finally(() => setRetrying(false))
        }
      : undefined
  let message: string | undefined
  if (unavailable) {
    if (offline) message = connectionText()
    else if (unavailable.reason === 'transient') message = transientText()
    else message = profileNotNowText()
  }
  return {
    loading: retrying && !offline,
    title: unavailable ? l`Oops!` : undefined,
    message,
    onRetry,
  }
}
