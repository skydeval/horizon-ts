/*
 * `refractCall` (refract client design 7.2): every `app.nearhorizon.refract.*`
 * call goes through here. It reads no private health and reports to nothing
 * (RF-4): no `reportedPrismCall`, `reportPrismError` or `reportReadOutcome`.
 *
 * - **Transport** (7.1): prism directly with a per-method `#bsky_appview`
 *   token (`getDirectPrismClient`); when a token can't be minted, the
 *   PDS-proxied prism client, and the answer is marked `proxied`.
 * - **Pacing:** background calls go at most 3 a second, the open screen's
 *   first and then the newest; foreground calls are never paced.
 * - **Before sending:** skipped while offline; while Refract's own `retryAt`
 *   lies ahead a background call is skipped, and a foreground call waits for
 *   it if it falls inside the call's deadline, else is skipped.
 * - **Deadlines:** 7 s background, 10 s foreground.
 * - **Errors** by name, then status (`classifyRefractError`). `NotEnabled`
 *   turns the feature off for the account until prism's next membership
 *   answer and clears the caches; a transient error sets `retryAt` with
 *   health's curve and prism's hint as a floor, one per account for all
 *   seven methods. An `InvalidRequest` outside `getAuthorFeed` is a client
 *   bug, logged once with no ids.
 * - **Normalizing:** every answer's views are stamped with the form it was
 *   served in (`servedAs`, else the prediction at send, turned to visitor if
 *   visitor form began before the answer) and normalized (`normalize.ts`).
 *
 * No log line here carries a DID or a URI.
 */

import {type Client, XrpcResponseError} from '@atproto/lex'
import {onlineManager} from '@tanstack/react-query'

import {logger} from '#/logger'
import {IS_DEV} from '#/env'
import {retryAfterMs} from '#/horizon/private/api/transient'
import {answerDevFixture} from '#/horizon/refract/dev-fixtures'
import {
  markRefractNotEnabled,
  restoredVisitorForm,
} from '#/horizon/refract/gate'
import * as lexicon from '#/horizon/refract/lexicon'
import {type RefractMethod} from '#/horizon/refract/lexicon'
import {type RefractForm} from '#/horizon/refract/marker'
import {normalizeRestored, servedAsOf} from '#/horizon/refract/normalize'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {
  getDirectPrismClient,
  getDirectPrismToken,
} from '#/horizon/routing/prism-direct'
import {REFRACT_DEV_FIXTURES} from '#/horizon/switches'

/** Deadlines and pacing (7.2). Mutable for tests. */
export const REFRACT_TIMING = {
  backgroundDeadlineMs: 7_000,
  foregroundDeadlineMs: 10_000,
  /** At most 3 background calls a second. */
  backgroundSpacingMs: 334,
  curveMaxMs: 60_000,
  throttleMaxMs: 5 * 60_000,
}

/** The call was not sent: offline, or inside Refract's `retryAt`. */
export class RefractSkippedError extends Error {
  constructor() {
    super('Refract call skipped')
    this.name = 'RefractSkippedError'
  }
}

/** The call ran past its deadline and was aborted. */
export class RefractDeadlineError extends Error {
  constructor() {
    super('Refract call timed out')
    this.name = 'RefractDeadlineError'
  }
}

/**
 * The batcher's caches were cleared (an account switch, a features change,
 * `NotEnabled`) while the caller waited (5.2's `RefractCleared`).
 */
export class RefractClearedError extends Error {
  constructor() {
    super('Refract caches cleared')
    this.name = 'RefractClearedError'
  }
}

/** What an error means to the surface that made the call (7.2). */
export type RefractErrorKind =
  | 'not-enabled'
  | 'auth'
  | 'transient'
  | 'skipped'
  | 'not-found'
  | 'restore-ended'
  | 'invalid'
  | 'cleared'
  | 'cancelled'

/** Classify a refract call's error, by name first, then status. */
export function classifyRefractError(error: unknown): RefractErrorKind {
  if (error instanceof RefractSkippedError) return 'skipped'
  if (error instanceof RefractDeadlineError) return 'transient'
  if (error instanceof RefractClearedError) return 'cleared'
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled'
  if (error instanceof XrpcResponseError) {
    switch (error.error) {
      case 'NotEnabled':
        return 'not-enabled'
      case 'AuthRequired':
      case 'InvalidToken':
        return 'auth'
      case 'RateLimitExceeded':
      case 'UpstreamFailure':
      case 'NotReady':
      case 'NotEnrolled':
      case 'Reindexing':
        return 'transient'
      case 'NotFound':
        return 'not-found'
      case 'AccountTakedown':
      case 'AccountDeactivated':
        return 'restore-ended'
      case 'InvalidRequest':
      // A prism that doesn't serve the method: a refusal, not a busy server.
      case 'MethodNotImplemented':
      case 'NotImplemented':
      case 'XRPCNotSupported':
        return 'invalid'
    }
    if (error.status === 401) return 'auth'
    if (error.status === 501) return 'invalid'
    if (error.status === 429 || error.status >= 500) return 'transient'
    if (error.status >= 400) return 'invalid'
    return 'transient'
  }
  // Network failures, unreadable answers and anything else.
  return 'transient'
}

