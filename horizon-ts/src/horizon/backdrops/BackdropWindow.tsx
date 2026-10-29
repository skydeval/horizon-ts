/*
 * The native painter of a compact window (Phase 3 design, 9.8): a
 * clipping view, absolutely positioned and first inside its piece, that
 * measures itself with `measureInWindow` on layout and after every
 * minimal-shell change, and draws the backdrop with `CompiledSvg` at the
 * window's size, shifted by its position, under the overlays. Built, not
 * verified (N-1). `BackdropWindow.web.tsx` is the web painter.
 */

import {useRef, useState} from 'react'
import {View, type ViewStyle} from 'react-native'

import {atoms as a, useTheme} from '#/alf'
import {compileBackdrop} from '#/horizon/backdrops/compile'
import {CompiledSvg} from '#/horizon/backdrops/CompiledSvg'
import {type WindowShape} from '#/horizon/backdrops/frame'
import {windowOffset} from '#/horizon/backdrops/frame-tracking'
import {
  FooterModeTrigger,
  HomeHeaderModeTrigger,
} from '#/horizon/backdrops/ModeTrigger'
import {type BackdropDef} from '#/horizon/backdrops/types'
import {useViewportFrame} from '#/horizon/backdrops/viewport'

/** A `WindowShape` as a native style. */
function shapeStyle(shape: WindowShape): ViewStyle {
  const {topBorder, ...box} = shape
  return {
    position: 'absolute',
    ...box,
    ...(topBorder
      ? {borderTopWidth: topBorder.width, borderTopColor: topBorder.color}
      : {}),
  }
}

/**
 * Paints `def` under `overlays` (top first) inside the parent, aligned with
 * the window. `homeHeader` adds the Home header's mode trigger. `at`, the
 * window's known place on the screen, replaces the measurement (the Sides
 * strips). `followsAnimations` (the drawer) is at the screen's top left: it
 * lays out while slid off-screen, so a measurement would paint the empty
 * space past the screen's edge, and it always opens there. The web
 * painter's other hints (`isStatic`, `shades`) do not apply here.
 */
export function BackdropWindow({
  def,
  overlays,
  shape,
  homeHeader = false,
  followsAnimations = false,
  at,
}: {
  def: BackdropDef
  overlays: string[]
  shape: WindowShape
  homeHeader?: boolean
  isStatic?: boolean
  followsAnimations?: boolean
  shades?: boolean
  at?: {left: number; top: number}
}) {
  const t = useTheme()
  const frame = useViewportFrame()
  const ref = useRef<React.ComponentRef<typeof View>>(null)
  const [measured, setMeasured] = useState<{x: number; y: number} | null>(
    null,
  )
  const known = at ?? (followsAnimations ? {left: 0, top: 0} : null)
  const offset = known ? windowOffset(known) : measured
  const compiled = compileBackdrop(def, t.name, frame)

  const measure = () => {
    if (known) return
    ref.current?.measureInWindow((left, top) => {
      const next = windowOffset({left, top})
      setMeasured(prev =>
        prev && prev.x === next.x && prev.y === next.y ? prev : next,
      )
    })
  }

  return (
    <View
      ref={ref}
      pointerEvents="none"
      onLayout={measure}
      style={[shapeStyle(shape), a.overflow_hidden]}>
      <FooterModeTrigger onChange={measure} />
      {homeHeader && <HomeHeaderModeTrigger onChange={measure} />}
      {compiled && offset && (
        <CompiledSvg
          compiled={compiled}
          overlays={overlays}
          frame={frame}
          offset={offset}
        />
      )}
    </View>
  )
}
