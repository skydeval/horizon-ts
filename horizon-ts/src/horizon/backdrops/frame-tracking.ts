/*
 * How compact windows keep their gradient aligned with the fixed backdrop
 * (Phase 3 design, 9.2; performance fix 7b). One shared tracker for every
 * window: one listener per trigger and one animation-frame callback, which
 * reads every window's rect first and then writes only the ones that
 * moved, so there is at most one forced layout per frame however many
 * windows there are. Pure: the event targets, the frame scheduler, the
 * clock and the microtask queue are passed in, so the rules are tested
 * without a browser. `BackdropWindow.web.tsx` wires it to the DOM.
 */

/** Where a window sits in the viewport, and its size when read from a node. */
export type WindowRect = {
  left: number
  top: number
  width?: number
  height?: number
}

/** The settle loop's cap, in milliseconds (a time, not a frame count). */
export const SETTLE_CAP_MS = 1000

/** Frames in a row with no window moving before the loop stops. */
export const QUIET_FRAMES = 2

/** The offset of the frame's origin inside a window at `rect`. */
export function windowOffset(rect: WindowRect): {x: number; y: number} {
  return {x: -rect.left, y: -rect.top}
}

function sameRect(a: WindowRect, b: WindowRect) {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  )
}

/** One window, as the tracker sees it. */
export type TrackedWindow = {
  /** The window's viewport rect, or null when it is gone or not rendered. */
  read: () => WindowRect | null
  /** Moves the window's gradient; called only when the rect changed. */
  apply: (rect: WindowRect) => void
  /**
   * A window that moves only when the layout does (the rail and nav
   * cards): read on mount, resize, navigation, a layout change and a
   * scroll of its own scroller, never on page scroll.
   */
  isStatic?: boolean
  /**
   * Follows the end of a CSS animation or transition on an ancestor (the
   * drawer's slide). Only these windows listen for them.
   */
  followsAnimations?: boolean
  /** Whether an event at `target` concerns this window (an ancestor). */
  within?: (target: unknown) => boolean
}

