/*
 * The web painter of a compact window, a lens or a rail card (Phase 3
 * design, 9.1, 9.2 and 9.7; performance fixes 7a and 7b): a raw `div`,
 * absolutely positioned in its piece and first inside it, clipped to its
 * shape. Inside it an element the size of the viewport frame carries the
 * same viewport-anchored gradient as the fixed layer, and is moved by a
 * `translate3d` so that its origin sits at the viewport's: it is
 * rasterised once and only composited as a bar slides, where the first
 * build rewrote `background-position` and repainted the bar on every frame.
 * The overlays (the glass, a lens's icon backing) and a bar's top hairline
 * are layers above it. The offsets come from one shared tracker
 * (`frame-tracking.ts`) that reads every window first and then writes only
 * those that moved. `background-attachment: fixed` is not used: every bar
 * carries a transform, which turns it into `scroll`.
 *
 * A static window (a rail or nav card, performance round 2) paints the
 * backdrop and its overlays as one layered background on the clipping
 * `div` itself and moves it with `background-position`: it moves only with
 * the layout, so it is never repainted on scroll, and it adds no
 * compositor layers. The frame-sized inner element is a layer of its own
 * (and promotes the overlays above it by overlap), so at 1440 the four
 * cards were eight extra layers drawn on every scroll frame.
 *
 * A window whose piece is fixed to the viewport (the Home header and the
 * bottom bar, performance round 2) is `pinned`: a page scroll cannot move
 * it, so it is read only when the bars slide, the layout changes or a
 * scroller around it scrolls, not on every scroll frame.
 *
 * The `div` sits at `z-index: -1` (live fix batch 1). An absolutely
 * positioned box with `z-index: auto` paints above its parent's in-flow,
 * non-positioned children, and the bottom tabs' and the compose button's
 * icons are bare `<svg>` elements, so the first build's lenses covered
 * them. At -1 it paints just above its piece's own background and below
 * all of the piece's content; every piece is an RN-web `View`, which is
 * `position: relative; z-index: 0` and so a stacking context that keeps
 * the -1 inside it.
 */

import {useContext, useLayoutEffect, useRef} from 'react'
import {NavigationContainerRefContext} from '@react-navigation/native'

import {useTheme} from '#/alf'
import {compileBackdrop} from '#/horizon/backdrops/compile'
import {
  cssBackground,
  cssBackgroundPosition,
  cssLayers,
  cssOverlays,
  formatNumber,
  type Overlay,
} from '#/horizon/backdrops/css'
import {
  barShadeVars,
  windowRange,
  type WindowShape,
} from '#/horizon/backdrops/frame'
import {
  createWindowTracker,
  type StateEmitter,
  type TrackedWindow,
  windowOffset,
  type WindowRect,
  type WindowTracker,
} from '#/horizon/backdrops/frame-tracking'
import {prefersReducedTransparency} from '#/horizon/backdrops/glass'
import {
  FooterModeTrigger,
  HomeHeaderModeTrigger,
} from '#/horizon/backdrops/ModeTrigger'
import {type BackdropDef} from '#/horizon/backdrops/types'
import {useViewportFrame} from '#/horizon/backdrops/viewport'

let tracker: WindowTracker | null = null

/** A static window's paint before its first alignment. */
const ORIGIN = {x: 0, y: 0}

/** The page's one window tracker, created on first use. */
function windowTracker(): WindowTracker {
  if (!tracker) {
    const hasWindow =
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    tracker = createWindowTracker({
      document: typeof document === 'undefined' ? null : document,
      window: hasWindow ? window : null,
      visualViewport: hasWindow ? (window.visualViewport ?? null) : null,
      requestFrame: callback => window.requestAnimationFrame(callback),
      cancelFrame: handle => window.cancelAnimationFrame(handle),
      now: () => performance.now(),
      microtask: callback => queueMicrotask(callback),
    })
  }
  return tracker
}

/** Follow the bars: a minimal-shell mode changed. */
function kickWindows() {
  tracker?.kick()
}

/*
 * One observer each for every window (performance fix 7b): visibility, so
 * the windows of a screen the stack hides (`display: none`) or of a bar slid
 * out of view are not read; and size, so a rail card re-reads its offset
 * when the cards above it grow.
 */
const watched = new WeakMap<Element, TrackedWindow>()
let visibility: IntersectionObserver | null = null
let layout: ResizeObserver | null = null

function observeVisibility(node: Element, entry: TrackedWindow) {
  if (typeof IntersectionObserver === 'undefined') return () => {}
  visibility ??= new IntersectionObserver(
    records => {
      for (const record of records) {
        const window = watched.get(record.target)
        if (window) tracker?.setVisible(window, record.isIntersecting)
      }
    },
    /*
     * A bar slid just out of view still counts, so it is aligned as it
     * slides back; a hidden screen's window has no box and never does.
     */
    {rootMargin: '200px'},
  )
  watched.set(node, entry)
  visibility.observe(node)
  return () => {
    visibility?.unobserve(node)
    watched.delete(node)
  }
}

function observeLayout(nodes: Element[]) {
  if (typeof ResizeObserver === 'undefined') return () => {}
  layout ??= new ResizeObserver(() => tracker?.relayout())
  nodes.forEach(node => layout?.observe(node))
  return () => nodes.forEach(node => layout?.unobserve(node))
}

/** A `WindowShape` as CSS, without its hairline (drawn as a layer). */
function shapeCss(shape: WindowShape): React.CSSProperties {
  const {topBorder: _topBorder, ...box} = shape
  return {position: 'absolute', ...box}
}

