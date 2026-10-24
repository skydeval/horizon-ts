/*
 * The Thread Lens calls (Phase 4 design 5.2, 9.2, 9.3, 11.5) and the two
 * per-account stores they write: the refusal record (3.2) and the 429 wait
 * (11.5).
 *
 * Both calls go to prism directly with a per-method service token when they
 * can, else through the bundle's prism client (the account's PDS with
 * `atproto-proxy` set to prism; `direct.ts`), and always through
 * `reportedPrismCall`, so their outcome is reported to health and membership
 * as for any prism read. Every write here (the refusal record, the wait, the
 * membership report) is for the DID of the key the call was made for, never
 * `getCurrentDid()`, so a call of account A that answers after a switch to B
 * moves only A's stores (v8: R6-N3). With `threadLens.labelers` listed,
 * both calls carry the stock reads' `atproto-accept-labelers`, and the
 * answer says whether prism applied every labeler named (`labelers.ts`).
 *
 * The wait: prism limits lens calls per account, so one "not before" time is
 * held per DID. Until it passes, a lens call fails at once with
 * {@link LensWaitError} and asks prism nothing. Its end is a store event: a
 * module timer per DID clears it and notifies (v8: R6-L1), so a component
 * reads a boolean and never compares a time in render.
 */

import {useSyncExternalStore} from 'react'
import {
  type Client,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'
import {type AtUriString} from '@atproto/syntax'

import {nearhorizon} from '#/horizon/lexicons'
import {reportedPrismCall} from '#/horizon/private/api/reads'
import {leadErrorOf, retryAfterMs} from '#/horizon/private/api/transient'
import {
  LENS_GET_THREAD_LXM,
  LENS_RESOLVE_LXM,
  sendLensCall,
} from '#/horizon/thread-lens/direct'
import {
  ACCEPT_LABELERS,
  CONTENT_LABELERS,
  lensLabelersHeader,
  lensLabelsApplied,
} from '#/horizon/thread-lens/labelers'

/** The wait after a 429 that names none (11.5). */
export const LENS_RATE_LIMIT_FALLBACK_MS = 10_000

/** The shortest wait a 429 sets, so a `ratelimit-reset` of now still waits. */
export const LENS_RATE_LIMIT_MIN_MS = 1_000

/** The parent chain "Load earlier posts" asks for (9.2). */
export const LENS_PARENT_HEIGHT = 80

/** `depth` and `parentHeight` under the dev small-page setting (9.5). */
export const LENS_SMALL_PAGE = 2

/**
 * Whether the dev small-page setting is on (9.5, TL-30). One literal
 * expression, read at call time, so Expo inlines the variable and the
 * minifier drops the branch from a production build (R2-N9).
 */
export function lensSmallPages(): boolean {
  return __DEV__ && process.env.EXPO_PUBLIC_HORIZON_LENS_SMALL_PAGES === '1'
}

/** The `getThread` request body. */
export type LensThreadBody = {
  anchor: string
  depth?: number
  parentHeight?: number
  repliesCursor?: string
}

/**
 * What a lens read asks: the first read of a screen, "Load more replies"
 * (`parentHeight: 0`) or "Load earlier posts" (`depth: 0`).
 */
export type LensReadRequest =
  | {kind: 'first'; anchor: string; depth: number}
  | {kind: 'replies'; anchor: string; depth: number; cursor?: string}
  | {kind: 'parents'; anchor: string}

/**
 * The body for `request` (5.2, 9.2): the first read omits `parentHeight`, so
 * prism's 80 applies; "Load more replies" sends `parentHeight: 0` and its
 * cursor; "Load earlier posts" sends `depth: 0` and `parentHeight` 80. The
 * dev small-page setting sends `parentHeight` 2 and `depth` at most 2 (9.5).
 */
export function lensThreadBody(request: LensReadRequest): LensThreadBody {
  const small = lensSmallPages()
  switch (request.kind) {
    case 'first':
      return small
        ? {
            anchor: request.anchor,
            depth: Math.min(LENS_SMALL_PAGE, request.depth),
            parentHeight: LENS_SMALL_PAGE,
          }
        : {anchor: request.anchor, depth: request.depth}
    case 'replies':
      return {
        anchor: request.anchor,
        parentHeight: 0,
        depth: Math.max(
          1,
          small ? Math.min(LENS_SMALL_PAGE, request.depth) : request.depth,
        ),
        ...(request.cursor !== undefined
          ? {repliesCursor: request.cursor}
          : {}),
      }
    case 'parents':
      return {
        anchor: request.anchor,
        depth: 0,
        parentHeight: small ? LENS_SMALL_PAGE : LENS_PARENT_HEIGHT,
      }
  }
}

/**
 * A `getThread` answer, its nodes unchecked. `readerLabels`: its post views
 * carry the labels of every labeler the call named (`labelers.ts`), read
 * from the response header and kept on the body so a waiter that takes a
 * lead's answer (`reportedPrismCall`) has it too.
 */
export type LensThreadAnswer = {
  anchor: string
  nodes: unknown[]
  bridging: string
  readerLabels?: boolean
}

/** A `resolve` answer, its items unchecked; `readerLabels` as above. */
export type LensResolveAnswer = {
  items: unknown[]
  bridging: string
  readerLabels?: boolean
}

/** The call options that send `labelers`, the header value, if any. */
function labelersOptions(labelers: string | undefined) {
  return labelers ? {headers: {[ACCEPT_LABELERS]: labelers}} : {}
}

/**
 * A lens call made during the account's wait (11.5): it asked prism
 * nothing, and reads as a 429 with the wait's end.
 */
export class LensWaitError extends Error {
  readonly retryAt: number
  constructor(retryAt: number) {
    super('Thread Lens is waiting after a rate limit')
    this.name = 'LensWaitError'
    this.retryAt = retryAt
  }
}

/** Why the lens is refused for an account (3.2). */
export type LensRefusal = 'NotEnrolled' | 'NotReady' | 'MethodNotImplemented'

/**
 * What a failed lens call means for the screen (11.3, 11.4).
 *
 * - `refusal`: `NotEnrolled`, `NotReady` or a 501; the toggle goes.
 * - `rate-limited`: a 429, or a call made during the wait (`called` false).
 * - `reindexing`: prism's `Reindexing` 503; a failure, not a refusal, with
 *   one automatic retry at its hint.
 * - `invalid-request`: a 400 `InvalidRequest` (a refused cursor on a
 *   continuation, 9.2).
 * - `unavailable`: anything else (network, 5xx, 401, a proxy error, a
 *   malformed body, a public-view failure).
 */
export type LensFailure =
  | {kind: 'refusal'; refusal: LensRefusal}
  | {kind: 'rate-limited'; retryAt: number; called: boolean}
  | {kind: 'reindexing'; retryAt: number}
  | {kind: 'invalid-request'}
  | {kind: 'unavailable'}

function statusOf(error: unknown): number | undefined {
  if (error instanceof XrpcResponseError) return error.status
  if (error instanceof XrpcInvalidResponseError) return error.response.status
  return undefined
}

/** The refusal `error` is, if any. */
export function lensRefusalOf(error: unknown): LensRefusal | undefined {
  const lead = leadErrorOf(error)
  if (lead instanceof XrpcResponseError) {
    if (lead.error === 'NotEnrolled') return 'NotEnrolled'
    if (lead.error === 'NotReady') return 'NotReady'
    if (lead.error === 'MethodNotImplemented') return 'MethodNotImplemented'
  }
  return statusOf(lead) === 501 ? 'MethodNotImplemented' : undefined
}

/** The wait a 429 `error` asks for, in ms (11.5, P-4). */
function rateLimitWaitMs(error: unknown, now: number): number {
  const hint = retryAfterMs(error, now) ?? LENS_RATE_LIMIT_FALLBACK_MS
  return Math.max(LENS_RATE_LIMIT_MIN_MS, hint)
}

function isRateLimit(error: unknown): boolean {
  const lead = leadErrorOf(error)
  return (
    statusOf(lead) === 429 ||
    (lead instanceof XrpcResponseError && lead.error === 'RateLimitExceeded')
  )
}

/** Read a failed lens call (11.3). */
export function lensFailureOf(
  error: unknown,
  now: number = Date.now(),
): LensFailure {
  if (error instanceof LensWaitError) {
    return {kind: 'rate-limited', retryAt: error.retryAt, called: false}
  }
  const refusal = lensRefusalOf(error)
  if (refusal) return {kind: 'refusal', refusal}
  if (isRateLimit(error)) {
    return {
      kind: 'rate-limited',
      retryAt: now + rateLimitWaitMs(error, now),
      called: true,
    }
  }
  const lead = leadErrorOf(error)
  if (lead instanceof XrpcResponseError) {
    if (lead.error === 'Reindexing') {
      return {kind: 'reindexing', retryAt: now + (retryAfterMs(lead, now) ?? 0)}
    }
    if (lead.error === 'InvalidRequest') return {kind: 'invalid-request'}
  }
  return {kind: 'unavailable'}
}

/*
 * The refusal record (3.2): per DID, for the run, in memory. A `NotReady` is
 * lifted when the account becomes `member` (`liftLensNotReady`, 4B).
 */
const refusals = new Map<string, LensRefusal>()
const refusalListeners = new Set<() => void>()

function notifyRefusals() {
  refusalListeners.forEach(listener => listener())
}

/** Record a refusal for `did`. */
export function recordLensRefusal(did: string, refusal: LensRefusal) {
  if (refusals.get(did) === refusal) return
  refusals.set(did, refusal)
  notifyRefusals()
}

/** The refusal held for `did`, if any. */
export function getLensRefusal(did: string | undefined) {
  return did ? refusals.get(did) : undefined
}

/** Lift a `NotReady` refusal once the account is a ready member (3.2). */
export function liftLensNotReady(did: string) {
  if (refusals.get(did) !== 'NotReady') return
  refusals.delete(did)
  notifyRefusals()
}

/** Called on every refusal change. Returns the unsubscribe function. */
export function subscribeLensRefusals(listener: () => void) {
  refusalListeners.add(listener)
  return () => {
    refusalListeners.delete(listener)
  }
}

/** Whether `did` holds a refusal, re-rendering when that changes (TL-34). */
export function useLensRefused(did: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeLensRefusals,
    () => !!did && refusals.has(did),
  )
}

