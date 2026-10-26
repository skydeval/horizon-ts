/*
 * Every prism private read and write goes through here (prism busy design 2,
 * 2.2): `reportedPrismCall` for reads, `reportedPrismWrite` for writes. Each
 * call's own outcome is reported once, to health (`routing/health.ts`) and to
 * membership (`reportPrismError`: `NotEnrolled` demotes, `NotReady` and
 * `Reindexing` ask the probe again, a 501 re-reads the features), and every
 * error is then rethrown for the caller to handle where the call is made.
 *
 * Reads also get:
 * - an answer context: who asked, which method, the `seq` taken at send and
 *   the body's `degraded`, `retryAfter` and `unavailable[]`;
 * - one deadline, `CALL_DEADLINE_MS` from send, after which the call is
 *   aborted and fails as `PrivateDeadlineError`;
 * - single-flight while the account is `catching-up` or `unavailable`: one
 *   call goes (the lead) and the others wait for its outcome. A waiter with
 *   the lead's method and request takes its success, named `Unavailable` or
 *   permanent failure and makes no call; on an account-wide transient
 *   failure every waiter rejects, on a method-specific one the waiters of
 *   that method; the rest go, spread over half a second. Each waiter rejects
 *   with its own `PrivateWaiterError`.
 *
 * Writes go at once whatever the health, never queued or a lead, with no
 * deadline. The development fault switch (`dev-fault.ts`, L-0) applies to
 * both.
 */

import {type Client} from '@atproto/lex'
import {
  type AtUriString,
  type DatetimeString,
  type DidString,
} from '@atproto/syntax'

import {nearhorizon} from '#/horizon/lexicons'
import {
  type PrivatePostView,
  type PrivateThreadView,
  type UnavailablePost,
} from '#/horizon/lexicons/nearhorizon'
import {readAnswerSignals} from '#/horizon/private/api/degraded'
import {withDevFault} from '#/horizon/private/api/dev-fault'
import {
  classifyPrismCall,
  isAccountWidePrismError,
  isPrismUnavailable,
  PrivateDeadlineError,
  PrivateWaiterError,
} from '#/horizon/private/api/transient'
import {startCatchUp} from '#/horizon/private/catch-up'
import {noteServed, servedUrisOf} from '#/horizon/private/known'
import {
  noteQuoteVerdicts,
  quoteVerdictsOf,
} from '#/horizon/private/quotes/verdicts'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {
  getPrismHealth,
  healthEnvironment,
  isPrismThrottled,
  nextAnswerSeq,
  reportReadOutcome,
} from '#/horizon/routing/health'
import {reportPrismError} from '#/horizon/routing/membership'

const GET_POSTS_BATCH = 25

/** Every private read gives up this long after it is sent (2.2, S1). */
export const CALL_DEADLINE_MS = 10_000

/** Waiters released by a lead's outcome go over this window (2.2). */
export const WAITER_SPREAD_MS = 500

/**
 * What one answer said, judged by its own `seq` (2): the account, the
 * method, the `seq` taken at send, and the body's `degraded`, `retryAfter`
 * and `unavailable[]`. An error answer has one too ({@link answerOfError}).
 */
export type AnswerContext = {
  did: string
  method: string
  seq: number
  degraded: boolean
  retryAfterMs: number | undefined
  unavailable: readonly UnavailablePost[]
}

/**
 * A read of several answers (2): `degraded` if any, `unavailable[]` the
 * union, the largest hint and the lowest `seq` (BR12-N3), plus
 * {@link MergedAnswer.seqOf} for each served URI's own answer.
 */
export type MergedAnswer = AnswerContext & {
  /** The `seq` of the answer that served `uri`; the merged `seq` otherwise. */
  seqOf: (uri: string) => number
}

/**
 * Merge the answers of one read made of several calls. `served` lists each
 * answer's served URIs, in the same order as `answers`.
 */
