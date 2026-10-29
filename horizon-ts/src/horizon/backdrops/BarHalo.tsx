/*
 * The halo on a bare window in the app (Bars, and Header's top bars):
 * web's soft glow of the theme's tint round each glyph and icon
 * (`BarShade.web.tsx`), at the same colour (`barHaloColors`). Web draws it
 * with CSS shadows; the app has none, so a bar piece wraps its items in
 * `BarHaloScope`, its text takes a text shadow (`useBarTextShade`, the
 * feed tab labels) and its icons draw a few copies of themselves in the
 * halo's colour behind them (`components/icons/nano.tsx`). As on web, the
 * grey items take the theme's text colour. skydeval: "as close as possible"
 * to web (2026-10-29).
 */

import {useWindowDimensions} from 'react-native'

import {useBreakpoints, useTheme} from '#/alf'
import {useDialogContext} from '#/components/Dialog/context'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {BarHaloContext} from '#/horizon/backdrops/bar-halo-context'
import {
  barHaloColors,
  type WindowBox,
  type WindowKind,
  windowMode,
  windowRange,
} from '#/horizon/backdrops/frame'

/** The height, in points, a top or bottom bar's window covers, about. */
const BAR_HEIGHT = {top: 110, bottom: 80}

/*
 * The window's part of the backdrop, from where its bar sits rather than a
 * measurement: a top bar at the top of the screen, the tab bar at the
 * bottom. Close enough for the range, which is widened to 2% steps anyway.
 */
function barBox(piece: WindowKind, width: number, height: number): WindowBox {
  return piece === 'bottomBar'
    ? {
        left: 0,
        top: height - BAR_HEIGHT.bottom,
        width,
        height: BAR_HEIGHT.bottom,
      }
    : {left: 0, top: 0, width, height: BAR_HEIGHT.top}
}

/**
 * Wraps a bar piece's items: when the piece is a bare window, they draw
 * the halo. `enabled` as for the piece's `FrameWindow`.
 */
export function BarHaloScope({
  piece,
  enabled = true,
  children,
}: {
  piece: WindowKind
  enabled?: boolean
  children: React.ReactNode
}) {
  const t = useTheme()
  const def = useActiveBackdrop()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  const {isWithinDialog} = useDialogContext()
  const {width, height} = useWindowDimensions()
  const mode = windowMode({
    def,
    frameStyle: device.frameStyle,
    kind: piece,
    gtMobile,
    isWithinDialog,
    enabled,
  })
  if (!def || mode !== 'bare') return <>{children}</>
  const range = windowRange(
    def,
    t.name,
    {width, height},
    barBox(piece, width, height),
  )
  return (
    <BarHaloContext.Provider value={barHaloColors(def, t.name, range)}>
      {children}
    </BarHaloContext.Provider>
  )
}