/*
 * The 429 wait (11.5): one "not before" time and one timer per DID.
 */
const waits = new Map<string, number>()
const waitTimers = new Map<string, ReturnType<typeof setTimeout>>()
const waitListeners = new Set<() => void>()

function notifyWaits() {
  waitListeners.forEach(listener => listener())
}

/**
 * Hold `did`'s wait until `until`. A time earlier than the one held is
 * ignored, so a shorter `Retry-After` never ends the wait before the time
 * prism asked for first; the timer is replaced only when the time moves
 * later (v9: R7-N6).
 */
export function recordLensWait(
  did: string,
  until: number,
  now: number = Date.now(),
) {
  const held = waits.get(did)
  if (held !== undefined && held >= until) return
  waits.set(did, until)
  const previous = waitTimers.get(did)
  if (previous !== undefined) clearTimeout(previous)
  waitTimers.set(
    did,
    setTimeout(
      () => {
        waitTimers.delete(did)
        if (waits.get(did) !== until) return
        waits.delete(did)
        notifyWaits()
      },
      Math.max(0, until - now),
    ),
  )
  notifyWaits()
}

/** The end of `did`'s wait while one is pending. */
export function getLensWaitUntil(did: string | undefined): number | undefined {
  return did ? waits.get(did) : undefined
}