export function mergeAnswers(
  answers: readonly AnswerContext[],
  served: readonly (readonly string[])[] = [],
): MergedAnswer {
  const first = answers[0]
  const seqs = new Map<string, number>()
  answers.forEach((answer, index) => {
    for (const uri of served[index] ?? []) {
      const held = seqs.get(uri)
      seqs.set(
        uri,
        held === undefined ? answer.seq : Math.max(held, answer.seq),
      )
    }
  })
  const unavailable = new Map<string, UnavailablePost>()
  let retryAfterMs: number | undefined
  for (const answer of answers) {
    for (const item of answer.unavailable) unavailable.set(item.uri, item)
    if (answer.retryAfterMs !== undefined) {
      retryAfterMs = Math.max(retryAfterMs ?? 0, answer.retryAfterMs)
    }
  }
  const seq = answers.length
    ? Math.min(...answers.map(answer => answer.seq))
    : 0
  return {
    did: first?.did ?? '',
    method: first?.method ?? '',
    seq,
    degraded: answers.some(answer => answer.degraded),
    retryAfterMs,
    unavailable: Array.from(unavailable.values()),
    seqOf: uri => seqs.get(uri) ?? seq,
  }
}

const errorAnswers = new WeakMap<object, AnswerContext>()

/** The answer context of a failed read's error, when it came from a call. */
export function answerOfError(error: unknown): AnswerContext | undefined {
  return typeof error === 'object' && error !== null
    ? errorAnswers.get(error)
    : undefined
}

/** A lexicon method as the wrappers take it: its NSID names it. */
type Method = {nsid: string}

/** One private read for {@link reportedPrismCall}. */
export type PrismRead<T> = {
  /** Send the call; `signal` aborts it (the deadline, or the page). */
  send: (signal: AbortSignal) => Promise<T>
  /** The request's parameters: the same-request join compares them. */
  params?: unknown
  /** The page's signal. A lead ignores it, so its waiters get an outcome. */
  signal?: AbortSignal
  /** The account the call is for; default the published one. */
  did?: string
  /**
   * A failure that says nothing of prism's health, reported to neither
   * health nor membership: a handle-form Thread Lens anchor whose handle
   * did not resolve (2026-10-26, prism's design 5), retried in DID form,
   * whose own outcome is reported as usual.
   */
  unreported?: (error: unknown) => boolean
}

