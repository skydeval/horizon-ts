/*
 * The frame every backdrop painter uses on web (Phase 3 design, 9.2): the
 * size of the fixed layer's box (the initial containing block, which
 * excludes a classic scrollbar), read synchronously at first render and
 * updated on `window` and `visualViewport` resize. The layer and every
 * window share this one value, so they agree by construction.
 */

import {useSyncExternalStore} from 'react'

import {type Frame} from '#/horizon/backdrops/compile'

let frame: Frame | null = null
const listeners = new Set<() => void>()

/**
 * The large viewport's height (`100lvh`): the height with the browser's
 * toolbars retracted. 0 where the unit is unknown.
 */
function largeViewportHeight(): number {
  if (typeof CSS === 'undefined' || !CSS.supports?.('height', '100lvh')) {
    return 0
  }
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none'
  document.documentElement.appendChild(probe)
  const height = probe.getBoundingClientRect().height
  probe.remove()
  return height
}

/*
 * The height is the larger of the initial containing block and the large
 * viewport. On iOS Safari the containing block is the small viewport (the
 * toolbar shown), so when the toolbar retracts on scroll the bottom bar
 * slides below a frame of that height and showed the page colour under the
 * backdrop's last pixels (live check, 2026-10-20). The large viewport
 * covers every toolbar state and does not change with it, so the gradient
 * is not recomputed as the toolbar moves.
 */
function read(): Frame {
  if (typeof document === 'undefined') return {width: 0, height: 0}
  const root = document.documentElement
  return {
    width: root.clientWidth,
    height: Math.max(root.clientHeight, largeViewportHeight()),
  }
}

function getFrame(): Frame {
  if (!frame) frame = read()
  return frame
}

function onResize() {
  const next = read()
  if (frame && next.width === frame.width && next.height === frame.height) {
    return
  }
  frame = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    // Catch a resize while nothing listened; React re-reads after subscribing.
    onResize()
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }
}

/** The backdrop's frame, in pixels. */
export function useViewportFrame(): Frame {
  return useSyncExternalStore(subscribe, getFrame, getFrame)
}
