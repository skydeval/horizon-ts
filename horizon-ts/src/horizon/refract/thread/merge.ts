/*
 * RF-B5b (refract client design 4.2 steps 2 and 3): the thread hook's merge
 * of restored replies, the reader's own replies under restored parents and
 * the filled hidden parents and root into the stock thread, on read, right
 * after `useThreadBusy`'s gating. Stock paints alone; a refetch of any input
 * re-merges with no `setQueryData`.
 *
 * The "lens active" skip (Thread Lens 4C's seam): the merge, and every
 * request feeding it, runs only for a `stock` answer under a stock key, or
 * a `fallback` (the stock thread of a post anchor) whose anchor is not
 * lens-only. A `snapshot` already carries restored nodes (S-15); `gap-only`,
 * `unverified` and `placeholder` under a lens key never merge. On top of
 * that no URI the lens has drawn as a gap (its registry, TL-25) and no
 * private URI is ever sent to Refract: a root or hidden parent that is one
 * is left out, so no gap URI reaches prism's Refract methods.
 */

import {useMemo, useSyncExternalStore} from 'react'
import {useQuery} from '@tanstack/react-query'

import {isPrivatePostUri} from '#/horizon/private/uri'
import {useRefractActive} from '#/horizon/refract/gate'
import {
  ownRestoredReplies,
  peekRestoredPost,
  restoredStoreGlobalVersion,
  subscribeRestoredStore,
} from '#/horizon/refract/store'
import {
  fillHiddenParents,
  REFRACT_REPLIES_GC_MS,
  REFRACT_REPLIES_STALE_MS,
  useRefractRepliesQuery,
} from '#/horizon/refract/thread/replies-query'
import {
  type SpliceInputs,
  spliceRestoredReplies,
} from '#/horizon/refract/thread/splice'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {
  hasLensGap,
  lensRegistryVersion,
  subscribeLensRegistry,
} from '#/horizon/thread-lens/registry'
import {type app} from '#/lexicons'

type ThreadItem = app.bsky.unspecced.getPostThreadV2.ThreadItem
type PostView = app.bsky.feed.defs.PostView

const POST = 'app.bsky.unspecced.defs#threadItemPost'
const NOT_FOUND = 'app.bsky.unspecced.defs#threadItemNotFound'

/** The hidden parents' query root (4.2 step 3). Not persisted. */
export const REFRACT_PARENTS_ROOT = 'refract-parents'

/**
 * Whether RF-B5b merges for a thread answer (the seam): `stock` under a
 * stock key, or a `fallback` whose anchor is not lens-only. Everything else
 * under a lens key is skipped.
 */
export function refractMergeAllowed({
  kind,
  lensKey,
  lensOnly,
}: {
  /** `threadLensState(...).kind`. */
  kind: string
  /** The thread is read under a lens key. */
  lensKey: boolean
  /** The anchor is lens-only (registry or mark). */
  lensOnly: boolean
}): boolean {
  if (lensOnly) return false
  if (kind === 'stock') return !lensKey
  return kind === 'fallback'
}

type ReplyRef = {parent?: {uri?: unknown}; root?: {uri?: unknown}}

function replyOf(post: PostView | undefined): ReplyRef | undefined {
  const reply = (post?.record as {reply?: unknown} | undefined)?.reply
  return typeof reply === 'object' && reply !== null ? reply : undefined
}

function uriOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The anchor's post in `thread`, when stock shows it as a post. */
export function anchorPostOf(
  thread: readonly ThreadItem[],
  anchor: string | undefined,
): PostView | undefined {
  if (!anchor) return undefined
  const item = thread.find(entry => entry.uri === anchor)
  const value = item?.value as {$type?: string; post?: PostView} | undefined
  return value?.$type === POST ? value.post : undefined
}

/**
 * The thread's root (4.2 step 2): the anchor's `record.reply.root`, read
 * from whatever shows it (the cached placeholder while it shows, then
 * stock's answer), else the anchor itself when it is top-level.
 */
export function threadRootOf(
  thread: readonly ThreadItem[],
  anchor: string | undefined,
): string | undefined {
  const post = anchorPostOf(thread, anchor)
  if (!post) return undefined
  const reply = replyOf(post)
  if (!reply) return anchor
  return uriOf(reply.root?.uri)
}

