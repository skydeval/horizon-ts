/*
 * The web painter of a compact window or lens (Phase 3 design, 9.1, 9.2 and
 * 9.7): a raw `div`, absolutely positioned in its piece and first inside
 * it, so the piece's content paints over it; it covers the piece's own
 * `t.atoms.bg`. It paints the same viewport-anchored gradient as the fixed
 * layer, offset by its own viewport rect, plus the overlays. The offset is
 * written straight to the node as the piece moves, so a moving bar costs no
 * React render. `background-attachment: fixed` is not used: every bar
 * carries a transform, which turns it into `scroll`.
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
  type Overlay,
} from '#/horizon/backdrops/css'
import {type WindowShape} from '#/horizon/backdrops/frame'
import {
  attachWindowTriggers,
  createSettleLoop,
  type SettleLoop,
  type StateEmitter,
  windowOffset,
} from '#/horizon/backdrops/frame-tracking'
import {
  FooterModeTrigger,
  HomeHeaderModeTrigger,
} from '#/horizon/backdrops/ModeTrigger'
import {type BackdropDef} from '#/horizon/backdrops/types'
import {useViewportFrame} from '#/horizon/backdrops/viewport'

/** A `WindowShape` as CSS. */
function shapeCss(shape: WindowShape): React.CSSProperties {
  const {topBorder, ...box} = shape
  return {
    position: 'absolute',
    ...box,
    ...(topBorder
      ? {
          borderTop: `${topBorder.width}px solid ${topBorder.color}`,
          boxSizing: 'border-box',
        }
      : {}),
  }
}

/**
 * Paints `def` under `overlays` (top first) inside the parent, aligned with
 * the fixed backdrop layer. `homeHeader` adds the Home header's mode
 * trigger (only inside the Home header, where its provider exists).
 */
export function BackdropWindow({
  def,
  overlays,
  shape,
  homeHeader = false,
}: {
  def: BackdropDef
  overlays: Overlay[]
  shape: WindowShape
  homeHeader?: boolean
}) {
  const t = useTheme()
  const frame = useViewportFrame()
  const navigation = (useContext(NavigationContainerRefContext) ??
    null) as StateEmitter | null
  const ref = useRef<HTMLDivElement>(null)
  const loopRef = useRef<SettleLoop | null>(null)
  const compiled = compileBackdrop(def, t.name, frame)
  const layerCount = compiled?.layers.length ?? 0
  const overlayCount = overlays.length

  /*
   * One loop per paint geometry: a new frame (or a change in the number of
   * layers) re-creates it and measures before the browser paints.
   */
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || typeof window === 'undefined') return
    const loop = createSettleLoop({
      read: () => {
        if (!node.isConnected) return null
        const rect = node.getBoundingClientRect()
        return {left: rect.left, top: rect.top}
      },
      apply: rect => {
        node.style.backgroundPosition = cssBackgroundPosition(
          overlayCount,
          layerCount,
          windowOffset(rect),
        )
      },
      now: () => performance.now(),
      requestFrame: callback => window.requestAnimationFrame(callback),
      cancelFrame: handle => window.cancelAnimationFrame(handle),
    })
    loopRef.current = loop
    loop.start()
    const detach = attachWindowTriggers(
      {
        document: typeof document === 'undefined' ? null : document,
        visualViewport: window.visualViewport ?? null,
        navigation,
      },
      loop.start,
    )
    return () => {
      detach()
      loop.stop()
      if (loopRef.current === loop) loopRef.current = null
    }
  }, [overlayCount, layerCount, frame.width, frame.height, navigation])

  const restart = () => loopRef.current?.start()

  if (!compiled) return null
  const background = cssBackground(compiled, overlays, frame, {x: 0, y: 0})
  return (
    <>
      <FooterModeTrigger onChange={restart} />
      {homeHeader && <HomeHeaderModeTrigger onChange={restart} />}
      <div
        ref={ref}
        aria-hidden
        style={{
          ...shapeCss(shape),
          // The bottom layer of its piece: below the icons, see above.
          zIndex: -1,
          pointerEvents: 'none',
          ...background,
          // The rect is the border box; the offset is measured from it.
          backgroundOrigin: 'border-box',
        }}
      />
    </>
  )
}
