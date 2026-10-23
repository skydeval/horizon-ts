/*
 * The thread's dropped replies and hidden parents (refract client design 4.2
 * steps 2 and 3, RF-B5b). These are the inputs `spliceRestoredReplies`
 * merges on read.
 *
 * - `useRefractRepliesQuery(anchor, root)`: its own query,
 *   `['refract-replies', did, root]`, 60 s stale, 10 min gc, one
 *   `refract.getReplies` per root (prism selects by `root`; the anchor is
 *   still sent). A background call for the open screen. A failure, or the
 *   background deadline, leaves the stock thread as it is and isn't retried
 *   over data. Its posts go through the restored-post store, so every
 *   surface renders the same objects.
 * - `fillHiddenParents(uris)`: the parent and root URIs stock shows as
 *   `threadItemNotFound`, in one `fill` (their authors in `dids`).
 *
 * Not yet called by the thread hook: the merge waits on Thread Lens 4C,
 * which owns the same hook (13, RF-B5b).
 */

import {useQuery} from '@tanstack/react-query'

import {refractCall} from '#/horizon/refract/api'
import {askFill} from '#/horizon/refract/fill'
import {REFRACT_REPLIES_ROOT} from '#/horizon/refract/finders'
import {refractActive, useRefractActive} from '#/horizon/refract/gate'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {putRestoredPost} from '#/horizon/refract/store'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

export const REFRACT_REPLIES_STALE_MS = 60_000
export const REFRACT_REPLIES_GC_MS = 10 * 60_000

/** The query key of one root's dropped replies. */
export function refractRepliesKey(did: string | undefined, root: string) {
  return [REFRACT_REPLIES_ROOT, did ?? '', root]
}

/** One root's dropped replies, through the store (4.2 step 2). */
export async function fetchRefractReplies(
  anchor: string,
  root: string,
): Promise<{posts: PostView[]}> {
  const answer = await refractCall<{posts?: unknown}>(
    REFRACT_METHODS.getReplies,
    {anchor, root},
    {foreground: false, screen: true},
  )
  const posts = Array.isArray(answer.body.posts)
    ? (answer.body.posts as PostView[]).filter(
        post => typeof post?.uri === 'string',
      )
    : []
  return {
    posts: posts.map(post =>
      putRestoredPost(post, {stale: answer.lateVisitor}),
    ),
  }
}

/**
 * The dropped replies of `root`'s thread, enabled once `root` is known
 * (the placeholder's `record.reply.root`, else stock's answer, else the
 * anchor itself when it is top-level).
 */
export function useRefractRepliesQuery(
  anchor: string | undefined,
  root: string | undefined,
) {
  const did = useCurrentClients()?.did
  const active = useRefractActive()
  return useQuery({
    queryKey: refractRepliesKey(did, root ?? ''),
    enabled: active && !!anchor && !!root,
    staleTime: REFRACT_REPLIES_STALE_MS,
    gcTime: REFRACT_REPLIES_GC_MS,
    queryFn: () => fetchRefractReplies(anchor!, root!),
  })
}

/**
 * The hidden parent and root posts stock shows as not found, from one
 * `fill` (4.2 step 3). Positive posts land in the store; the rest are left
 * as stock shows them.
 */
export async function fillHiddenParents(
  uris: readonly string[],
): Promise<PostView[]> {
  if (!refractActive() || uris.length === 0) return []
  const outcome = await askFill(
    {uris},
    {kind: 'slot', foreground: false, screen: true},
  )
  const posts: PostView[] = []
  for (const uri of uris) {
    const verdict = outcome.uris.get(uri)
    if (verdict?.kind === 'positive') posts.push(verdict.post)
  }
  return posts
}
