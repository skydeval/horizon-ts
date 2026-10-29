/*
 * Text over the app's bare drawer: one soft shadow in the theme's tint under
 * the text (`OutlineShadowContext`, which Typography's `Text` takes, nested
 * text included), as a phone's home screen does for its labels over a
 * wallpaper. The text keeps its colour and the layout is unchanged. Copies
 * of the text a point out every way read as pills behind each word
 * (skydeval, 2026-10-29). Outside an outline scope (`BarHaloScope` with
 * `outline`), the children only.
 */

import {
  OutlineShadowContext,
  useBarHalo,
} from '#/horizon/backdrops/bar-halo-context'

export function Outlined({children}: {children: React.ReactNode}) {
  const halo = useBarHalo()
  if (!halo?.outline || !halo.textShadow) return <>{children}</>
  return (
    <OutlineShadowContext.Provider value={halo.textShadow}>
      {children}
    </OutlineShadowContext.Provider>
  )
}
