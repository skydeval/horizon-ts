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
import {type DiscOverlay, type Overlay} from '#/horizon/backdrops/css'
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

/*
 * A disc overlay on native (once a button lens's icon backing): a solid
 * centred circle in the disc's colour, its radius halfway through the web
 * disc's fade. The web disc's soft edge is not drawn (an approximation,
 * live fix batch 1).
 */
function Disc({disc}: {disc: DiscOverlay}) {
  const r = (disc.solid + disc.fade) / 2
  return (
    <View
      pointerEvents="none"
      style={[
        a.absolute,
        {
          top: '50%',
          left: '50%',
          width: r * 2,
          height: r * 2,
          marginTop: -r,
          marginLeft: -r,
          borderRadius: r,
          backgroundColor: disc.color,
        },
      ]}
    />
  )
}

/**
 * Paints `def` under `overlays` (top first) inside the parent, aligned with
 * the window. `homeHeader` adds the Home header's mode trigger. The web
 * painter's tracking hints (`isStatic`, `followsAnimations`) and shade
 * colours (`shades`; bare windows are web only) do not apply here.
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
  isStatic?: boolean
  followsAnimations?: boolean
  shades?: boolean
}) {
  const t = useTheme()
  const frame = useViewportFrame()
  const ref = useRef<React.ComponentRef<typeof View>>(null)
  const [offset, setOffset] = useState<{x: number; y: number} | null>(null)
  const compiled = compileBackdrop(def, t.name, frame)
  const colors = overlays.filter(
    (overlay): overlay is string => typeof overlay === 'string',
  )
  const discs = overlays.filter(
    (overlay): overlay is DiscOverlay => typeof overlay !== 'string',
  )

  const measure = () => {
    ref.current?.measureInWindow((left, top) => {
      const next = windowOffset({left, top})
      setOffset(prev =>
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
          overlays={colors}
          frame={frame}
          offset={offset}
        />
      )}
      {compiled &&
        offset &&
        discs.map((disc, i) => <Disc key={i} disc={disc} />)}
    </View>
  )
}
