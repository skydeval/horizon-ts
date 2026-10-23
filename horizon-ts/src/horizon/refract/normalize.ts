/*
 * `normalizeRestored` (refract client design 10, 3): every view in a
 * `refract.*` answer passes through here before it reaches the store or a
 * query. It runs once per answer, on the objects fresh from the JSON, so the
 * edits below are made before any cache holds them.
 *
 * - Every post view and profile view is stamped with the answer's form
 *   (`REFRACT_SOURCE`), restored or not: a stock post the restored account
 *   reposted, other people's posts in a thread, and their authors included.
 * - A view listed in the answer's `viewerChecked` (RF-S13), in a visitor
 *   answer, is marked `REFRACT_CHECKED`. A view is never marked from another
 *   answer's list.
 * - A profile whose DID the reader blocks gets `viewer.blocking` (the block
 *   record's URI); one the reader mutes gets `viewer.muted` (10.1, 10.2).
 * - A DID seen with a marker is noted (`noteRestored`), which also starts the
 *   lazy loads of the reader's blocks and mutes.
 */

import {
  noteRestored,
  readRestored,
  type RefractForm,
  stampView,
} from '#/horizon/refract/marker'
import {
  isOwnMuted,
  loadOwnRelations,
  ownBlockOf,
} from '#/horizon/refract/relations'

/** The answer's `viewerChecked`, as read. */
export type ViewerChecked = {
  posts: ReadonlySet<string>
  actors: ReadonlySet<string>
}

const MAX_DEPTH = 200

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A post view: `uri`, `cid`, an `author` and a `record`. */
export function isPostViewLike(value: Record<string, unknown>): boolean {
  return (
    typeof value.uri === 'string' &&
    value.uri.startsWith('at://') &&
    typeof value.cid === 'string' &&
    isObject(value.author) &&
    isObject(value.record)
  )
}

/** A profile view: a `did` and a `handle`. */
export function isProfileViewLike(value: Record<string, unknown>): boolean {
  return (
    typeof value.did === 'string' &&
    value.did.startsWith('did:') &&
    typeof value.handle === 'string'
  )
}

/** The answer's `viewerChecked` lists (empty when absent or malformed). */
export function readViewerChecked(body: unknown): ViewerChecked {
  const raw = isObject(body) ? body.viewerChecked : undefined
  const list = (value: unknown) =>
    new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [],
    )
  if (!isObject(raw)) return {posts: new Set(), actors: new Set()}
  return {posts: list(raw.posts), actors: list(raw.actors)}
}

/** The form an answer says it was served in (`servedAs`, RF-S10). */
export function servedAsOf(body: unknown): RefractForm | undefined {
  const value = isObject(body) ? body.servedAs : undefined
  return value === 'member' || value === 'visitor' ? value : undefined
}

function applyRelations(profile: Record<string, unknown>) {
  const did = profile.did as string
  const block = ownBlockOf(did)
  const muted = isOwnMuted(did)
  if (!block && !muted) return
  const viewer: Record<string, unknown> = isObject(profile.viewer)
    ? profile.viewer
    : {}
  if (block && typeof viewer.blocking !== 'string') viewer.blocking = block
  if (muted && viewer.muted !== true) viewer.muted = true
  profile.viewer = viewer
}

function walk(
  value: unknown,
  form: RefractForm,
  checked: ViewerChecked,
  depth: number,
) {
  if (depth > MAX_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, form, checked, depth + 1)
    return
  }
  if (!isObject(value)) return
  const post = isPostViewLike(value)
  const profile = !post && isProfileViewLike(value)
  if (post) {
    stampView(
      value,
      form,
      form === 'visitor' && checked.posts.has(value.uri as string),
    )
  } else if (profile) {
    if (readRestored(value)) {
      noteRestored(value.did as string)
      loadOwnRelations()
    }
    applyRelations(value)
    stampView(
      value,
      form,
      form === 'visitor' && checked.actors.has(value.did as string),
    )
  }
  const isViewRecord = value.$type === 'app.bsky.embed.record#viewRecord'
  for (const [key, child] of Object.entries(value)) {
    // A post's own record and a quote's `value` are records, not views.
    if (post && key === 'record') continue
    if (isViewRecord && key === 'value') continue
    if (key === 'viewer' || key === 'labels' || key === 'restored') continue
    walk(child, form, checked, depth + 1)
  }
}

/**
 * Normalize one refract answer's body in place: stamp, mark, and apply the
 * reader's blocks and mutes. `form` is the answer's form (its `servedAs`
 * when present, else the prediction).
 */
export function normalizeRestored(body: unknown, form: RefractForm) {
  walk(body, form, readViewerChecked(body), 0)
}
