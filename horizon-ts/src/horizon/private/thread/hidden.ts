/*
 * Hidden replies behind the stock "Show more replies" (hidden replies design
 * 4 to 6).
 *
 * prism leaves a reply the thread root's gate hides out of `getPostThread`
 * and `getReplies` for everyone but its author, and keeps serving it on
 * `getPosts`. The thread read takes the gate's private URIs it did not serve
 * as candidates (4.2, 5.3, 5.4), and, on a confirmed read, prefetches them in
 * the background (6.2): one `getPosts` read of the 50 newest, the direct
 * replies of the anchor kept, adapted and tagged with the answer's arrival
 * (6.1). The prefetch's answer corrects the row (6.4); the tap reads it from
 * the cache (6.3), so it shows with no call.
 *
 * Kept apart from `fetch.ts`, which imports it; it imports nothing of
 * `fetch.ts` at run time.
 */

import {type Client} from '@atproto/lex'
import {type QueryClient, type QueryKey} from '@tanstack/react-query'

import {logger} from '#/logger'
import {adaptPosts, readReplyRefs} from '#/horizon/private/adapt/feed-view'
import {getPrivatePostsAnswered} from '#/horizon/private/api/reads'
import {heldPostRefetchInterval, isOwnPrivateUri} from '#/horizon/private/known'
import {fetchStamp} from '#/horizon/private/load-gate'
import {
  getReplyContinuation,
  type ReplyContinuation,
  setReplyContinuation,
} from '#/horizon/private/thread/continuation'
import {type TreeNode} from '#/horizon/private/thread/fetch'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {isPrismConfirmed} from '#/horizon/routing/health'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

type PostView = app.bsky.feed.defs.PostView

/** How many candidates the prefetch asks, the newest (6.5). */
export const HIDDEN_PREFETCH_LIMIT = 50

/** The most candidates a thread keeps: a threadgate's `hiddenReplies` cap. */
export const MAX_HIDDEN_CANDIDATES = 300

/**
 * The URIs a thread's `threadgate` view hides: `record.hiddenReplies` when
 * the record is a threadgate, else none.
 */
export function threadgateHiddenReplies(
  view: {record?: unknown} | undefined,
): string[] {
  const record = view?.record
  if (!bsky.isType(app.bsky.feed.threadgate, record)) return []
  return (record.hiddenReplies ?? []).map(String)
}

/**
 * The candidate hidden replies (4.2, 5.3): the URIs of `hidden` that are
 * private posts, not the reader's own (their author sees them inline) and
 * not already among `thread`'s items. At most
 * {@link MAX_HIDDEN_CANDIDATES}, the newest kept.
 */
export function hiddenCandidates(
  hidden: readonly string[],
  thread: readonly {uri: string}[],
  did: string,
): string[] {
  const inThread = new Set(thread.map(item => item.uri))
  const out: string[] = []
  const seen = new Set<string>()
  for (const uri of hidden) {
    if (seen.has(uri)) continue
    seen.add(uri)
    if (!isPrivatePostUri(uri) || isOwnPrivateUri(uri, did)) continue
    if (inThread.has(uri)) continue
    out.push(uri)
  }
  return out.slice(-MAX_HIDDEN_CANDIDATES)
}

/** What a read's answer carries of its continuation (4.2). */
export type ContinuationKeyed = {horizonContinuation?: string}

/**
 * The continuation key a thread's or the further replies' data was read
 * under; `''` for none (a stock thread, a placeholder).
 */
export function continuationKeyOf(data: unknown): string {
  const key = (data as ContinuationKeyed | undefined)?.horizonContinuation
  return typeof key === 'string' ? key : ''
}

/** The thread `queryFn`'s line carrying the key into its result (4.2). */
export function continuationOf(data: unknown): ContinuationKeyed {
  return {horizonContinuation: continuationKeyOf(data)}
}

/**
 * The further replies without a reply the thread already holds (4.4): a
 * backstop for anything that puts one reply in both lists, which keeps the
 * list's keys unique.
 */
export function withoutThreadItems<I extends {uri: string}>(
  other: readonly I[],
  thread: readonly {uri: string}[],
): I[] {
  if (thread.length === 0) return [...other]
  const inThread = new Set(thread.map(item => item.uri))
  return other.filter(item => !inThread.has(item.uri))
}

/** The query root of the hidden read; Horizon's own, never walked by stock. */
export const HIDDEN_REPLIES_KEY_ROOT = 'horizon-private-hidden-replies'

