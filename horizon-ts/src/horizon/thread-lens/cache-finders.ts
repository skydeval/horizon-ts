/*
 * The lens entries for the stock post and profile shadows (Phase 4 design
 * 7.7, TL-24) and the thread placeholder search (R2-N13). The lens keys
 * have their own root, so the stock thread finders never see them; these
 * three are yielded from the stock finders by hooks TH-12, TH-13 and TH-21.
 *
 * They walk the snapshot (each post, private and optimistic node's held
 * view), never the built items, and the snapshot holds gap nodes, not
 * placeholder views (TL-8). A stock-shaped entry (a fallback, the lens
 * other-replies list) is walked as the stock finder walks a thread. As a
 * defence, any post with an empty `cid` is skipped, with its author, so a
 * placeholder never becomes a shadow target or a profile.
 */

import {AtUri} from '@atproto/syntax'
import {type QueryClient} from '@tanstack/react-query'

import {type ValidFeedPostNumbering} from '#/lib/api/feed-manip'
import {postViewToThreadPlaceholder} from '#/state/queries/usePostThread/views'
import {
  didOrHandleUriMatches,
  embedViewRecordToPostView,
  getEmbeddedPost,
} from '#/state/queries/util'
import {THREAD_LENS} from '#/horizon/switches'
import {viewOf} from '#/horizon/thread-lens/nodes'
import {LENS_ROOT, snapshotOf} from '#/horizon/thread-lens/snapshot'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

/*
 * The stock threadgate updater's lens writer (TH-16), so `queryCache.ts` has
 * one Thread Lens import, of light modules only.
 */
export {writeLensThreadgate} from '#/horizon/thread-lens/threadgate'

type PostView = app.bsky.feed.defs.PostView
type ProfileViewBasic = app.bsky.actor.defs.ProfileViewBasic

/** Every post view a lens entry holds, placeholders and empty cids left out. */
function* heldViews(data: unknown): Generator<PostView, void> {
  const snapshot = snapshotOf(data)
  if (snapshot) {
    for (const node of snapshot.nodes.values()) {
      const view = viewOf(node)
      if (view && view.cid !== '') yield view
    }
    return
  }
  const thread = (data as {thread?: unknown} | undefined)?.thread
  if (!Array.isArray(thread)) return
  for (const item of thread as {value?: unknown}[]) {
    if (!bsky.isType(app.bsky.unspecced.defs.threadItemPost, item.value)) {
      continue
    }
    if (item.value.post.cid !== '') yield item.value.post
  }
}

function* lensEntries(queryClient: QueryClient) {
  // With the switch off the stock finders are stock (12.1).
  if (!THREAD_LENS) return
  for (const [, data] of queryClient.getQueriesData({queryKey: [LENS_ROOT]})) {
    if (data !== undefined) yield data
  }
}

/** Every held lens view (and quoted post) whose URI is `uri` (TH-12). */
export function* findLensPosts(
  queryClient: QueryClient,
  uri: string,
): Generator<PostView, void> {
  const atUri = new AtUri(uri)
  for (const data of lensEntries(queryClient)) {
    for (const view of heldViews(data)) {
      if (didOrHandleUriMatches(atUri, view)) yield view
      const quoted = getEmbeddedPost(view.embed)
      if (quoted && quoted.cid !== '' && didOrHandleUriMatches(atUri, quoted)) {
        yield embedViewRecordToPostView(quoted)
      }
    }
  }
}

/** Every held lens profile whose DID is `did` (TH-13). */
export function* findLensProfiles(
  queryClient: QueryClient,
  did: string,
): Generator<ProfileViewBasic, void> {
  for (const data of lensEntries(queryClient)) {
    for (const view of heldViews(data)) {
      if (view.author.did === did) yield view.author
      for (const actor of view.viewer?.knownLikers?.actors ?? []) {
        if (actor.did === did) yield actor
      }
      const quoted = getEmbeddedPost(view.embed)
      if (quoted && quoted.cid !== '' && quoted.author.did === did) {
        yield quoted.author
      }
    }
  }
}

/**
 * The thread placeholder candidates the lens holds for `uri` (TH-21): held
 * public, private and optimistic views only, never a placeholder.
 */
export function* findLensPlaceholderCandidates(
  queryClient: QueryClient,
  uri: string,
  postNumbering?: ValidFeedPostNumbering,
) {
  for (const post of findLensPosts(queryClient, uri)) {
    yield postViewToThreadPlaceholder(post, postNumbering)
  }
}
