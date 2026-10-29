/*
 * On web the halo is CSS (`BarShade.web.tsx`), so the app's scope
 * (`BarHalo.tsx`) does nothing here.
 */

import {type WindowKind} from '#/horizon/backdrops/frame'

/** The children only, on web. */
export function BarHaloScope({
  children,
}: {
  piece: WindowKind
  enabled?: boolean
  recolour?: boolean
  children: React.ReactNode
}) {
  return <>{children}</>
}