/** Whether `did` has a wait pending. */
export function isLensWaiting(did: string | undefined): boolean {
  return !!did && waits.has(did)
}

/** Called when a wait starts, moves or ends. Returns the unsubscribe. */
export function subscribeLensWaits(listener: () => void) {
  waitListeners.add(listener)
  return () => {
    waitListeners.delete(listener)
  }
}

/** Whether `did` is waiting, re-rendering when the wait ends (TL-34). */
export function useLensWaiting(did: string | undefined): boolean {
  return useSyncExternalStore(subscribeLensWaits, () => isLensWaiting(did))
}

/**
 * The end of `did`'s wait, only to word it (never compared with the clock
 * in render); 0 with none.
 */
export function useLensWaitUntil(did: string | undefined): number {
  return useSyncExternalStore(
    subscribeLensWaits,
    () => getLensWaitUntil(did) ?? 0,
  )
}

/** Clear the waits and their timers of signed-out accounts (12.1). */
export function clearLensWaits(dids: Iterable<string>) {
  let changed = false
  for (const did of dids) {
    const timer = waitTimers.get(did)
    if (timer !== undefined) clearTimeout(timer)
    waitTimers.delete(did)
    changed = waits.delete(did) || changed
  }
  if (changed) notifyWaits()
}

/** Clear the refusal records of signed-out accounts (12.1). */
export function clearLensRefusals(dids: Iterable<string>) {
  let changed = false
  for (const did of dids) changed = refusals.delete(did) || changed
  if (changed) notifyRefusals()
}