/**
 * The hidden read's key (6.2): the account, the anchor and the whole
 * candidate list in order (HR3-N1, HR4-N1).
 */
export function hiddenRepliesKey(
  did: string,
  anchor: string,
  candidates: readonly string[],
): QueryKey {
  return [HIDDEN_REPLIES_KEY_ROOT, did, anchor, [...candidates]]
}

/**
 * The hidden read's answer (6.1): `candidates` the whole list its key
 * carries, `asked` the part read, `nodes` the anchor's direct replies served
 * (leaves), `views` their adapted views tagged with `stamp`, the `getPosts`
 * answer's arrival.
 */
export type HiddenAnswer = {
  candidates: string[]
  asked: string[]
  nodes: TreeNode[]
  views: Map<string, PostView>
  direct: number
  readAll: boolean
  stamp: number
}

/** The clients a hidden read uses. */
export type HiddenClients = {prismClient: Client; appviewClient: Client}

/**
 * Read `asked` (of `candidates`) with `getPosts` (6.1): keep the views whose
 * parent is `anchorUri`, as leaf nodes, adapt them here (author merge and
 * embed context, `cidOf` giving the anchor's cid) and tag each adapted view
 * with the answer's arrival. A URI left out is simply absent; nothing of it
 * renders, so no omission is noted. Throws as `getPosts` does.
 */
export async function readHiddenReplies(
  clients: HiddenClients,
  anchorUri: string,
  candidates: readonly string[],
  asked: readonly string[],
  cidOf: (uri: string) => string | undefined,
): Promise<HiddenAnswer> {
  const {posts} =
    asked.length > 0
      ? await getPrivatePostsAnswered(clients.prismClient, asked)
      : {posts: []}
  const stamp = fetchStamp()
  const nodes: TreeNode[] = []
  const kept = new Set<string>()
  for (const view of posts) {
    if (kept.has(view.uri)) continue
    if (readReplyRefs(view.record)?.parent.uri !== anchorUri) continue
    kept.add(view.uri)
    nodes.push({input: {view}, replies: []})
  }
  const views = new Map<string, PostView>()
  if (nodes.length > 0) {
    const cids = new Map(
      nodes.map(node => [node.input.view.uri, node.input.view.cid]),
    )
    const adapted = await adaptPosts(
      nodes.map(node => node.input),
      clients.appviewClient,
      uri => cids.get(uri) ?? cidOf(uri),
    )
    for (const [uri, view] of adapted.views) {
      views.set(uri, {...view, horizonFromCache: stamp} as PostView)
    }
  }
  return {
    candidates: [...candidates],
    asked: [...asked],
    nodes,
    views,
    direct: nodes.length,
    readAll: asked.length >= candidates.length,
    stamp,
  }
}

function prefetchQueryFn(
  clients: HiddenClients,
  anchorUri: string,
  candidates: readonly string[],
  cidOf: (uri: string) => string | undefined,
) {
  return () =>
    readHiddenReplies(
      clients,
      anchorUri,
      candidates,
      candidates.slice(-HIDDEN_PREFETCH_LIMIT),
      cidOf,
    )
}

/**
 * The cached hidden answer for these candidates, if any (4.2's first guess,
 * 5.3).
 */
export function cachedHiddenAnswer(
  client: QueryClient | undefined,
  did: string,
  anchor: string,
  candidates: readonly string[],
): HiddenAnswer | undefined {
  if (!client || candidates.length === 0) return undefined
  return client.getQueryData<HiddenAnswer>(
    hiddenRepliesKey(did, anchor, candidates),
  )
}

/**
 * Whether the hidden part leaves something behind the row, from an answer
 * (6.4): a direct reply served, or candidates it did not ask.
 */
export function answerHasHidden(answer: HiddenAnswer): boolean {
  return answer.direct > 0 || !answer.readAll
}

/**
 * `paging` narrowed by an answer that read every candidate (6.4, HR1-N2):
 * with counts served (`unserved`, the anchor's `replyCount` less the direct
 * replies served), a gap made only of hidden direct replies pages nothing.
 */
export function narrowedPages(
  paging: boolean,
  unserved: number | undefined,
  answer: HiddenAnswer | undefined,
): boolean {
  if (!paging || !answer?.readAll || unserved === undefined) return paging
  return unserved > answer.direct
}

