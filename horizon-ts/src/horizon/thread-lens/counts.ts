/*
 * The AppView's counts on a member's lens thread (2026-11-01).
 *
 * A member's post node renders from prism's view at once (the member skip,
 * `public-views.ts`), but prism's like, repost, reply and quote counts are
 * its own: Constellation's when it holds them, else a tally of what prism
 * indexed, which can be short (a reply count of 0 under a post with
 * replies, no likes on a liked post). So once the thread shows, the posts
 * drawn from prism's view are read again from the reader's AppView with
 * `getPosts`, off the path to the screen, and each takes the AppView's
 * counts and the reader's like, repost and bookmark state from that same
 * view, so a shadow's count change stays right. Everything else stays
 * prism's.
 *
 * The write lands on the entry's current snapshot only while it is the run
 * the read started on and no refetch is running, as a queued task's does
 * (`snapshot.ts`). Nodes a continuation adds later are patched when its
 * write lands, until {@link LENS_COUNTS_WAIT_MS}.
 */

import {type Client} from '@atproto/lex'
import {hashKey, type QueryClient, type QueryKey} from '@tanstack/react-query'

import {fetchPublicPosts} from '#/horizon/private/adapt/feed-view'
import {type LensNode} from '#/horizon/thread-lens/nodes'
import {carryLensShadow} from '#/horizon/thread-lens/shadow-carry'
import {heldSnapshotOf, type LensSnapshot} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

const COUNT_FIELDS = [
  'likeCount',
  'repostCount',
  'replyCount',
  'quoteCount',
  'bookmarkCount',
] as const

const VIEWER_FIELDS = ['like', 'repost', 'bookmarked'] as const

/** How long a refresh waits for the nodes it read to land. */
export const LENS_COUNTS_WAIT_MS = 30_000

/**
 * `view` with the counts and the reader's like, repost and bookmark state
 * of `from`, the AppView's view of the same post; `view` itself when
 * nothing differs.
 */
export function withAppViewCounts(view: PostView, from: PostView): PostView {
  const next: Record<string, unknown> = {...view}
  let changed = false
  for (const field of COUNT_FIELDS) {
    const value = from[field]
    if (typeof value === 'number' && value !== view[field]) {
      next[field] = value
      changed = true
    }
  }
  if (from.viewer) {
    const viewer: Record<string, unknown> = {...view.viewer}
    let viewerChanged = false
    for (const field of VIEWER_FIELDS) {
      if (from.viewer[field] === view.viewer?.[field]) continue
      if (from.viewer[field] === undefined) delete viewer[field]
      else viewer[field] = from.viewer[field]
      viewerChanged = true
    }
    if (viewerChanged) {
      next.viewer = viewer
      changed = true
    }
  }
  return changed ? (next as PostView) : view
}

/**
 * `snapshot` with the AppView's counts on its public post nodes `views`
 * holds (never a restored, private or optimistic node), and the URIs it
 * found; `next` is `undefined` when no view changed.
 */
export function patchLensCounts(
  snapshot: LensSnapshot,
  views: ReadonlyMap<string, PostView>,
): {next: LensSnapshot | undefined; found: string[]} {
  const found: string[] = []
  let nodes: Map<string, LensNode> | undefined
  for (const [uri, from] of views) {
    const node = snapshot.nodes.get(uri)
    if (!node || node.kind !== 'post' || node.restored) continue
    found.push(uri)
    const view = withAppViewCounts(node.view, from)
    if (view === node.view) continue
    carryLensShadow(node.view, view)
    nodes ??= new Map(snapshot.nodes)
    nodes.set(uri, {...node, view})
  }
  return {next: nodes ? {...snapshot, nodes} : undefined, found}
}

/**
 * Read `uris` from the AppView and put their counts on the lens entry
 * `queryKey` while it holds run `runId` (see the file comment). Never
 * throws; a failed read leaves prism's counts.
 */
export async function refreshLensCounts({
  qc,
  queryKey,
  runId,
  appview,
  uris,
}: {
  qc: QueryClient
  queryKey: QueryKey
  runId: string
  appview: Client
  uris: readonly string[]
}): Promise<void> {
  if (uris.length === 0) return
  let views: Map<string, PostView>
  try {
    views = await fetchPublicPosts(appview, uris)
  } catch {
    return
  }
  if (views.size === 0) return
  const pending = new Map(views)
  const hash = hashKey(queryKey)

  /** Patch what has landed; whether the refresh is over. */
  function apply(): boolean {
    const query = qc.getQueryCache().get(hash)
    if (!query) return true
    const fetching = query.state.fetchStatus === 'fetching'
    const current = heldSnapshotOf(query.state.data)
    // Another run's snapshot: wait while a run is in flight (it may be ours).
    if (!current || current.runId !== runId) return !fetching
    // A refetch started over this run: its own read brings counts.
    if (fetching) return true
    const {next, found} = patchLensCounts(current, pending)
    for (const uri of found) pending.delete(uri)
    if (next) qc.setQueryData(queryKey, {lens: next})
    return pending.size === 0
  }

  if (apply()) return
  await new Promise<void>(resolve => {
    let over = false
    const finish = () => {
      if (over) return
      over = true
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(finish, LENS_COUNTS_WAIT_MS)
    const unsubscribe = qc.getQueryCache().subscribe(event => {
      if (over || event.query.queryHash !== hash) return
      // Out of the cache's own notification, which the write would re-enter.
      void Promise.resolve().then(() => {
        if (!over && apply()) finish()
      })
    })
  })
}
