/*
 * How a compact window keeps its gradient aligned with the fixed backdrop
 * (Phase 3 design, 9.2). Pure: the DOM reads, the frame scheduler, the clock
 * and the event targets are passed in, so the rules are tested without a
 * browser. `BackdropWindow.web.tsx` wires them to the DOM.
 */

/** Where a window sits in the viewport. */
export type WindowRect = {left: number; top: number}

/** The settle loop's cap, in milliseconds (a time, not a frame count). */
export const SETTLE_CAP_MS = 1000

/** The background offset for a window at `rect`: the frame's origin inside it. */
export function windowOffset(rect: WindowRect): {x: number; y: number} {
  return {x: -rect.left, y: -rect.top}
}

function sameRect(a: WindowRect, b: WindowRect) {
  return a.left === b.left && a.top === b.top
}

export type SettleLoop = {
  /** Read and apply now, then follow the window each frame until it settles. */
  start: () => void
  stop: () => void
  /** True while frames are scheduled. */
  running: () => boolean
}

/**
 * A loop that reads the window's rect at `start` and on each animation frame
 * after, applies each new one, and stops after two consecutive equal reads or
 * `capMs` after its (re)start, whichever is first. `start` while running
 * restarts the clock. A `read` of null (the node is gone) stops it.
 */
export function createSettleLoop({
  read,
  apply,
  now,
  requestFrame,
  cancelFrame,
  capMs = SETTLE_CAP_MS,
}: {
  read: () => WindowRect | null
  apply: (rect: WindowRect) => void
  now: () => number
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  capMs?: number
}): SettleLoop {
  let handle: number | null = null
  let startedAt = 0
  let last: WindowRect | null = null

  function stop() {
    if (handle !== null) cancelFrame(handle)
    handle = null
  }

  function tick() {
    handle = null
    const rect = read()
    if (!rect) return
    if (last && sameRect(rect, last)) return
    last = rect
    apply(rect)
    if (now() - startedAt >= capMs) return
    handle = requestFrame(tick)
  }

  function start() {
    stop()
    startedAt = now()
    const rect = read()
    if (!rect) return
    // Always applied: a re-render may have rewritten the node's position.
    apply(rect)
    last = rect
    handle = requestFrame(tick)
  }

  return {start, stop, running: () => handle !== null}
}

/** Something with DOM-style listeners. */
export type ListenerTarget = {
  addEventListener: (
    type: string,
    listener: () => void,
    options?: boolean | AddEventListenerOptions,
  ) => void
  removeEventListener: (
    type: string,
    listener: () => void,
    options?: boolean | EventListenerOptions,
  ) => void
}

/** React Navigation's container ref, as far as it is used here. */
export type StateEmitter = {
  addListener: (type: 'state', listener: () => void) => () => void
}

/**
 * Attaches the 9.2 triggers that do not come from React: `scroll` on the
 * document (capture, passive, so inner scrollers count) and on the visual
 * viewport, `animationend` and `transitionend` on the document (capture; the
 * drawer's slide), and the navigation container's `state` event. Each calls
 * `onTrigger`. Returns the detach function.
 */
export function attachWindowTriggers(
  {
    document,
    visualViewport,
    navigation,
  }: {
    document: ListenerTarget | null
    visualViewport: ListenerTarget | null
    navigation: StateEmitter | null
  },
  onTrigger: () => void,
): () => void {
  const capture = {capture: true, passive: true}
  document?.addEventListener('scroll', onTrigger, capture)
  document?.addEventListener('animationend', onTrigger, true)
  document?.addEventListener('transitionend', onTrigger, true)
  visualViewport?.addEventListener('scroll', onTrigger)
  const offState = navigation?.addListener('state', onTrigger)
  return () => {
    document?.removeEventListener('scroll', onTrigger, {capture: true})
    document?.removeEventListener('animationend', onTrigger, true)
    document?.removeEventListener('transitionend', onTrigger, true)
    visualViewport?.removeEventListener('scroll', onTrigger)
    offState?.()
  }
}

/**
 * Whether a minimal-shell mode reading is a change worth re-measuring for:
 * any change after the first reading (the mount already measured).
 */
export function modeChanged(value: number, previous: number | null): boolean {
  return previous !== null && value !== previous
}
