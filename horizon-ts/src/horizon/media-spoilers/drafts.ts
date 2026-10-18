/*
 * The draft spoiler table (2J design, 5.6). Bluesky's drafts are stored on
 * the AppView under a lexicon with no field for a media spoiler or a content
 * warning, so Horizon remembers them on this device (MS-10), per account and
 * by draft id, as the visibility table does (`private/composer/drafts.ts`).
 * An entry holds one element per thread post, in order.
 */

import {logger} from '#/logger'
import {type PostDraft} from '#/view/com/composer/state/composer'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {
  type ComposeSpoilers,
  contentWarningOf,
  EMPTY_COMPOSE_SPOILERS,
  getComposeSpoilers,
  isImageFlagged,
  isVideoFlagged,
  replaceComposeSpoilers,
} from './compose-store'

/**
 * At most this many entries per account; the oldest are dropped first.
 */
export const MAX_DRAFT_SPOILER_ENTRIES = 200

type DraftPostSpoilers = {
  imageCount: number
  images: number[]
  video: boolean
  cw?: {line: string}
}

type DraftSpoilerEntry = {
  id: string
  posts: DraftPostSpoilers[]
}

function tableKey(did: string) {
  return `horizon:draft-spoilers:${did}`
}

function isPostSpoilers(value: unknown): value is DraftPostSpoilers {
  if (typeof value !== 'object' || value === null) return false
  const post = value as Record<string, unknown>
  if (typeof post.imageCount !== 'number') return false
  if (!Array.isArray(post.images)) return false
  if (!(post.images as unknown[]).every(i => typeof i === 'number')) {
    return false
  }
  if (typeof post.video !== 'boolean') return false
  if (post.cw !== undefined) {
    if (typeof post.cw !== 'object' || post.cw === null) return false
    if (typeof (post.cw as Record<string, unknown>).line !== 'string') {
      return false
    }
  }
  return true
}

/**
 * The account's table, oldest entry first. Malformed entries are ignored.
 */
export function readDraftSpoilerTable(did: string): DraftSpoilerEntry[] {
  const raw = readLocal(tableKey(did))
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as unknown[]).filter((entry): entry is DraftSpoilerEntry => {
      if (typeof entry !== 'object' || entry === null) return false
      const candidate = entry as Record<string, unknown>
      return (
        typeof candidate.id === 'string' &&
        Array.isArray(candidate.posts) &&
        (candidate.posts as unknown[]).every(isPostSpoilers)
      )
    })
  } catch (e) {
    logger.warn('draft spoiler table unreadable; starting over', {
      message: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}

function writeDraftSpoilerTable(did: string, entries: DraftSpoilerEntry[]) {
  const kept = entries.slice(-MAX_DRAFT_SPOILER_ENTRIES)
  writeLocal(tableKey(did), kept.length ? JSON.stringify(kept) : undefined)
}

function postImages(post: PostDraft) {
  const media = post.embed.media
  return media?.type === 'images' || media?.type === 'gallery'
    ? media.images
    : []
}

/**
 * One post's flags and CW in `snap`. A restored video still waiting for its
 * controller counts as flagged.
 */
export function draftPostSpoilers(
  post: PostDraft,
  snap: ComposeSpoilers,
): DraftPostSpoilers {
  const images = postImages(post)
  const media = post.embed.media
  const cw = contentWarningOf(snap, post.id)
  return {
    imageCount: images.length,
    images: images.flatMap((image, i) =>
      isImageFlagged(snap, image) ? [i] : [],
    ),
    video:
      media?.type === 'video' &&
      (isVideoFlagged(snap, media.video) ||
        snap.pendingVideoPosts.has(post.id)),
    ...(cw ? {cw: {line: cw.line}} : {}),
  }
}

function isEmptyPostSpoilers(post: DraftPostSpoilers): boolean {
  return post.images.length === 0 && !post.video && !post.cw
}

/**
 * Called after every draft save, once the draft id is known: records each
 * thread post's flags and CW for that id, or removes the entry when nothing
 * is set.
 */
export function recordDraftSpoilers(
  draftId: string,
  posts: readonly PostDraft[],
) {
  const did = getCurrentDid()
  if (!did) return
  const snap = getComposeSpoilers()
  const entry = posts.map(post => draftPostSpoilers(post, snap))
  const others = readDraftSpoilerTable(did).filter(e => e.id !== draftId)
  if (entry.every(isEmptyPostSpoilers)) {
    writeDraftSpoilerTable(did, others)
    return
  }
  writeDraftSpoilerTable(did, [...others, {id: draftId, posts: entry}])
}

/**
 * The snapshot a restored draft starts from: empty, then the entry applied.
 * Image flags go by index when the post's image count is the saved one;
 * otherwise (a local file was missing and its image dropped) every restored
 * image of the post is flagged if any was (fail closed). A flagged video is
 * pending until its controller exists.
 */
export function draftSpoilerSnapshot(
  entry: DraftSpoilerEntry | undefined,
  posts: readonly PostDraft[],
): ComposeSpoilers {
  if (!entry) return EMPTY_COMPOSE_SPOILERS
  const images = new Set<string>()
  const cw = new Map<string, {line: string}>()
  const pendingVideoPosts = new Set<string>()
  posts.forEach((post, i) => {
    const saved = entry.posts[i]
    if (!saved) return
    if (saved.cw) cw.set(post.id, {line: saved.cw.line})
    const restored = postImages(post)
    if (restored.length === saved.imageCount) {
      for (const index of saved.images) {
        const image = restored[index]
        if (image) images.add(image.source.id)
      }
    } else if (saved.images.length > 0) {
      for (const image of restored) images.add(image.source.id)
    }
    if (saved.video) pendingVideoPosts.add(post.id)
  })
  return {
    images,
    videos: new Set<AbortController>(),
    cw,
    pendingVideoPosts,
  }
}

/**
 * Called after a draft is restored into the composer: replaces the whole
 * snapshot, so a draft without an entry clears every flag and CW (restored
 * posts reuse fixed ids, `draft-post-<index>`).
 */
export function applyDraftSpoilers(
  draftId: string,
  posts: readonly PostDraft[],
) {
  const did = getCurrentDid()
  const entry = did
    ? readDraftSpoilerTable(did).find(e => e.id === draftId)
    : undefined
  replaceComposeSpoilers(draftSpoilerSnapshot(entry, posts))
}