/** Something with DOM-style listeners. */
export type ListenerTarget = {
  addEventListener: (
    type: string,
    listener: (event?: {target?: unknown}) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void
  removeEventListener: (
    type: string,
    listener: (event?: {target?: unknown}) => void,
    options?: boolean | EventListenerOptions,
  ) => void
}

/** React Navigation's container ref, as far as it is used here. */
export type StateEmitter = {
  addListener: (type: 'state', listener: () => void) => () => void
}

export type TrackerEnv = {
  /** `scroll` (capture, so inner scrollers count) and the animation ends. */
  document: ListenerTarget | null
  /** `resize`. */
  window: ListenerTarget | null
  /** `scroll` (pinch zoom panning, the iOS toolbar). */
  visualViewport: ListenerTarget | null
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  now: () => number
  /** Runs `callback` after the current commit, before paint. */
  microtask: (callback: () => void) => void
  capMs?: number
}

type EntryState = {
  last: WindowRect | null
  /** Read at the next pass even if static. */
  dirty: boolean
  visible: boolean
}

export type WindowTracker = {
  /** Starts tracking `window`; returns the function that stops it. */
  register: (window: TrackedWindow) => () => void
  /** Something moved the bars (a minimal-shell change): follow them. */
  kick: () => void
  /** The layout may have changed: re-read every window, static ones too. */
  relayout: () => void
  /** Visibility from an observer; hidden windows are not read. */
  setVisible: (window: TrackedWindow, visible: boolean) => void
  /** Listens to a navigation container's `state` event while tracking. */
  attachNavigation: (navigation: StateEmitter) => () => void
  /** True while frames are scheduled. */
  running: () => boolean
}

/**
 * The shared tracker. Each trigger starts (or extends) one settle loop,
 * which reads the windows on each animation frame and stops after
 * `QUIET_FRAMES` frames in a row in which nothing moved, or `capMs` after
 * the last trigger. Listeners are attached while at least one window is
 * tracked (the animation ends only while a window follows them).
 */
export function createWindowTracker(env: TrackerEnv): WindowTracker {
  const capMs = env.capMs ?? SETTLE_CAP_MS
  const entries = new Map<TrackedWindow, EntryState>()
  const navigations = new Map<StateEmitter, {count: number; off: () => void}>()
  let handle: number | null = null
  let flushQueued = false
  let kickedAt = 0
  let quiet = 0
  let listening = false
  let animationListening = false

  /** One pass: every read first, then the writes that changed. */
  function pass(): boolean {
    const batch: [TrackedWindow, EntryState][] = []
    entries.forEach((state, window) => {
      if (!state.visible) return
      if (window.isStatic && !state.dirty) return
      batch.push([window, state])
    })
    const rects = batch.map(([window]) => window.read())
    let moved = false
    batch.forEach(([window, state], i) => {
      state.dirty = false
      const rect = rects[i]
      if (!rect) return
      if (state.last && sameRect(rect, state.last)) return
      state.last = rect
      window.apply(rect)
      moved = true
    })
    return moved
  }

  function tick() {
    handle = null
    if (pass()) quiet = 0
    else quiet++
    if (quiet >= QUIET_FRAMES || env.now() - kickedAt >= capMs) return
    handle = env.requestFrame(tick)
  }

  function startLoop() {
    kickedAt = env.now()
    quiet = 0
    if (handle === null && entries.size > 0) handle = env.requestFrame(tick)
  }

  /** Aligns the windows before the browser paints, then settles. */
  function flushSoon() {
    if (flushQueued) return
    flushQueued = true
    env.microtask(() => {
      flushQueued = false
      pass()
      startLoop()
    })
  }

  function markAll() {
    entries.forEach(state => {
      state.dirty = true
    })
  }

  function hasMoving() {
    for (const window of entries.keys()) if (!window.isStatic) return true
    return false
  }

  const onScroll = (event?: {target?: unknown}) => {
    let any = hasMoving()
    entries.forEach((state, window) => {
      if (window.isStatic && window.within?.(event?.target)) {
        state.dirty = true
        any = true
      }
    })
    if (any) startLoop()
  }

  const onViewportScroll = () => {
    if (hasMoving()) startLoop()
  }

  const onResize = () => {
    markAll()
    startLoop()
  }

  const onAnimationEnd = (event?: {target?: unknown}) => {
    for (const window of entries.keys()) {
      if (window.followsAnimations && window.within?.(event?.target)) {
        startLoop()
        return
      }
    }
  }

  const onNavigation = () => {
    markAll()
    startLoop()
  }

  const capture = {capture: true, passive: true}

  function syncListeners() {
    const want = entries.size > 0
    if (want !== listening) {
      listening = want
      if (want) {
        env.document?.addEventListener('scroll', onScroll, capture)
        env.visualViewport?.addEventListener('scroll', onViewportScroll)
        env.window?.addEventListener('resize', onResize)
      } else {
        env.document?.removeEventListener('scroll', onScroll, {capture: true})
        env.visualViewport?.removeEventListener('scroll', onViewportScroll)
        env.window?.removeEventListener('resize', onResize)
      }
    }
    let animated = false
    for (const window of entries.keys()) {
      if (window.followsAnimations) animated = true
    }
    if (animated !== animationListening) {
      animationListening = animated
      if (animated) {
        env.document?.addEventListener('animationend', onAnimationEnd, true)
        env.document?.addEventListener('transitionend', onAnimationEnd, true)
      } else {
        env.document?.removeEventListener('animationend', onAnimationEnd, true)
        env.document?.removeEventListener('transitionend', onAnimationEnd, true)
      }
    }
    if (!want && handle !== null) {
      env.cancelFrame(handle)
      handle = null
    }
  }

  return {
    register(window) {
      entries.set(window, {last: null, dirty: true, visible: true})
      syncListeners()
      flushSoon()
      return () => {
        entries.delete(window)
        syncListeners()
      }
    },
    kick: startLoop,
    relayout() {
      markAll()
      startLoop()
    },
    setVisible(window, visible) {
      const state = entries.get(window)
      if (!state || state.visible === visible) return
      state.visible = visible
      if (visible) {
        state.dirty = true
        startLoop()
      }
    },
    attachNavigation(navigation) {
      const existing = navigations.get(navigation)
      if (existing) {
        existing.count++
      } else {
        navigations.set(navigation, {
          count: 1,
          off: navigation.addListener('state', onNavigation),
        })
      }
      return () => {
        const current = navigations.get(navigation)
        if (!current) return
        current.count--
        if (current.count === 0) {
          current.off()
          navigations.delete(navigation)
        }
      }
    },
    running: () => handle !== null,
  }
}

/**
 * Whether a minimal-shell mode reading is a change worth re-measuring for:
 * any change after the first reading (the mount already measured).
 */
export function modeChanged(value: number, previous: number | null): boolean {
  return previous !== null && value !== previous
}
