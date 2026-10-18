/*
 * The composer's media spoiler flags and content warnings (2J design, 4.1).
 * `ComposerImage` and the video state are stock types whose reducers rebuild
 * them field by field, so the flags live here, keyed by what those reducers
 * keep: an image's `source.id` and a video's `abortController`. A content
 * warning is keyed by the post's `PostDraft.id`.
 *
 * One snapshot, replaced on every change, read with `useSyncExternalStore`.
 * Every computation that reads it takes the snapshot as an argument, so the
 * React Compiler sees it as an input. `useComposeSpoilerSession`, called once
 * in `ComposePost`, resets it on mount and unmount, as the visibility record
 * (`private/composer/state.ts`).
 */

import {useLayoutEffect, useSyncExternalStore} from 'react'

export type ComposeSpoilers = {
  /** Flagged images, by `ComposerImage.source.id`. */
  images: ReadonlySet<string>
  /** Flagged videos, by the video state's `abortController`. */
  videos: ReadonlySet<AbortController>
  /** Posts with a CW, by `PostDraft.id`, with the CW line as typed. */
  cw: ReadonlyMap<string, {line: string}>
  /** Videos to flag once restored from a draft, by `PostDraft.id`. */
  pendingVideoPosts: ReadonlySet<string>
  /** The post whose CW field takes focus when it mounts, once. */
  focusCwFor?: string
}

export const EMPTY_COMPOSE_SPOILERS: ComposeSpoilers = Object.freeze({
  images: new Set<string>(),
  videos: new Set<AbortController>(),
  cw: new Map<string, {line: string}>(),
  pendingVideoPosts: new Set<string>(),
})

let state: ComposeSpoilers = EMPTY_COMPOSE_SPOILERS
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function set(next: ComposeSpoilers) {
  if (next === state) return
  state = next
  listeners.forEach(listener => listener())
}

function toggled<T>(from: ReadonlySet<T>, key: T, on: boolean): Set<T> {
  const next = new Set(from)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

/**
 * The current snapshot (non-React). The write path captures it before its
 * first `await`.
 */
export function getComposeSpoilers(): ComposeSpoilers {
  return state
}

/**
 * The snapshot, kept current.
 */
export function useComposeSpoilers(): ComposeSpoilers {
  return useSyncExternalStore(subscribe, getComposeSpoilers)
}

/**
 * Owns the snapshot for the composer's lifetime: empty on mount and again on
 * unmount. Called once in `ComposePost`. Returns the snapshot.
 */
export function useComposeSpoilerSession(): ComposeSpoilers {
  useLayoutEffect(() => {
    set(EMPTY_COMPOSE_SPOILERS)
    return () => set(EMPTY_COMPOSE_SPOILERS)
  }, [])
  return useComposeSpoilers()
}

/**
 * Flag or unflag an image.
 */
export function setImageSpoiler(id: string, on: boolean) {
  if (state.images.has(id) === on) return
  set({...state, images: toggled(state.images, id, on)})
}

/**
 * Flag or unflag a video.
 */
export function setVideoSpoiler(controller: AbortController, on: boolean) {
  if (state.videos.has(controller) === on) return
  set({...state, videos: toggled(state.videos, controller, on)})
}

/**
 * Set a post's CW line, or turn its CW off with `undefined` (the line is
 * forgotten). Turning a CW on asks its field to take focus when it mounts.
 */
export function setContentWarning(postId: string, line: string | undefined) {
  const current = state.cw.get(postId)
  if (line === undefined) {
    if (!current) return
    const cw = new Map(state.cw)
    cw.delete(postId)
    set({
      ...state,
      cw,
      focusCwFor: state.focusCwFor === postId ? undefined : state.focusCwFor,
    })
    return
  }
  if (current?.line === line) return
  const cw = new Map(state.cw)
  cw.set(postId, {line})
  set({...state, cw, focusCwFor: current ? state.focusCwFor : postId})
}

/**
 * Whether the CW field of `postId` takes focus now: true once after the
 * toggle turned that post's CW on.
 */
export function takeCwFocus(postId: string): boolean {
  if (state.focusCwFor !== postId) return false
  set({...state, focusCwFor: undefined})
  return true
}

/**
 * A video restored from a draft got its controller: flag it when the draft
 * had it flagged.
 */
export function bindRestoredVideoSpoiler(
  postId: string,
  controller: AbortController,
) {
  if (!state.pendingVideoPosts.has(postId)) return
  set({
    ...state,
    videos: toggled(state.videos, controller, true),
    pendingVideoPosts: toggled(state.pendingVideoPosts, postId, false),
  })
}

/**
 * Replace the whole snapshot (a draft restored, 5.6).
 */
export function replaceComposeSpoilers(next: ComposeSpoilers) {
  set(next)
}

/**
 * The image is flagged in `snap`.
 */
export function isImageFlagged(
  snap: ComposeSpoilers,
  image: {source: {id: string}},
): boolean {
  return snap.images.has(image.source.id)
}

/**
 * The video is flagged in `snap`.
 */
export function isVideoFlagged(
  snap: ComposeSpoilers,
  video: {abortController: AbortController},
): boolean {
  return snap.videos.has(video.abortController)
}

/**
 * The post's CW in `snap`, or `undefined` when it has none.
 */
export function contentWarningOf(
  snap: ComposeSpoilers,
  postId: string,
): {line: string} | undefined {
  return snap.cw.get(postId)
}