/** Whether the surface should read the error as "couldn't load right now". */
export function isTransientRefractError(error: unknown): boolean {
  const kind = classifyRefractError(error)
  return kind === 'transient' || kind === 'skipped' || kind === 'auth'
}

/** One sent call's answer. */
export type RefractAnswer<T> = {
  body: T
  /** Sent through the PDS-proxied client (bare `aud`). */
  proxied: boolean
  /** The form the views were stamped with. */
  form: RefractForm
  /**
   * A visitor answer sent in visitor form and answered after it ended
   * (5.6): its entries are written stale and its queries refreshed.
   */
  lateVisitor: boolean
  /** When the call was sent (device clock). */
  sentAt: number
}

/** How one call is sent. Replaced in tests and by the dev fixtures. */
export type RefractTransport = (
  method: RefractMethod,
  params: Record<string, unknown>,
  options: {signal: AbortSignal},
) => Promise<{body: unknown; proxied: boolean}>

const SCHEMAS: Record<RefractMethod, unknown> = {
  [lexicon.REFRACT_METHODS.fill]: lexicon.fill,
  [lexicon.REFRACT_METHODS.getAuthorFeed]: lexicon.getAuthorFeed,
  [lexicon.REFRACT_METHODS.getPostThread]: lexicon.getPostThread,
  [lexicon.REFRACT_METHODS.getReplies]: lexicon.getReplies,
  [lexicon.REFRACT_METHODS.getTimeline]: lexicon.getTimeline,
  [lexicon.REFRACT_METHODS.listNotifications]: lexicon.listNotifications,
  [lexicon.REFRACT_METHODS.getUnreadCount]: lexicon.getUnreadCount,
  [lexicon.REFRACT_METHODS.getAuthorReposts]: lexicon.getAuthorReposts,
}

function callWith(
  client: Client,
  method: RefractMethod,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const call = client.call.bind(client) as (
    schema: unknown,
    params: unknown,
    options: {signal: AbortSignal},
  ) => Promise<unknown>
  return call(SCHEMAS[method], params, {signal})
}

/** The direct client, or the proxied one when no token can be minted (7.1). */
const defaultTransport: RefractTransport = async (method, params, {signal}) => {
  const clients = getCurrentClients()
  if (!clients) throw new RefractClearedError()
  try {
    await getDirectPrismToken(clients.pdsClient, method)
  } catch {
    const body = await callWith(clients.prismClient, method, params, signal)
    return {body, proxied: true}
  }
  const direct = getDirectPrismClient(clients.pdsClient)
  return {body: await callWith(direct, method, params, signal), proxied: false}
}

let transportOverride: RefractTransport | undefined

/** Test-only: send every refract call through `transport` (undefined resets). */
export function setRefractTransport(transport: RefractTransport | undefined) {
  transportOverride = transport
}

/** Whether the dev fixtures answer (11.3): development builds only. */
export function devFixturesActive(isDev: boolean = IS_DEV): boolean {
  return isDev && REFRACT_DEV_FIXTURES
}

function transport(): RefractTransport {
  if (transportOverride) return transportOverride
  if (devFixturesActive()) return answerDevFixture
  return defaultTransport
}

/* Per-account throttle (one `retryAt` covers all seven methods). */
type Throttle = {retryAt: number; failures: number}
const throttles = new Map<string, Throttle>()

function throttleOf(did: string): Throttle {
  let throttle = throttles.get(did)
  if (!throttle) {
    throttle = {retryAt: 0, failures: 0}
    throttles.set(did, throttle)
  }
  return throttle
}

/** Refract's own `retryAt` for `did` (0: none). */
export function refractRetryAt(did: string): number {
  return throttles.get(did)?.retryAt ?? 0
}

function noteFailure(did: string, error: unknown) {
  const throttle = throttleOf(did)
  throttle.failures += 1
  const curve =
    Math.min(REFRACT_TIMING.curveMaxMs, 1000 * 2 ** throttle.failures) *
    (0.5 + Math.random() * 0.5)
  const hint = retryAfterMs(error) ?? 0
  throttle.retryAt =
    Date.now() + Math.min(REFRACT_TIMING.throttleMaxMs, Math.max(hint, curve))
}

function noteSuccess(did: string) {
  const throttle = throttles.get(did)
  if (throttle) {
    throttle.failures = 0
    throttle.retryAt = 0
  }
}

/* The background pacer. */
type Ticket = {
  screen: boolean
  queuedAt: number
  start: () => void
  cancelled: boolean
}
const queue: Ticket[] = []
let lastBackgroundAt = Number.NEGATIVE_INFINITY
let pacerTimer: ReturnType<typeof setTimeout> | undefined
let ticketOrder = 0

function nextTicket(): Ticket | undefined {
  const live = queue.filter(ticket => !ticket.cancelled)
  queue.length = 0
  queue.push(...live)
  if (live.length === 0) return undefined
  // The open screen's first, then the newest.
  live.sort((a, b) =>
    a.screen !== b.screen ? (a.screen ? -1 : 1) : b.queuedAt - a.queuedAt,
  )
  const ticket = live[0]
  queue.splice(queue.indexOf(ticket), 1)
  return ticket
}

