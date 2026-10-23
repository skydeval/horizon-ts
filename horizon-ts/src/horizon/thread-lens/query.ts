/*
 * The lens side of the stock thread query (Phase 4 design 7.1): its keys,
 * the `lens` object the hooks use, the reply mutator and the threadgate
 * writer.
 *
 * `createThreadLens` is pure: 4C's `useThreadLensRead` gives it the
 * availability (4B: `useThreadLensActive`, `useIsLensOnlyAnchor`), the
 * route's gap mark and the main entry's `runId`, read through
 * subscriptions (TL-34; `useLensRunId` here). With neither the lens active
 * nor the anchor lens-only, every member returns the stock value, so the
 * stock query runs as today.
 *
 * The lens keys have their own root (`horizon-thread-lens`), so no stock
 * finder or persister matches them, and no `persistedVersion`, so they live
 * for the session only. They are cast to the stock key types at the hook;
 * the stock types are not widened (R1-N9).
 */

import {useSyncExternalStore} from 'react'
import {
  hashKey,
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
} from '@tanstack/react-query'

import {
  dangerousGetPostShadow,
  updatePostShadow,
} from '#/state/cache/post-shadow'
import {
  LINEAR_VIEW_BELOW,
  TREE_VIEW_BELOW_DESKTOP,
} from '#/state/queries/usePostThread/const'
import {createCacheMutator} from '#/state/queries/usePostThread/queryCache'
import {
  type createPostThreadOtherQueryKey,
  createPostThreadQueryKey,
  type PostThreadParams,
} from '#/state/queries/usePostThread/types'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {THREAD_LENS} from '#/horizon/switches'
import {selectLensAnswer} from '#/horizon/thread-lens/adapt'
import {runLens} from '#/horizon/thread-lens/fetch'
import {type LensNode} from '#/horizon/thread-lens/nodes'
import {fetchLensOtherReplies} from '#/horizon/thread-lens/private-part'
import {hasLensGap} from '#/horizon/thread-lens/registry'
import {
  fallbackOf,
  heldSnapshotOf,
  LENS_ROOT,
  type LensQueryKey,
  lensQueryKey,
  runIdOf,
} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView
type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem
type OtherOutput = app.bsky.unspecced.getPostThreadOtherV2.$OutputBody
type StockKey = ReturnType<typeof createPostThreadQueryKey>
type StockOtherKey = ReturnType<typeof createPostThreadOtherQueryKey>

/**
 * The request depth for a view class (5.2): 10 in linear view, 6 in tree
 * view at every width. `select` cuts at the rendered bound.
 */
export function lensRequestDepth(view: 'tree' | 'linear'): number {
  return view === 'linear' ? LINEAR_VIEW_BELOW : TREE_VIEW_BELOW_DESKTOP
}

/** What decides a screen's lens keys (5.1, 7.1). */
export type ThreadLensInputs = {
  did: string | undefined
  anchor: string | undefined
  sort: string | undefined
  view: PostThreadParams['view']
  /** The rendered depth bound (from `view` and `gtPhone`). */
  below: number
  /** 5.1: the lens is active for this screen. */
  active: boolean
  /** 5.1: the anchor is lens-only (registry or mark). */
  lensOnly: boolean
  /** The lens gap mark, from the route only (TL-33). */
  marked: boolean
  /** With the lens not active: whether it is off or not served (11.3). */
  inactiveReason?: 'off' | 'not-served'
}

/**
 * The main lens key for `inputs`, or `undefined` when the lens is not
 * involved (the switch off, signed out, a private anchor, the lens neither
 * active nor the anchor lens-only).
 */
export function lensKeyFor(inputs: ThreadLensInputs): LensQueryKey | undefined {
  const {did, anchor, active, lensOnly} = inputs
  if (!THREAD_LENS || !did || !anchor || isPrivatePostUri(anchor)) {
    return undefined
  }
  if (!active && !lensOnly) return undefined
  return lensQueryKey({
    did,
    anchor,
    depth: lensRequestDepth(inputs.view),
    mode: active ? 'lens' : 'gap-only',
    marked: inputs.marked,
  })
}

/** The lens other-replies key (7.1; R2-N12): it carries the main `runId`. */
export function lensOtherKey(
  key: LensQueryKey,
  runId: string | undefined,
): QueryKey {
  const {did, anchor, depth} = key[1]
  return [LENS_ROOT, 'other', {did, anchor, depth, runId}]
}

/**
 * The main entry's `runId`, re-read on every cache change (7.1; v5:
 * R3-L1): a string snapshot, so cheap and stable.
 */
export function useLensRunId(
  qc: QueryClient,
  key: LensQueryKey | undefined,
): string | undefined {
  return useSyncExternalStore(
    callback => qc.getQueryCache().subscribe(callback),
    () => (key ? runIdOf(qc.getQueryData(key)) : undefined),
  )
}

/** The `lens` object of 7.1 (TH-1, TH-2, TH-14, TH-17, TH-18). */
export type ThreadLens = {
  /** The main lens key, when the lens is involved. */
  key: LensQueryKey | undefined
  queryKey: (stock: StockKey) => StockKey
  otherQueryKey: (stock: StockOtherKey) => StockOtherKey
  run: (
    ctx: Pick<QueryFunctionContext, 'queryKey' | 'signal'>,
    placeholder: unknown,
  ) => ReturnType<typeof runLens>
  select: <T>(data: T) => T
  otherReplies: (
    fetchStock: () => Promise<OtherOutput>,
    ctx?: Pick<QueryFunctionContext, 'signal'>,
  ) => Promise<OtherOutput>
  refetchOnReconnect: false | undefined
}