/**
 * The anchor's parent and root URIs that stock shows as
 * `threadItemNotFound` (4.2 step 3), in that order, deduped.
 */
export function hiddenParentUris(
  thread: readonly ThreadItem[],
  anchor: string | undefined,
): string[] {
  const reply = replyOf(anchorPostOf(thread, anchor))
  if (!reply) return []
  const notFound = new Set(
    thread
      .filter(item => item.value.$type === NOT_FOUND)
      .map(item => item.uri as string),
  )
  const out: string[] = []
  for (const uri of [uriOf(reply.parent?.uri), uriOf(reply.root?.uri)]) {
    if (uri && notFound.has(uri) && !out.includes(uri)) out.push(uri)
  }
  return out
}

/** A URI that may go to Refract: not private, not a lens gap for `did`. */
export function sendableToRefract(
  did: string | undefined,
  uri: string | undefined,
): uri is string {
  return !!uri && !isPrivatePostUri(uri) && !hasLensGap(did, uri)
}

const NO_POSTS: readonly PostView[] = []

/**
 * The thread with the restored inputs merged in (RF-B5b). Returns `thread`
 * itself when the merge is skipped, Refract is not active, or there is
 * nothing to merge.
 */
export function useRestoredThreadMerge({
  anchor,
  thread,
  allowed,
  isPlaceholderData,
  below,
  branchingFactor,
  sort,
}: {
  anchor: string | undefined
  /** The gated stock thread (`useThreadBusy`'s `thread`). */
  thread: ThreadItem[]
  /** {@link refractMergeAllowed}. */
  allowed: boolean
  /** Placeholder data shows: the inputs are asked for, not yet merged. */
  isPlaceholderData: boolean
  below: number
  /** Stock's branching factor; `undefined` (tree view) is unlimited. */
  branchingFactor: number | undefined
  sort: string | undefined
}): ThreadItem[] {
  const did = useCurrentClients()?.did
  const active = useRefractActive()
  // A gap drawn later must stop requests for its URI (TL-25).
  const registry = useSyncExternalStore(
    subscribeLensRegistry,
    lensRegistryVersion,
  )
  const storeVersion = useSyncExternalStore(
    subscribeRestoredStore,
    restoredStoreGlobalVersion,
  )
  const base = allowed && active && !!anchor && sendableToRefract(did, anchor)

  const root = threadRootOf(thread, anchor)
  const repliesRoot = base && sendableToRefract(did, root) ? root : undefined
  const replies = useRefractRepliesQuery(base ? anchor : undefined, repliesRoot)

  const parentUris = useMemo(() => {
    void registry
    return hiddenParentUris(thread, anchor).filter(uri =>
      sendableToRefract(did, uri),
    )
  }, [thread, anchor, did, registry])
  const parents = useQuery({
    queryKey: [REFRACT_PARENTS_ROOT, did ?? '', ...parentUris],
    enabled: base && parentUris.length > 0,
    staleTime: REFRACT_REPLIES_STALE_MS,
    gcTime: REFRACT_REPLIES_GC_MS,
    queryFn: () => fillHiddenParents(parentUris),
  })

  const repliesData = base && repliesRoot ? replies.data?.posts : undefined
  const parentsData = base && parentUris.length > 0 ? parents.data : undefined

  return useMemo(() => {
    void storeVersion
    if (!base || isPlaceholderData) return thread
    // The store's current object for each post, so shadows reach it.
    const current = (post: PostView) => peekRestoredPost(post.uri) ?? post
    const inputs: SpliceInputs = {
      replies: (repliesData ?? NO_POSTS).map(current),
      ownReplies: ownRestoredReplies(),
      parents: (parentsData ?? NO_POSTS).map(current),
    }
    if (
      inputs.replies.length === 0 &&
      inputs.ownReplies.length === 0 &&
      inputs.parents.length === 0
    ) {
      return thread
    }
    return spliceRestoredReplies(thread, inputs, {
      below,
      branchingFactor: branchingFactor ?? Infinity,
      sort,
    })
  }, [
    base,
    isPlaceholderData,
    thread,
    repliesData,
    parentsData,
    storeVersion,
    below,
    branchingFactor,
    sort,
  ])
}