/**
 * Whether `node` sits in a `position: fixed` piece with no sticky box in
 * between, so that a page scroll cannot move it (read once, on mount).
 */
export function pinnedToViewport(node: Element): boolean {
  if (typeof Element === 'undefined') return false
  for (
    let el: Element | null = node.parentElement;
    el instanceof Element;
    el = el.parentElement
  ) {
    const {position} = getComputedStyle(el)
    if (position === 'fixed') return true
    if (position === 'sticky') return false
  }
  return false
}

function translate(rect: WindowRect) {
  return `translate3d(${formatNumber(-rect.left, 2)}px, ${formatNumber(-rect.top, 2)}px, 0)`
}

/**
 * Paints `def` under `overlays` (top first) inside the parent, aligned with
 * the fixed backdrop layer. `homeHeader` adds the Home header's mode
 * trigger (only inside the Home header, where its provider exists).
 * `isStatic` is a window that moves only with the layout (a rail card);
 * `followsAnimations` one that slides in (the drawer). `shades` makes it a
 * bare window: it sets its items' shade colours on the piece, for the part
 * of the backdrop it shows (`barShadeVars`).
 */
export function BackdropWindow({
  def,
  overlays,
  shape,
  homeHeader = false,
  isStatic = false,
  followsAnimations = false,
  shades = false,
}: {
  def: BackdropDef
  overlays: Overlay[]
  shape: WindowShape
  homeHeader?: boolean
  isStatic?: boolean
  followsAnimations?: boolean
  shades?: boolean
}) {
  const t = useTheme()
  const theme = t.name
  const frame = useViewportFrame()
  const {width, height} = frame
  const navigation = (useContext(NavigationContainerRefContext) ??
    null) as StateEmitter | null
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const compiled = compileBackdrop(def, theme, frame)
  const drawn = compiled !== null
  const overlayCount = overlays.length
  const layerCount = compiled?.layers.length ?? 0

  useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    const piece = outer?.parentElement
    if (!outer || !piece || typeof window === 'undefined') return
    // A static window paints on `outer` itself; the others move `inner`.
    if (!isStatic && !inner) return
    const shared = windowTracker()
    const reduced = shades && prefersReducedTransparency()
    let shadeVars: Record<string, string> | null = null
    const entry: TrackedWindow = {
      read: () => {
        if (!outer.isConnected) return null
        const rect = outer.getBoundingClientRect()
        // Not rendered (a hidden screen): nothing to align.
        if (rect.width === 0 && rect.height === 0) return null
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }
      },
      apply: rect => {
        if (isStatic) {
          outer.style.backgroundPosition = cssBackgroundPosition(
            overlayCount,
            layerCount,
            windowOffset(rect),
          )
        } else if (inner) {
          inner.style.transform = translate(rect)
        }
        if (!shades) return
        const next = barShadeVars(
          def,
          theme,
          windowRange(
            def,
            theme,
            {width, height},
            {
              left: rect.left,
              top: rect.top,
              width: rect.width ?? 0,
              height: rect.height ?? 0,
            },
          ),
          reduced,
        )
        if (next === shadeVars) return
        shadeVars = next
        for (const name of Object.keys(next)) {
          piece.style.setProperty(name, next[name])
        }
      },
      isStatic,
      pinned: !isStatic && pinnedToViewport(outer),
      followsAnimations,
      // An element around the window: its own scroller, the sliding drawer.
      within: target =>
        typeof Element !== 'undefined' &&
        target instanceof Element &&
        target !== outer &&
        target.contains(outer),
    }
    const unregister = shared.register(entry)
    const unwatch = observeVisibility(outer, entry)
    const unlayout = isStatic
      ? observeLayout(
          [outer.parentElement, outer.parentElement?.parentElement].filter(
            (node): node is HTMLElement => !!node,
          ),
        )
      : () => {}
    const offNavigation = navigation
      ? shared.attachNavigation(navigation)
      : () => {}
    return () => {
      offNavigation()
      unlayout()
      unwatch()
      unregister()
      if (shadeVars) {
        for (const name of Object.keys(shadeVars)) {
          piece.style.removeProperty(name)
        }
      }
    }
  }, [
    isStatic,
    followsAnimations,
    navigation,
    drawn,
    overlayCount,
    layerCount,
    shades,
    def,
    theme,
    width,
    height,
  ])

  if (!compiled) return null
  const topBorder = shape.topBorder
  return (
    <>
      {!isStatic && <FooterModeTrigger onChange={kickWindows} />}
      {!isStatic && homeHeader && (
        <HomeHeaderModeTrigger onChange={kickWindows} />
      )}
      <div
        ref={outerRef}
        aria-hidden
        style={{
          ...shapeCss(shape),
          // The bottom layer of its piece: below the icons, see above.
          zIndex: -1,
          pointerEvents: 'none',
          overflow: 'hidden',
          contain: 'strict',
          // Static: painted here, aligned by `background-position` (above).
          ...(isStatic
            ? cssBackground(compiled, overlays, frame, ORIGIN)
            : null),
        }}>
        {!isStatic && (
          <div
            ref={innerRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: frame.width,
              height: frame.height,
              // Its own layer: a move is composited, never repainted.
              willChange: 'transform',
              ...cssLayers(compiled, frame),
            }}
          />
        )}
        {!isStatic && overlays.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              ...cssOverlays(overlays),
            }}
          />
        )}
        {topBorder && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              left: 0,
              height: topBorder.width,
              backgroundColor: topBorder.color,
            }}
          />
        )}
      </div>
    </>
  )
}
