/*
 * The quote cache's values and verdicts (prism busy design 6.3). Kept apart
 * from `cache.ts` so the read wrapper (`api/reads.ts`) can write prism's
 * verdicts on every answer without importing the quote reads.
 *
 * A cached quote is the view (JSON), `null` (the audience stand-in: the post
 * is not one the reader may view, as far as prism said) or `{unavailable:
 * true, uri}` (the quiet card: prism cannot answer for it now). Every write
 * of a verdict is checked against the `seq` of the last verdict for its URI,
 * so an older answer never overrides a newer one (BR10-N8, BR11-N4), and only
 * a write that takes effect records the quote as answered (BR13-N4).
 */

import {jsonToLex, type JsonValue, lexToJson} from '@atproto/lex'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {STALE} from '#/state/queries'
import {createQueryKey} from '#/state/queries/util'
import {withConvertedQuotes} from '#/horizon/private/adapt/post-view'
import {type AnswerContext, type MergedAnswer} from '#/horizon/private/api/reads'
import {
  answeredSince,
  hold,
  isOwnPrivateUri,
  noteAnswered,
  noteMiss,
} from '#/horizon/private/known'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {
  getCurrentClients,
  getCurrentDid,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** How long a quote read is used before it is read again. */
export const QUOTE_STALE_MS = STALE.MINUTES.FIVE

/** How long an unused quote stays in the cache, and on disk. */
export const QUOTE_GC_MS = 24 * 60 * 60 * 1000

/** A quote prism cannot answer for now: the quiet card (6.3). */
export type UnavailableQuote = {unavailable: true; uri: string}

/**
 * A quoted private post as cached: JSON, `null` when it is not viewable, or
 * {@link UnavailableQuote}.
 */
export type QuoteData = JsonValue | null

/**
 * The persisted query key of the quoted private post at `uri`. Version 2
 * drops quotes cached with a video on the video service's CDN, from before a
 * private video played from its author's PDS. Version 3 drops quotes cached
 * with a quoted private post of their own left unconverted (no spoilers or
 * content warning).
 */
export function privateQuoteQueryKey(uri: string) {
  return createQueryKey('horizon-private-quote', {uri}, {persistedVersion: 3})
}

/** A read post as cached. */
export function toQuoteData(post: PostView | undefined): QuoteData {
  if (!post) return null
  try {
    return lexToJson(post)
  } catch (error) {
    logger.warn('private quote not cacheable', {safeMessage: error})
    return null
  }
}

/** The quiet card's value for `uri`. */
export function unavailableQuote(uri: string): QuoteData {
  return {unavailable: true, uri}
}

/** Whether a cached quote is the quiet card's value. */
export function isUnavailableQuote(
  data: QuoteData | undefined,
): data is UnavailableQuote {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as {unavailable?: unknown}).unavailable === true
  )
}

/** Whether a cached quote is a view (content). */
export function isQuoteView(data: QuoteData | undefined): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    !isUnavailableQuote(data)
  )
}

/**
 * A cached quote as a post view, or `undefined` when it is not viewable or
 * is the quiet card.
 */
export function fromQuoteData(data: QuoteData | undefined): PostView | undefined {
  if (!isQuoteView(data)) return undefined
  return jsonToLex(data as JsonValue) as unknown as PostView
}

/** Per account: the `seq` of the last verdict per URI. */
type Ledger = {seqs: Map<string, number>}

const ledgers = new Map<string, Ledger>()
let watching = false

function ledgerOf(did: string): Ledger {
  if (!watching) {
    watching = true
    let current = getCurrentDid()
    subscribeCurrentClients(() => {
      const next = getCurrentDid()
      if (next !== current) {
        current = next
        ledgers.clear()
      }
    })
  }
  let ledger = ledgers.get(did)
  if (!ledger) {
    ledger = {seqs: new Map()}
    ledgers.set(did, ledger)
  }
  return ledger
}

/** Whether a verdict from an answer sent at `seq` may still take effect. */
export function verdictTakesEffect(did: string, uri: string, seq: number) {
  const last = ledgers.get(did)?.seqs.get(uri)
  return last === undefined || seq >= last
}

/**
 * Record that a verdict from `seq` took effect for `uri`: its `seq`, and, for
 * `null` and the quiet card, answered (BR13-N4).
 */
function recordVerdict(did: string, uri: string, seq: number, value: QuoteData) {
  const ledger = ledgerOf(did)
  ledger.seqs.set(uri, seq)
  if (!isQuoteView(value)) noteAnswered(did, uri)
}

/**
 * Whether the cached quote at `uri` is fresh (6.3): not the quiet card,
 * written in this run, read under {@link QUOTE_STALE_MS} ago, not
 * invalidated, and, where a floor applies (an unconfirmed page fetch's start,
 * a slot's floor), answered since it.
 */
