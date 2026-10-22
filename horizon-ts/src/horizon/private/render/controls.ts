/*
 * Which stock controls and display pieces a private post keeps (design 7.3 to
 * 7.7). A plain module, so it can be tested without the design system.
 *
 * Every answer is the stock one unless `PRIVATE_POST_DISPLAY` is on and the
 * URI is a private post's. What prism serves moves a private post from its
 * interim behaviour to the stock one: counts by the post's facts (data, 2H
 * design 2.4), gates and thread mutes by prism's feature list (4.2). The
 * feature reads here are snapshots: the components re-render with the data a
 * feature change refetches (4.6), and menus are mounted when opened.
 */

import {
  privateGatesServed,
  privateInteractionsServed,
} from '#/horizon/private/server-support'
import {
  getPendingPost,
  getPrivatePostFacts,
  pendingPhase,
} from '#/horizon/private/store'
import {isPrivatePostPath, isPrivatePostUri} from '#/horizon/private/uri'
import {PRIVATE_POST_DISPLAY} from '#/horizon/switches'

/**
 * Whether the post at `uri` is displayed as a private post: its mark, and no
 * public-only machinery (threadgates, postgates, reporting, who can reply).
 */
export function isPrivateDisplay(uri: string | undefined): boolean {
  return PRIVATE_POST_DISPLAY && isPrivatePostUri(uri)
}

/**
 * Whether the post at `uri` (or its thread root) is still being sent, or
 * failed, in the outbox (2K design PA-28 step 3, K10-L3): its gates are the
 * outbox's to write. Asked of the current account's pending posts, whose
 * thread is on screen (K11-N2).
 */
export function isPendingUnwritten(uri: string | undefined): boolean {
  if (!uri) return false
  const entry = getPendingPost(uri)
  return !!entry && pendingPhase(entry) !== 'written'
}

/**
 * Whether the stock controls that read a served threadgate are left out on
 * the post at `uri` whose thread root is `rootUri` (Anchor 2's who can
 * reply, Menu 3's hide reply for everyone): on a private post unless prism
 * applies the gates (`private.gates`, P-18) and the root is private (prism
 * applies only gates of private posts, so a private reply in a branch under
 * a public root keeps the interim behaviour). `forWrite` for Menu 3, whose
 * item writes a gate (4.7). Also on a post (or root) whose pending entry is
 * `sending` or `failed` (2K design K10-L3).
 */
export function hidesGateControls(
  uri: string | undefined,
  rootUri: string | undefined = uri,
  {forWrite = false}: {forWrite?: boolean} = {},
): boolean {
  if (
    isPrivateDisplay(uri) &&
    (isPendingUnwritten(uri) || isPendingUnwritten(rootUri))
  ) {
    return true
  }
  return (
    isPrivateDisplay(uri) &&
    (!privateGatesServed({forWrite}) || !isPrivatePostUri(rootUri))
  )
}

/**
 * Whether Menu 3's detach quote is left out on the private post at
 * `postUri` quoting `quotedUri`: prism detaches private quoting posts of
 * private posts only, once the gates are answered in this run.
 */
export function hidesDetachQuote(
  postUri: string | undefined,
  quotedUri: string | undefined,
): boolean {
  return (
    isPrivateDisplay(postUri) &&
    (!privateGatesServed({forWrite: true}) || !isPrivatePostUri(quotedUri))
  )
}

/**
 * Whether a post meta row whose post link is `postHref` carries the private
 * lock (Mark 1): the link is a `ppost` path, which `postSegment` builds only
 * for a private post.
 *
 * Since v2 round 2 (fix 4) the mark has two placements (7.1): the thread
 * anchor carries the lock, "Private" and the audience after its date (Mark
 * 8); every other rendering - feed rows, thread replies, lists, Saved and
 * quotes - carries the lock alone in a small fixed slot at the right end of
 * its header row, the post meta row, which this answers for.
 */
export function isPrivateBadgeHref(postHref: string | undefined): boolean {
  return PRIVATE_POST_DISPLAY && !!postHref && isPrivatePostPath(postHref)
}

/**
 * What the control row leaves out on the post at `uri`. The bookmark control
 * stays (v2 round 2, fix 6, reversing O-24): until prism serves private
 * bookmarks (P-8) a press is refused with a toast (`refusesPrivateBookmark`).
 */
export type PrivateControls = {
  /**
   * No like, repost or reply count: the post's view carried no counts (P-2;
   * a pending post has none until prism serves it).
   */
  hideCounts: boolean
}

/**
 * Whether prism served counts on the private post at `uri`'s view.
 */
export function countsServed(uri: string | undefined): boolean {
  return !!uri && !!getPrivatePostFacts(uri)?.countsServed
}

/**
 * The controls a post's control row leaves out (Ctl 1).
 */
export function privateControlsFor(uri: string | undefined): PrivateControls {
  return {
    hideCounts: isPrivateDisplay(uri) && !countsServed(uri),
  }
}

/**
 * Whether the thread anchor's stats row is left out (Anchor 1): on a private
 * post without served counts, or with no reposts, likes or quotes. The stock
 * row also tests `bookmarkCount !== 0`, which holds for a private view
 * (prism serves no bookmark count), so an all-zero private post would draw
 * an empty bordered row.
 */
export function hidesPrivateStatsRow(post: {
  uri: string
  repostCount?: number
  likeCount?: number
  quoteCount?: number
}): boolean {
  if (!isPrivateDisplay(post.uri)) return false
  if (!countsServed(post.uri)) return true
  return post.repostCount === 0 && post.likeCount === 0 && post.quoteCount === 0
}

/**
 * Whether the menu leaves out Mute thread (Menu 4): on a private thread root
 * until prism serves thread mutes of private roots (`private.interactions`,
 * P-16) as answered in this run, since the press writes (4.7). A private
 * reply under a public root keeps it.
 */
export function hideThreadMute(rootUri: string | undefined): boolean {
  return (
    isPrivateDisplay(rootUri) && !privateInteractionsServed({forWrite: true})
  )
}

/**
 * Whether links in the post at `uri` go through Bluesky's redirect (Proxy
 * 1-7). Links in a private post open directly.
 */
export function proxiesPostLinks(uri: string | undefined): boolean {
  return !isPrivateDisplay(uri)
}

/**
 * The reply count the thread traversal draws reply lines from (Thread 3).
 * The stock value is the post's `replyCount`, which a private post has once
 * prism serves its counts. Without them it counts as having replies when the
 * next item of the thread is deeper, which in the depth-first item list
 * means a reply to it is shown (D2-33).
 */
export function threadRepliesCount(
  uri: string | undefined,
  replyCount: number | undefined,
  depth: number,
  nextItemDepth: number | undefined,
): number {
  if (privateControlsFor(uri).hideCounts) {
    return nextItemDepth !== undefined && nextItemDepth > depth ? 1 : 0
  }
  return replyCount || 0
}
