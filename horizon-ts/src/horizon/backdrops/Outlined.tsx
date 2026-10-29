/*
 * Text over the app's bare drawer: one soft shadow in the theme's tint under
 * the text (`OutlineShadowContext`, which Typography's `Text` takes, nested
 * text included), as a phone's home screen does for its labels over a
 * wallpaper. The text keeps its colour and the layout is unchanged. Copies
 * of the text a point out every way read as pills behind each word
 * (skydeval, 2026-10-29). Outside an outline scope (`BarHaloScope` with
 * `outline`), the children only.
 */

import {useTheme} from '#/alf'
import {
  OutlineShadowContext,
  useBarHalo,
} from '#/horizon/backdrops/bar-halo-context'
import {OUTLINE_SHADOW_ALPHA, outlineColor} from '#/horizon/backdrops/frame'

export function Outlined({children}: {children: React.ReactNode}) {
  const halo = useBarHalo()
  const t = useTheme()
  if (!halo?.outline) return <>{children}</>
  return (
    <OutlineShadowContext.Provider
      value={outlineColor(t.name, OUTLINE_SHADOW_ALPHA)}>
      {children}
    </OutlineShadowContext.Provider>
  )
}