function answerOf(
  did: string,
  method: string,
  seq: number,
  body: unknown,
): AnswerContext {
  return {did, method, seq, ...readAnswerSignals(body)}
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * `send` with the call deadline: aborted at {@link CALL_DEADLINE_MS} and
 * rejected with `PrivateDeadlineError` (a late answer is dropped). `page`,
 * when given, aborts the call too.
 */
async function withCallDeadline<T>(
  send: (signal: AbortSignal) => Promise<T>,
  page: AbortSignal | undefined,
): Promise<T> {
  const env = healthEnvironment()
  const controller = new AbortController()
  const onPageAbort = () => controller.abort()
  if (page?.aborted) controller.abort()
  page?.addEventListener('abort', onPageAbort)
  let timer: unknown
  const deadline = new Promise<never>((_, reject) => {
    timer = env.setTimeout(() => {
      controller.abort()
      reject(new PrivateDeadlineError())
    }, CALL_DEADLINE_MS)
  })
  try {
    return await Promise.race([send(controller.signal), deadline])
  } finally {
    env.clearTimeout(timer)
    page?.removeEventListener('abort', onPageAbort)
  }
}

type Result<T> = {body: T; answer: AnswerContext}

/** One call that is sent: its outcome is reported, once. */
async function sendRead<T>(
  did: string,
  method: Method,
  request: PrismRead<T>,
  page: AbortSignal | undefined,
): Promise<Result<T>> {
  // The catch-up watches health from the first private read on (2.4).
  startCatchUp()
  const seq = nextAnswerSeq(did)
  try {
    const body = await withCallDeadline(
      signal => withDevFault(method, () => request.send(signal), signal),
      page,
    )
    const answer = answerOf(did, method.nsid, seq, body)
    // Every private post view the answer hydrated is a serve (design 4).
    noteServed(answer, servedUrisOf(body))
    // Its quotes' verdicts land in the quote cache before the page renders (6.3).
    noteQuoteVerdicts(answer, quoteVerdictsOf(body))
    reportReadOutcome(did, {
      kind: 'answered',
      method: method.nsid,
      seq,
      read: true,
      degraded: answer.degraded,
      retryAfterMs: answer.retryAfterMs,
    })
    return {body, answer}
  } catch (error) {
    if (typeof error === 'object' && error !== null) {
      errorAnswers.set(error, answerOf(did, method.nsid, seq, undefined))
    }
    if (!request.unreported?.(error)) {
      reportReadOutcome(did, {kind: 'failed', method: method.nsid, seq, error})
      reportPrismError(did, error)
    }
    throw error
  }
}

type Waiter = {
  method: string
  key: string | undefined
  go: () => void
  take: (result: Result<unknown>) => void
  reject: (error: unknown) => void
  drop: () => void
}

type Flight = {method: string; key: string | undefined; waiters: Waiter[]}

/** The lead call in flight per account, while throttled. */
const flights = new Map<string, Flight>()

function requestKey(params: unknown): string | undefined {
  if (params === undefined) return undefined
  try {
    return JSON.stringify(params)
  } catch {
    return undefined
  }
}

function sameRequest(waiter: Waiter, flight: Flight): boolean {
  return (
    waiter.method === flight.method &&
    waiter.key !== undefined &&
    waiter.key === flight.key
  )
}

/** The lead's outcome, for its waiters (2.2). */
function release(
  did: string,
  flight: Flight,
  outcome: {ok: true; result: Result<unknown>} | {ok: false; error: unknown},
) {
  if (flights.get(did) === flight) flights.delete(did)
  const waiters = flight.waiters.splice(0)
  const env = healthEnvironment()
  const go = (waiter: Waiter) => {
    env.setTimeout(waiter.go, env.random() * WAITER_SPREAD_MS)
  }
  for (const waiter of waiters) waiter.drop()
  if (outcome.ok) {
    for (const waiter of waiters) {
      if (sameRequest(waiter, flight)) waiter.take(outcome.result)
      else go(waiter)
    }
    return
  }
  const {error} = outcome
  const kind = classifyPrismCall(error)
  if (kind !== 'transient' || isPrismUnavailable(error)) {
    // A permanent failure, a named Unavailable or a cancellation.
    for (const waiter of waiters) {
      if (kind !== 'cancelled' && sameRequest(waiter, flight)) {
        waiter.reject(new PrivateWaiterError(error))
      } else {
        go(waiter)
      }
    }
    return
  }
  const accountWide =
    isAccountWidePrismError(error) || getPrismHealth(did).accountWide
  for (const waiter of waiters) {
    if (accountWide || waiter.method === flight.method) {
      waiter.reject(new PrivateWaiterError(error))
    } else {
      go(waiter)
    }
  }
}

/**
 * Run a private read (2, 2.2): through the single-flight while the account
 * is throttled, with the call deadline, its outcome reported once to health
 * and membership. Returns the body with its answer context; rethrows every
 * error.
 */
export function reportedPrismCall<T>(
  method: Method,
  request: PrismRead<T>,
): Promise<Result<T>> {
  const did = request.did ?? getCurrentDid()
  if (!did) {
    // No account: nothing to report to.
    return withCallDeadline(
      signal => withDevFault(method, () => request.send(signal), signal),
      request.signal,
    ).then(body => ({body, answer: answerOf('', method.nsid, 0, body)}))
  }
  if (!isPrismThrottled(did)) {
    return sendRead(did, method, request, request.signal)
  }
  const lead = flights.get(did)
  if (!lead) {
    // The lead ignores its page's signal, so its waiters get an outcome.
    const flight: Flight = {
      method: method.nsid,
      key: requestKey(request.params),
      waiters: [],
    }
    flights.set(did, flight)
    const promise = sendRead(did, method, request, undefined)
    promise.then(
      result => release(did, flight, {ok: true, result}),
      (error: unknown) => release(did, flight, {ok: false, error}),
    )
    return promise
  }
  return new Promise<Result<T>>((resolve, reject) => {
    const page = request.signal
    const onPageAbort = () => {
      const index = lead.waiters.indexOf(waiter)
      if (index >= 0) lead.waiters.splice(index, 1)
      waiter.drop()
      reject(abortError())
    }
    const waiter: Waiter = {
      method: method.nsid,
      key: requestKey(request.params),
      go: () => {
        if (page?.aborted) {
          reject(abortError())
          return
        }
        sendRead(did, method, request, page).then(resolve, reject)
      },
      take: result => resolve(result as Result<T>),
      reject,
      drop: () => page?.removeEventListener('abort', onPageAbort),
    }
    if (page?.aborted) {
      reject(abortError())
      return
    }
    page?.addEventListener('abort', onPageAbort)
    lead.waiters.push(waiter)
  })
}

/** One private write for {@link reportedPrismWrite}. */
export type PrismWrite<T> = {
  send: () => Promise<T>
  /** The account the write is for; default the published one. */
  did?: string
}

/**
 * Run a private write (2.2): at once whatever the health, never queued or a
 * lead, no deadline; its outcome reported once to health and membership
 * (BR-1). Returns the body; rethrows every error.
 */
export async function reportedPrismWrite<T>(
  method: Method,
  request: PrismWrite<T>,
): Promise<T> {
  const did = request.did ?? getCurrentDid()
  if (!did) return withDevFault(method, request.send)
  const seq = nextAnswerSeq(did)
  try {
    const body = await withDevFault(method, request.send)
    reportReadOutcome(did, {
      kind: 'answered',
      method: method.nsid,
      seq,
      read: false,
      degraded: false,
      retryAfterMs: undefined,
    })
    return body
  } catch (error) {
    reportReadOutcome(did, {kind: 'failed', method: method.nsid, seq, error})
    reportPrismError(did, error)
    throw error
  }
}

/**
 * Private posts by URI, de-duplicated and asked 25 at a time. A URI prism
 * does not return (missing, or not readable by the reader) is simply absent.
 */
export async function getPrivatePosts(
  prism: Client,
  uris: readonly string[],
): Promise<PrivatePostView[]> {
  return (await getPrivatePostsAnswered(prism, uris)).posts
}

/**
 * {@link getPrivatePosts} with the merged answer of its batches (design 2),
 * for a caller that judges what was left out (`noteOmissions`, design 4).
 */
export async function getPrivatePostsAnswered(
  prism: Client,
  uris: readonly string[],
): Promise<{posts: PrivatePostView[]; answer: MergedAnswer}> {
  const unique = Array.from(new Set(uris))
  const batches: AtUriString[][] = []
  for (let i = 0; i < unique.length; i += GET_POSTS_BATCH) {
    batches.push(unique.slice(i, i + GET_POSTS_BATCH) as AtUriString[])
  }
  const pages = await Promise.all(
    batches.map(batch => {
      const params = {uris: batch}
      return reportedPrismCall(nearhorizon.privateGetPosts, {
        params,
        send: signal =>
          prism.call(nearhorizon.privateGetPosts, params, {signal}),
      })
    }),
  )
  return {
    posts: pages.flatMap(page => page.body.posts),
    answer: mergeAnswers(
      pages.map(page => page.answer),
      pages.map(page => page.body.posts.map(post => post.uri)),
    ),
  }
}

/**
 * One page of the reader's private timeline.
 */
export async function getPrivateTimeline(
  prism: Client,
  params: {limit?: number; cursor?: string},
): Promise<{feed: PrivatePostView[]; cursor?: string}> {
  return (await getPrivateTimelineAnswered(prism, params)).body
}

/**
 * {@link getPrivateTimeline} with its answer, for the merges, which mark a
 * page degraded from it (design 6.4, 6.5).
 */
export async function getPrivateTimelineAnswered(
  prism: Client,
  params: {limit?: number; cursor?: string},
): Promise<{
  body: {feed: PrivatePostView[]; cursor?: string}
  answer: AnswerContext
}> {
  return reportedPrismCall(nearhorizon.privateGetTimeline, {
    params,
    send: signal =>
      prism.call(nearhorizon.privateGetTimeline, params, {signal}),
  })
}

/**
 * The `filter` values prism's private author feed takes: the stock tab
 * filters (`private.paging`) and the media filters (`private.mediaFilters`,
 * P-30).
 */
export type PrivateAuthorFeedFilter =
  | 'posts_and_author_threads'
  | 'posts_with_replies'
  | 'posts_with_media'
  | 'posts_with_video'

/**
 * One page of an author's private posts that the reader may view.
 */
export async function getPrivateAuthorFeed(
  prism: Client,
  params: {
    actor: string
    limit?: number
    cursor?: string
    filter?: PrivateAuthorFeedFilter
  },
): Promise<{feed: PrivatePostView[]; cursor?: string}> {
  return (await getPrivateAuthorFeedAnswered(prism, params)).body
}

/**
 * {@link getPrivateAuthorFeed} with its answer, for the profile feeds, which
 * mark a page degraded from it (design 6.4).
 */
export async function getPrivateAuthorFeedAnswered(
  prism: Client,
  params: {
    actor: string
    limit?: number
    cursor?: string
    filter?: PrivateAuthorFeedFilter
  },
): Promise<{
  body: {feed: PrivatePostView[]; cursor?: string}
  answer: AnswerContext
}> {
  const request = {...params, actor: params.actor as DidString}
  return reportedPrismCall(nearhorizon.privateGetAuthorFeed, {
    params: request,
    send: signal =>
      prism.call(nearhorizon.privateGetAuthorFeed, request, {signal}),
  })
}

/**
 * One page of the reader's private bookmarks (P-8), newest first.
 */
export async function getPrivateBookmarks(
  prism: Client,
  params: {limit?: number; cursor?: string},
): Promise<{
  bookmarks: {
    createdAt: string
    subject: {uri: string; cid: string}
    item: PrivatePostView
  }[]
  cursor?: string
}> {
  const res = await reportedPrismCall(nearhorizon.privateGetBookmarks, {
    params,
    send: signal =>
      prism.call(nearhorizon.privateGetBookmarks, params, {signal}),
  })
  return res.body
}

/**
 * A private thread. `NotFound` is rethrown like any other error.
 */
export async function getPrivatePostThread(
  prism: Client,
  params: {uri: string; depth?: number; parentHeight?: number},
): Promise<PrivateThreadView> {
  return (await getPrivatePostThreadAnswered(prism, params)).thread
}

/**
 * {@link getPrivatePostThread} with its answer, for the thread adapter, which
 * judges the parents the answer left out (design 6.1).
 */
export async function getPrivatePostThreadAnswered(
  prism: Client,
  params: {uri: string; depth?: number; parentHeight?: number},
): Promise<{thread: PrivateThreadView; answer: AnswerContext}> {
  const request = {...params, uri: params.uri as AtUriString}
  const res = await reportedPrismCall(nearhorizon.privateGetPostThread, {
    params: request,
    send: signal =>
      prism.call(nearhorizon.privateGetPostThread, request, {signal}),
  })
  /*
   * The schema types the thread as an object only (it is recursive); the
   * thread adapter checks each node.
   */
  return {
    thread: res.body.thread as unknown as PrivateThreadView,
    answer: res.answer,
  }
}

/**
 * Untyped items of a 2H list (each checked where it is used).
 */
type Items = Record<string, unknown>[]

/**
 * One page of the reader's private notifications (P-9), newest first.
 */
export async function listPrivateNotifications(
  prism: Client,
  params: {reasons?: string[]; limit?: number; cursor?: string},
): Promise<{notifications: Items; cursor?: string; seenAt?: string}> {
  return (await listPrivateNotificationsAnswered(prism, params)).body
}

/**
 * {@link listPrivateNotifications} with its answer, for the page, which is
 * marked degraded from it (design 6.7).
 */
export async function listPrivateNotificationsAnswered(
  prism: Client,
  params: {reasons?: string[]; limit?: number; cursor?: string},
): Promise<{
  body: {notifications: Items; cursor?: string; seenAt?: string}
  answer: AnswerContext
}> {
  return reportedPrismCall(nearhorizon.privateListNotifications, {
    params,
    send: signal =>
      prism.call(nearhorizon.privateListNotifications, params, {signal}),
  })
}

/**
 * The reader's unread private notification count (P-9).
 */
export async function getPrivateUnreadCount(prism: Client): Promise<number> {
  const res = await reportedPrismCall(nearhorizon.privateGetUnreadCount, {
    params: {},
    send: signal => prism.call(nearhorizon.privateGetUnreadCount, {}, {signal}),
  })
  return res.body.count
}

/**
 * Mark the reader's private notifications seen up to `seenAt` (P-9). A
 * write: it goes at once whatever the health.
 */
export async function updatePrivateSeen(
  prism: Client,
  params: {seenAt: string},
): Promise<void> {
  await reportedPrismWrite(nearhorizon.privateUpdateSeen, {
    send: () =>
      prism.call(nearhorizon.privateUpdateSeen, {
        seenAt: params.seenAt as DatetimeString,
      }),
  })
}

/**
 * One page of a private search (P-7), newest first.
 */
export async function searchPrivatePosts(
  prism: Client,
  params: {q: string; sort?: string; limit?: number; cursor?: string},
): Promise<{posts: Items; cursor?: string}> {
  const res = await reportedPrismCall(nearhorizon.privateSearchPosts, {
    params,
    send: signal =>
      prism.call(nearhorizon.privateSearchPosts, params, {signal}),
  })
  return res.body
}

type InteractionParams = {uri: string; limit?: number; cursor?: string}

/**
 * One page of a private post's likes (P-5).
 */
export async function getPrivateLikes(
  prism: Client,
  params: InteractionParams,
): Promise<{uri: string; likes: Items; cursor?: string}> {
  const request = {...params, uri: params.uri as AtUriString}
  const res = await reportedPrismCall(nearhorizon.privateGetLikes, {
    params: request,
    send: signal => prism.call(nearhorizon.privateGetLikes, request, {signal}),
  })
  return res.body
}

/**
 * One page of a private post's reposters (P-5).
 */
export async function getPrivateRepostedBy(
  prism: Client,
  params: InteractionParams,
): Promise<{uri: string; repostedBy: Items; cursor?: string}> {
  const request = {...params, uri: params.uri as AtUriString}
  const res = await reportedPrismCall(nearhorizon.privateGetRepostedBy, {
    params: request,
    send: signal =>
      prism.call(nearhorizon.privateGetRepostedBy, request, {signal}),
  })
  return res.body
}

/**
 * One page of the posts quoting a private post (P-5).
 */
export async function getPrivateQuotes(
  prism: Client,
  params: InteractionParams,
): Promise<{uri: string; posts: Items; cursor?: string}> {
  const request = {...params, uri: params.uri as AtUriString}
  const res = await reportedPrismCall(nearhorizon.privateGetQuotes, {
    params: request,
    send: signal => prism.call(nearhorizon.privateGetQuotes, request, {signal}),
  })
  return res.body
}

/**
 * One page of the private replies to a private or public post (P-6, P-14),
 * oldest first, as thread nodes.
 */
export async function getPrivateReplies(
  prism: Client,
  params: {uri: string; limit?: number; cursor?: string; depth?: number},
): Promise<{replies: Items; cursor?: string}> {
  const request = {...params, uri: params.uri as AtUriString}
  const res = await reportedPrismCall(nearhorizon.privateGetReplies, {
    params: request,
    send: signal =>
      prism.call(nearhorizon.privateGetReplies, request, {signal}),
  })
  return res.body
}