export function isFreshQuote(
  queryClient: QueryClient,
  uri: string,
  {
    now = Date.now(),
    floor,
    did = getCurrentDid(),
  }: {now?: number; floor?: number; did?: string} = {},
): boolean {
  return isFreshQuoteState(
    queryClient.getQueryState<QuoteData>(privateQuoteQueryKey(uri)),
    uri,
    {now, floor, did},
  )
}

/** {@link isFreshQuote} of a quote query's state (its data-aware `staleTime`). */
export function isFreshQuoteState(
  state:
    | {data?: unknown; dataUpdatedAt: number; isInvalidated: boolean}
    | undefined,
  uri: string,
  {
    now = Date.now(),
    floor,
    did = getCurrentDid(),
  }: {now?: number; floor?: number; did?: string} = {},
): boolean {
  if (!state || state.data === undefined || state.isInvalidated) return false
  if (isUnavailableQuote(state.data)) return false
  if (now - state.dataUpdatedAt >= QUOTE_STALE_MS) return false
  // A value restored from disk was written before this run began.
  if (state.dataUpdatedAt < RUN_STARTED_AT) return false
  if (floor !== undefined && (!did || !answeredSince(did, uri, floor))) {
    return false
  }
  return true
}

/** When this run began: a quote written before it was restored from disk. */
const RUN_STARTED_AT = Date.now()

/** Forget every account's ledger (tests). */
export function resetQuoteVerdicts() {
  ledgers.clear()
}

/** One quoted private post in a prism answer, as it came. */
export type QuoteVerdict =
  | {uri: string; kind: 'view'; record: unknown}
  | {uri: string; kind: 'unavailable'; retryAfterMs: number | undefined}
  | {uri: string; kind: 'notFound'}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Every quoted private post in a prism answer's body, at any depth (6.3):
 * each `app.bsky.embed.record#view`'s record, a `#viewRecord` (served), a
 * `#viewUnavailable` (prism cannot show it yet) or a `#viewNotFound`.
 */
export function quoteVerdictsOf(body: unknown): QuoteVerdict[] {
  const out = new Map<string, QuoteVerdict>()
  const seen = new Set<object>()
  const walk = (value: unknown, depth: number) => {
    if (depth > 24 || !isObject(value) || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (value.$type === 'app.bsky.embed.record#view' && isObject(value.record)) {
      const record = value.record
      const uri = typeof record.uri === 'string' ? record.uri : undefined
      if (uri && isPrivatePostUri(uri)) {
        if (record.$type === 'app.bsky.embed.record#viewRecord') {
          out.set(uri, {uri, kind: 'view', record})
        } else if (
          record.$type === 'app.nearhorizon.private.defs#viewUnavailable'
        ) {
          const seconds = record.retryAfter
          out.set(uri, {
            uri,
            kind: 'unavailable',
            retryAfterMs:
              typeof seconds === 'number' && seconds >= 0
                ? seconds * 1000
                : undefined,
          })
        } else if (record.$type === 'app.bsky.embed.record#viewNotFound') {
          out.set(uri, {uri, kind: 'notFound'})
        }
      }
    }
    for (const key of Object.keys(value)) walk(value[key], depth + 1)
  }
  walk(body, 0)
  return Array.from(out.values())
}

/**
 * A served `#viewRecord` as the post view the quote cache holds: its value
 * converted as the adapter converts a quoted private post. `undefined` when
 * it does not convert.
 */
function viewRecordToPost(record: unknown): PostView | undefined {
  const embed = withConvertedQuotes({
    $type: 'app.bsky.embed.record#view',
    record,
  } as unknown as NonNullable<PostView['embed']>)
  const view = (embed as {record?: unknown}).record as
    | app.bsky.embed.record.ViewRecord
    | undefined
  const value = view?.value as {$type?: unknown} | undefined
  if (!view || value?.$type !== 'app.bsky.feed.post') return undefined
  const counts = view as {
    likeCount?: number
    repostCount?: number
    replyCount?: number
    quoteCount?: number
  }
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri: view.uri,
    cid: view.cid,
    author: view.author,
    record: view.value,
    indexedAt: view.indexedAt,
    labels: view.labels,
    ...(view.embeds?.[0] ? {embed: view.embeds[0]} : {}),
    ...(counts.likeCount !== undefined ? {likeCount: counts.likeCount} : {}),
    ...(counts.repostCount !== undefined
      ? {repostCount: counts.repostCount}
      : {}),
    ...(counts.replyCount !== undefined ? {replyCount: counts.replyCount} : {}),
    ...(counts.quoteCount !== undefined ? {quoteCount: counts.quoteCount} : {}),
  }
}

function writeQuote(
  queryClient: QueryClient,
  did: string,
  uri: string,
  value: QuoteData,
  seq: number,
): boolean {
  if (!verdictTakesEffect(did, uri, seq)) return false
  queryClient.setQueryData(privateQuoteQueryKey(uri), value)
  recordVerdict(did, uri, seq, value)
  return true
}

