/*
 * On web the drawer keeps its glass, so the app's soft text shadow
 * (`Outlined.tsx`) is not drawn.
 */

/** The children only, on web. */
export function Outlined({children}: {children: React.ReactNode}) {
  return <>{children}</>
}