function pump() {
  if (pacerTimer !== undefined) return
  const wait =
    lastBackgroundAt + REFRACT_TIMING.backgroundSpacingMs - Date.now()
  if (wait > 0) {
    pacerTimer = setTimeout(() => {
      pacerTimer = undefined
      pump()
    }, wait)
    return
  }
  const ticket = nextTicket()
  if (!ticket) return
  lastBackgroundAt = Date.now()
  ticket.start()
  if (queue.length > 0) pump()
}

/**
 * A place in the background queue. `start` runs when the pacer reaches it;
 * `promote` takes it out of the queue and runs it at once (a foreground ask
 * joined it, 5.1); `cancel` drops it.
 */
export type PacedSlot = {promote: () => void; cancel: () => void}

/** Wait for a background send slot. */
export function waitForBackgroundSlot(
  start: () => void,
  {screen = false}: {screen?: boolean} = {},
): PacedSlot {
  let started = false
  const ticket: Ticket = {
    screen,
    queuedAt: ++ticketOrder,
    cancelled: false,
    start: () => {
      if (started) return
      started = true
      start()
    },
  }
  queue.push(ticket)
  pump()
  return {
    promote: () => {
      if (started) return
      ticket.cancelled = true
      ticket.start()
    },
    cancel: () => {
      ticket.cancelled = true
    },
  }
}

/** Options for one call. */
export type RefractCallOptions = {
  foreground: boolean
  /** A background call for the open screen (7.2's order). */
  screen?: boolean
  /** Already given its send slot by the caller's own pacing (the batcher). */
  paced?: boolean
  /** Aborts the call too. */
  signal?: AbortSignal
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}

let invalidLogged = false

/**
 * Send one refract call (7.2). Resolves with the normalized answer; rejects
 * with the classified error after recording its effect.
 */
export async function refractCall<T>(
  method: RefractMethod,
  params: Record<string, unknown>,
  options: RefractCallOptions,
): Promise<RefractAnswer<T>> {
  const did = getCurrentClients()?.did
  if (!did) throw new RefractClearedError()
  if (!onlineManager.isOnline()) throw new RefractSkippedError()
  const deadlineMs = options.foreground
    ? REFRACT_TIMING.foregroundDeadlineMs
    : REFRACT_TIMING.backgroundDeadlineMs
  const retryWait = refractRetryAt(did) - Date.now()
  if (retryWait > 0) {
    if (!options.foreground || retryWait >= deadlineMs) {
      throw new RefractSkippedError()
    }
    await sleep(retryWait, options.signal)
  }
  if (!options.foreground && !options.paced) {
    await new Promise<void>(resolve => {
      waitForBackgroundSlot(resolve, {screen: options.screen})
    })
  }

  const controller = new AbortController()
  options.signal?.addEventListener('abort', () => controller.abort())
  const visitorAtSend = restoredVisitorForm(did)
  const sentAt = Date.now()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, deadlineMs)
  try {
    const {body, proxied} = await transport()(method, params, {
      signal: controller.signal,
    })
    if (getCurrentClients()?.did !== did) throw new RefractClearedError()
    noteSuccess(did)
    const visitorNow = restoredVisitorForm(did)
    const form: RefractForm =
      servedAsOf(body) ?? (visitorAtSend || visitorNow ? 'visitor' : 'member')
    normalizeRestored(body, form)
    return {
      body: body as T,
      proxied,
      form,
      lateVisitor: form === 'visitor' && visitorAtSend && !visitorNow,
      sentAt,
    }
  } catch (caught) {
    const error = timedOut ? new RefractDeadlineError() : caught
    const kind = classifyRefractError(error)
    if (kind === 'not-enabled') {
      markRefractNotEnabled(did)
      clearHooks.forEach(hook => hook('not-enabled'))
    } else if (kind === 'transient') {
      noteFailure(did, error)
    } else if (
      kind === 'invalid' &&
      method !== 'app.nearhorizon.refract.getAuthorFeed' &&
      // Its `InvalidRequest` is an actor not found, and a refusal (404) from a prism without it.
      method !== 'app.nearhorizon.refract.getAuthorReposts'
    ) {
      if (!invalidLogged) {
        invalidLogged = true
        logger.warn('refract: request refused as invalid', {method})
      }
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const clearHooks = new Set<(reason: 'not-enabled') => void>()

/** Called when a call answers `NotEnabled` (the batcher clears its caches). */
export function onRefractNotEnabled(hook: (reason: 'not-enabled') => void) {
  clearHooks.add(hook)
  return () => {
    clearHooks.delete(hook)
  }
}

/** Test-only: forget throttles, the queue and the pacer. */
export function resetRefractApi() {
  throttles.clear()
  queue.length = 0
  if (pacerTimer !== undefined) clearTimeout(pacerTimer)
  pacerTimer = undefined
  lastBackgroundAt = Number.NEGATIVE_INFINITY
  invalidLogged = false
}