function cachedQuote(queryClient: QueryClient, uri: string) {
  return queryClient.getQueryData<QuoteData>(privateQuoteQueryKey(uri))
}

/**
 * Write prism's verdicts on the quotes of one answer into the quote cache
 * (6.3), before the page that carries them renders. These override any
 * cached value, unless a later-sent answer gave a verdict already:
 * - `#viewRecord`: the view (the serve itself is `noteServed`'s);
 * - `#viewUnavailable`: a signalled miss; another author's is the quiet card,
 *   held; the reader's own keeps its copy, labelled, or is the quiet card;
 * - prism's `#viewNotFound`: another author's is `null`, or the quiet card,
 *   held, in a degraded answer; the reader's own goes to the PDS check, kept
 *   until the PDS says it is gone.
 */
export function noteQuoteVerdicts(
  answer: Pick<AnswerContext, 'did' | 'seq' | 'degraded'>,
  verdicts: readonly QuoteVerdict[],
  queryClient: QueryClient | undefined = getCurrentClients()?.queryClient,
): void {
  const did = answer.did
  if (!did || !queryClient || verdicts.length === 0) return
  for (const verdict of verdicts) {
    const {uri} = verdict
    const own = isOwnPrivateUri(uri, did)
    const key = privateQuoteQueryKey(uri)
    if (verdict.kind === 'view') {
      const post = viewRecordToPost(verdict.record)
      if (post) writeQuote(queryClient, did, uri, toQuoteData(post), answer.seq)
      continue
    }
    if (verdict.kind === 'unavailable') {
      noteMiss(answer, uri, {
        signalled: true,
        retryAfterMs: verdict.retryAfterMs,
        skipPdsCheck: own,
      })
      if (own && isQuoteView(cachedQuote(queryClient, uri))) continue
      if (writeQuote(queryClient, did, uri, unavailableQuote(uri), answer.seq)) {
        hold(key, uri, queryClient, did)
      }
      continue
    }
    // prism's `#viewNotFound`.
    if (own) {
      const judged = noteMiss(answer, uri, {signalled: answer.degraded})
      if (judged === 'real') {
        writeQuote(queryClient, did, uri, null, answer.seq)
      } else if (!isQuoteView(cachedQuote(queryClient, uri))) {
        writeQuote(queryClient, did, uri, unavailableQuote(uri), answer.seq)
      }
      continue
    }
    if (answer.degraded) {
      noteMiss(answer, uri, {signalled: true})
      if (writeQuote(queryClient, did, uri, unavailableQuote(uri), answer.seq)) {
        hold(key, uri, queryClient, did)
      }
    } else {
      writeQuote(queryClient, did, uri, null, answer.seq)
    }
  }
}

/** A quote read: the views it served (the reader's pending posts included) and its answer. */
export type QuoteRead = {
  views: ReadonlyMap<string, PostView>
  answer: MergedAnswer
}

/**
 * A quote's value from one read (6.3), the shared `queryFn` of the quote
 * query, the page fetch and `readQuotes`. Served: the view. Left out, judged
 * by the registry: the reader's own suspect keeps `previous` (labelled
 * "Syncing") or is the quiet card, held; the reader's own the PDS says is gone
 * is `null`; another author's suspect is the quiet card, held, a success
 * value that replaces any copy; another author's otherwise is `null`. A read
 * sent before the URI's last verdict leaves `previous` as it is.
 */
export function quoteFromRead(
  uri: string,
  read: QuoteRead,
  previous: QuoteData | undefined,
  queryClient: QueryClient | undefined = getCurrentClients()?.queryClient,
): QuoteData {
  const {answer} = read
  const did = answer.did
  const seq = answer.seqOf(uri)
  const view = read.views.get(uri)
  if (!did) return toQuoteData(view)
  if (!verdictTakesEffect(did, uri, seq) && previous !== undefined) {
    return previous
  }
  const take = (value: QuoteData) => {
    recordVerdict(did, uri, seq, value)
    return value
  }
  if (view) return take(toQuoteData(view))
  const own = isOwnPrivateUri(uri, did)
  const listed = answer.unavailable.some(item => item.uri === uri)
  const verdict = noteMiss(answer, uri, {
    signalled: answer.degraded || listed,
    retryAfterMs: answer.retryAfterMs,
    skipPdsCheck: own && listed,
  })
  const keep = () => {
    if (queryClient) hold(privateQuoteQueryKey(uri), uri, queryClient, did)
  }
  if (own) {
    if (verdict === 'real') return take(null)
    keep()
    return take(isQuoteView(previous) ? (previous as QuoteData) : unavailableQuote(uri))
  }
  if (verdict === 'suspect') {
    keep()
    return take(unavailableQuote(uri))
  }
  return take(null)
}