/** Build the `lens` object for one render's inputs. */
export function createThreadLens(
  qc: QueryClient,
  inputs: ThreadLensInputs,
  runId: string | undefined,
): ThreadLens {
  const key = lensKeyFor(inputs)
  const {sort, view, below} = inputs
  const queueId = key ? hashKey(key) : undefined
  return {
    key,
    queryKey: stock => (key ? (key as unknown as StockKey) : stock),
    otherQueryKey: stock =>
      key ? (lensOtherKey(key, runId) as unknown as StockOtherKey) : stock,
    run: (ctx, placeholder) =>
      runLens(ctx.queryKey, {
        qc,
        inactiveReason: inputs.inactiveReason,
        stockKey: createPostThreadQueryKey({
          anchor: inputs.anchor,
          sort: sort as PostThreadParams['sort'],
          view,
        }),
        readWith: {sort, below},
        placeholder: placeholder as {value: unknown} | undefined,
        signal: ctx.signal,
      }),
    select: data =>
      key ? selectLensAnswer(data, {sort, view, below, queueId}) : data,
    otherReplies: async (fetchStock, ctx) => {
      if (!key) return fetchStock()
      const data = qc.getQueryData(key)
      const snapshot = heldSnapshotOf(data)
      if (snapshot) {
        return fetchLensOtherReplies(snapshot, {
          did: key[1].did,
          sort,
          signal: ctx?.signal,
        })
      }
      // A fallback is a post anchor's stock thread, unless it became lens-only.
      const anchor = key[1].anchor
      const lensOnly =
        !isPrivatePostUri(anchor) &&
        (key[1].marked || hasLensGap(key[1].did, anchor))
      if (fallbackOf(data) && !lensOnly) return fetchStock()
      return {thread: []}
    },
    refetchOnReconnect: key ? false : undefined,
  }
}

/** A key that matches no entry, for the other-replies half (R2-N3). */
const NO_ENTRY_KEY = [LENS_ROOT, 'none'] as unknown as StockKey

type CacheMutator = ReturnType<typeof createCacheMutator>

/** The parent's reply count raised as stock does (`queryCache.ts`). */
function raiseReplyCount(qc: QueryClient, view: PostView) {
  const shadow = dangerousGetPostShadow(view)
  const count = (shadow?.optimisticReplyCount ?? view.replyCount ?? 0) + 1
  view.replyCount = count
  updatePostShadow(qc, view.uri, {optimisticReplyCount: count})
}

/**
 * The reply mutator in lens mode (TH-15): it reads the entry's data at
 * insert time. Outside a snapshot the stock mutator runs unchanged. On a
 * snapshot the stock main mutator, which spreads `data.thread`, never runs:
 * the replies join the snapshot as optimistic nodes under their parent,
 * whose count is raised as stock does, and a second stock mutator acts on
 * the lens other-replies entry only.
 */
export function withLensCacheMutator(
  stock: CacheMutator,
  {
    queryClient,
    postThreadQueryKey,
    postThreadOtherQueryKey,
    params,
  }: {
    queryClient: QueryClient
    postThreadQueryKey: StockKey
    postThreadOtherQueryKey: StockOtherKey
    params: Pick<PostThreadParams, 'view'> & {below: number}
  },
): CacheMutator {
  return {
    ...stock,
    insertReplies(parentUri: string, replies: ThreadItem[]) {
      const snapshot = THREAD_LENS
        ? heldSnapshotOf(queryClient.getQueryData(postThreadQueryKey))
        : undefined
      if (!snapshot) {
        stock.insertReplies(parentUri, replies)
        return
      }
      const parent = snapshot.nodes.get(parentUri)
      if (parent && parent.kind !== 'gap') {
        raiseReplyCount(queryClient, parent.view)
        const nodes = new Map(snapshot.nodes)
        let under = parentUri
        for (const reply of replies) {
          const view = (reply.value as {post?: PostView}).post
          if (!view?.uri) continue
          const node: LensNode = {
            kind: 'optimistic',
            uri: view.uri,
            parentUri: under,
            view,
          }
          if (!nodes.has(view.uri)) nodes.set(view.uri, node)
          under = view.uri
        }
        queryClient.setQueryData(postThreadQueryKey, {
          lens: {...snapshot, nodes},
        })
      }
      createCacheMutator({
        queryClient,
        postThreadQueryKey: NO_ENTRY_KEY,
        postThreadOtherQueryKey,
        params,
      }).insertReplies(parentUri, replies)
    },
  }
}

/**
 * The threadgate writer in lens mode (TH-16). On a snapshot it replaces
 * the anchor's held view once by `{...view, threadgate}`, a new object, and
 * carries the old object's shadow to it (v5: R3-N3); returns `true`, so the
 * stock `setQueryData` does not run. Otherwise `false`.
 */
export function writeLensThreadgate(
  qc: QueryClient,
  key: QueryKey,
  threadgate: app.bsky.feed.defs.ThreadgateView,
): boolean {
  if (!THREAD_LENS) return false
  const snapshot = heldSnapshotOf(qc.getQueryData(key))
  if (!snapshot) return false
  const anchor = snapshot.nodes.get(snapshot.anchor.prismAnchor)
  if (!anchor || anchor.kind === 'gap') return true
  const old = anchor.view
  const nodes = new Map(snapshot.nodes)
  nodes.set(anchor.uri, {...anchor, view: {...old, threadgate}})
  qc.setQueryData(key, {lens: {...snapshot, nodes}})
  updatePostShadow(qc, old.uri, dangerousGetPostShadow(old) ?? {})
  return true
}