/** Tests: every wait and its timer gone. */
export function resetLensWaits() {
  clearLensWaits(Array.from(waits.keys()))
  for (const timer of waitTimers.values()) clearTimeout(timer)
  waitTimers.clear()
}

/** Tests: every refusal gone. */
export function resetLensRefusals() {
  clearLensRefusals(Array.from(refusals.keys()))
}

/** Tests: the timers this module holds (13; v9: R7-N4). */
export function pendingLensTimerCount(): number {
  return waitTimers.size
}

/**
 * Write what a failed call says to `did`'s stores: a refusal to the record,
 * a 429 to the wait. A call made during the wait writes nothing.
 */
function noteLensError(did: string, error: unknown, now: number) {
  if (error instanceof LensWaitError) return
  const failure = lensFailureOf(error, now)
  if (failure.kind === 'refusal') recordLensRefusal(did, failure.refusal)
  if (failure.kind === 'rate-limited') {
    recordLensWait(did, failure.retryAt, now)
  }
}

function throwIfWaiting(did: string) {
  const until = waits.get(did)
  if (until !== undefined) throw new LensWaitError(until)
}

/**
 * `getThread` for `did` (5.2). Fails at once with {@link LensWaitError}
 * during the account's wait; otherwise the call, its failures written to
 * `did`'s stores and rethrown.
 */
export async function getLensThread(
  prism: Client,
  did: string,
  body: LensThreadBody,
  signal?: AbortSignal,
): Promise<LensThreadAnswer> {
  throwIfWaiting(did)
  const input = {
    ...body,
    anchor: body.anchor as AtUriString,
  }
  const labelers = lensLabelersHeader(did)
  try {
    const res = await reportedPrismCall(nearhorizon.threadLensGetThread, {
      did,
      params: input,
      signal,
      send: callSignal =>
        sendLensCall(
          prism,
          did,
          LENS_GET_THREAD_LXM,
          callSignal,
          async client => {
            const answer = await client.xrpc(nearhorizon.threadLensGetThread, {
              body: input,
              signal: callSignal,
              ...labelersOptions(labelers),
            })
            return {
              ...answer.body,
              readerLabels: lensLabelsApplied(
                labelers,
                answer.headers.get(CONTENT_LABELERS),
              ),
            }
          },
        ),
    })
    return res.body
  } catch (error) {
    noteLensError(did, error, Date.now())
    throw error
  }
}

/** The most URIs one `resolve` takes. */
export const LENS_RESOLVE_BATCH = 25

/**
 * `resolve` for `did` (9.3), at most {@link LENS_RESOLVE_BATCH} URIs. As
 * {@link getLensThread} for the wait and failures.
 */
export async function resolveLens(
  prism: Client,
  did: string,
  uris: readonly string[],
  signal?: AbortSignal,
): Promise<LensResolveAnswer> {
  throwIfWaiting(did)
  const input = {uris: uris.slice(0, LENS_RESOLVE_BATCH) as AtUriString[]}
  const labelers = lensLabelersHeader(did)
  try {
    const res = await reportedPrismCall(nearhorizon.threadLensResolve, {
      did,
      params: input,
      signal,
      send: callSignal =>
        sendLensCall(prism, did, LENS_RESOLVE_LXM, callSignal, async client => {
          const answer = await client.xrpc(nearhorizon.threadLensResolve, {
            body: input,
            signal: callSignal,
            ...labelersOptions(labelers),
          })
          return {
            ...answer.body,
            readerLabels: lensLabelsApplied(
              labelers,
              answer.headers.get(CONTENT_LABELERS),
            ),
          }
        }),
    })
    return res.body
  } catch (error) {
    noteLensError(did, error, Date.now())
    throw error
  }
}
