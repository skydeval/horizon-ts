/*
 * The restored marker and the provenance stamp (refract client design 3),
 * shared with Thread Lens S-15: there is one reader of the marker.
 *
 * - The marker (`app.nearhorizon.refract.defs#restored`) is readable only
 *   when `view.restored` is a plain object whose `community` is a string and
 *   whose `tier` is the integer 1 or 2. A `labeler` that is not a string
 *   starting with `did:` is dropped and the marker kept. A marker on a gap,
 *   `notFoundPost`, `blockedPost`, `viewNotFound` or `viewBlocked` is ignored.
 * - The stamp ({@link REFRACT_SOURCE}) is set by the normalizer on every post
 *   and profile view in a `refract.*` answer, restored or not. Its value is
 *   the form the answer was served in. It is an enumerable symbol key, so a
 *   spread keeps it and JSON drops it. A stamp is never edited in place: a
 *   view with a different stamp is a new object.
 *
 * Neither is ever displayed, and the marker's `community` and `tier` never
 * reach UI copy (RF-5).
 */

/** A readable marker. */
export type Restored = {
  community: string
  tier: 1 | 2
  labeler?: string
}

/** The form a refract answer was served in (3, 9.2). */
export type RefractForm = 'member' | 'visitor'

/** The provenance stamp's key. Its value is a {@link RefractForm}. */
export const REFRACT_SOURCE: unique symbol = Symbol('refractSource')

/**
 * Set on a view whose visitor viewer state prism marked as known
 * (`viewerChecked`, RF-S13), by the normalizer only.
 */
export const REFRACT_CHECKED: unique symbol = Symbol('refractChecked')

const IGNORED_TYPES = new Set([
  'app.bsky.feed.defs#notFoundPost',
  'app.bsky.feed.defs#blockedPost',
  'app.bsky.embed.record#viewNotFound',
  'app.bsky.embed.record#viewBlocked',
  'app.bsky.embed.record#viewDetached',
  'app.bsky.unspecced.defs#threadItemNotFound',
  'app.bsky.unspecced.defs#threadItemBlocked',
  'app.bsky.unspecced.defs#threadItemNoUnauthenticated',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * The view's marker, or `undefined` when it has none that can be read.
 */
export function readRestored(view: unknown): Restored | undefined {
  if (!isPlainObject(view)) return undefined
  const type = view.$type
  if (typeof type === 'string' && IGNORED_TYPES.has(type)) return undefined
  if (view.notFound === true || view.blocked === true) return undefined
  const marker = view.restored
  if (!isPlainObject(marker)) return undefined
  const {community, tier, labeler} = marker
  if (typeof community !== 'string') return undefined
  if (tier !== 1 && tier !== 2) return undefined
  const restored: Restored = {community, tier}
  if (typeof labeler === 'string' && labeler.startsWith('did:')) {
    restored.labeler = labeler
  }
  return restored
}

/** The view's stamp, if a refract answer carried it. */
export function stampOf(view: unknown): RefractForm | undefined {
  if (typeof view !== 'object' || view === null) return undefined
  const value = (view as {[REFRACT_SOURCE]?: unknown})[REFRACT_SOURCE]
  return value === 'member' || value === 'visitor' ? value : undefined
}

/** Whether prism marked this view's visitor viewer state as known. */
export function viewerCheckedOf(view: unknown): boolean {
  if (typeof view !== 'object' || view === null) return false
  return (view as {[REFRACT_CHECKED]?: unknown})[REFRACT_CHECKED] === true
}

/**
 * Whether the view came from Refract: it has the stamp or a readable marker
 * (the persistence strip and the stock-served test, 5.3).
 */
export function fromRefract(view: unknown): boolean {
  return stampOf(view) !== undefined || readRestored(view) !== undefined
}

/**
 * Stamp a view from a refract answer, before it reaches any cache. Only the
 * normalizer calls this, on objects fresh from the answer.
 */
export function stampView(view: object, form: RefractForm, checked: boolean) {
  Object.defineProperty(view, REFRACT_SOURCE, {
    value: form,
    enumerable: true,
    writable: false,
    configurable: true,
  })
  if (checked) {
    Object.defineProperty(view, REFRACT_CHECKED, {
      value: true,
      enumerable: true,
      writable: false,
      configurable: true,
    })
  }
}

/*
 * The DIDs seen with a marker this session, for the current account
 * (`noteRestored`, 3). It drives prewarm, lazy token minting and the
 * profile's error choice. Cleared on an account switch.
 */
const noted = new Set<string>()
const noteListeners = new Set<(did: string) => void>()

/** Record that `did` was seen with a marker. */
export function noteRestored(did: string) {
  if (noted.has(did)) return
  noted.add(did)
  noteListeners.forEach(listener => listener(did))
}

/** Whether `did` was seen with a marker this session. */
export function isNotedRestored(did: string | undefined): boolean {
  return !!did && noted.has(did)
}

/** A restore ended: `did` is no longer noted. */
export function dropNotedRestored(did: string) {
  noted.delete(did)
}

/** Forget every noted DID (an account switch, a cache clear, tests). */
export function clearNotedRestored() {
  noted.clear()
}

/** The DIDs noted this session. */
export function notedRestoredDids(): string[] {
  return Array.from(noted)
}

/**
 * Called with each DID the first time it is noted. Returns the unsubscribe
 * function.
 */
export function onRestoredNoted(listener: (did: string) => void) {
  noteListeners.add(listener)
  return () => {
    noteListeners.delete(listener)
  }
}