/**
 * The prefetch's start test when the read starts (6.2): prism confirmed, and
 * the anchor not a suspect (the suspect clock's reads never start one).
 */
export function hiddenPrefetchAllowed(did: string, anchor: string): boolean {
  return isPrismConfirmed(did) && heldPostRefetchInterval(anchor, did) === false
}

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((uri, i) => uri === b[i])
}

/**
 * The row corrected by an answer (6.4), only when its candidates are the
 * anchor's current continuation's: on a private anchor that read every
 * candidate, `pages` narrowed (the continuation's `key` left as written),
 * and the thread's `hasOtherReplies` written through a spread, which keeps
 * its stamp and its key.
 */
function correctRow(
  client: QueryClient,
  threadKey: QueryKey,
  anchor: string,
  answer: HiddenAnswer,
  unserved: number | undefined,
) {
  const continuation = getReplyContinuation(anchor)
  if (!continuation || !sameList(continuation.hidden, answer.candidates)) {
    return
  }
  const pages =
    continuation.kind === 'private'
      ? narrowedPages(continuation.pages, unserved, answer)
      : continuation.pages
  if (pages !== continuation.pages) {
    setReplyContinuation(anchor, {...continuation, pages})
  }
  const hasOtherReplies =
    pages || continuation.stockHasOther || answerHasHidden(answer)
  client.setQueryData<{hasOtherReplies?: boolean}>(threadKey, data =>
    data ? {...data, hasOtherReplies} : data,
  )
}

/**
 * Start the prefetch for `candidates` (6.2), not awaited: one query per
 * candidate list, joined by key while in flight. Its answer corrects the row
 * of the thread query `threadKey`; its failure is only logged.
 */
export function prefetchHiddenReplies({
  client,
  threadKey,
  clients,
  did,
  anchor,
  anchorUri,
  candidates,
  cidOf,
  unserved,
}: {
  client: QueryClient
  threadKey: QueryKey
  clients: HiddenClients
  did: string
  anchor: string
  anchorUri: string
  candidates: readonly string[]
  cidOf: (uri: string) => string | undefined
  /** The anchor's direct replies left unserved by its counts, if served. */
  unserved: number | undefined
}) {
  if (candidates.length === 0) return
  void client
    .fetchQuery({
      queryKey: hiddenRepliesKey(did, anchor, candidates),
      queryFn: prefetchQueryFn(clients, anchorUri, candidates, cidOf),
      staleTime: 0,
    })
    .then(answer => correctRow(client, threadKey, anchor, answer, unserved))
    .catch((error: unknown) => {
      logger.warn('hidden replies: prefetch failed', {safeMessage: error})
    })
}

/**
 * The hidden replies for the tap (6.3): the cached answer of the
 * continuation's candidates when it is at least as new as the continuation,
 * else the read in flight on that key, else a new one; past the 50 the
 * answer asked, the rest read once outside the cache (HR4-N1). Leaf nodes and
 * their adapted, tagged views. Throws as the reads do.
 */
export async function ensureHidden(
  client: QueryClient,
  clients: HiddenClients,
  did: string,
  anchor: string,
  continuation: ReplyContinuation,
): Promise<{nodes: TreeNode[]; views: Map<string, PostView>}> {
  const candidates = continuation.hidden
  const cidOf = (uri: string) => continuation.cids.get(uri)
  const queryKey = hiddenRepliesKey(did, anchor, candidates)
  const cached = client.getQueryData<HiddenAnswer>(queryKey)
  const answer =
    cached && cached.stamp >= continuation.readAt
      ? cached
      : await client.fetchQuery({
          queryKey,
          queryFn: prefetchQueryFn(
            clients,
            continuation.anchorUri,
            candidates,
            cidOf,
          ),
          staleTime: 0,
        })
  if (answer.readAll) return {nodes: answer.nodes, views: answer.views}
  const asked = new Set(answer.asked)
  const rest = await readHiddenReplies(
    clients,
    continuation.anchorUri,
    candidates,
    candidates.filter(uri => !asked.has(uri)),
    cidOf,
  )
  const nodes = [...answer.nodes]
  const have = new Set(nodes.map(node => node.input.view.uri))
  const views = new Map(answer.views)
  for (const node of rest.nodes) {
    const uri = node.input.view.uri
    if (have.has(uri)) continue
    have.add(uri)
    nodes.push(node)
    const view = rest.views.get(uri)
    if (view) views.set(uri, view)
  }
  return {nodes, views}
}
