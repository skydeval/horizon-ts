/*
 * A hover hint on a composer toolbar button (change list 2, item 1). There
 * is no hover on native: the button renders as it is.
 * `ToolbarHint.web.tsx` is the web hint.
 */

/** Renders `children` unchanged. */
export function ToolbarHint({
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return <>{children}</>
}
