/*
 * Bar shades on native: none. The Bars frame's bare windows are web only
 * (`windowMode` keeps the glass on native, where the shades' soft edge would
 * need its own painter), so every hook here is stock. `BarShade.web.tsx` is
 * the web version.
 */

import {type StyleProp, type TextStyle} from 'react-native'

import {type ShadeKind} from '#/horizon/backdrops/frame'

/** Nothing on native. */
export function BarShade(_props: {kind: ShadeKind; show?: boolean}) {
  return null
}

/** The slot's children only, on native. */
export function BarSlot({children}: {children?: React.ReactNode}) {
  return <>{children}</>
}

/** No text shade on native. */
export function useBarTextShade(
  _kind: 'title' | 'subtitle',
  _style?: StyleProp<TextStyle>,
): TextStyle | undefined {
  return undefined
}
