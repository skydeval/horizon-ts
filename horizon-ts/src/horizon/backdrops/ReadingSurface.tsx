/*
 * The reading surface on native: nothing; native screens stay opaque
 * (Phase 3 design, 7.5 and 7.6). `ReadingSurface.web.tsx` is the web surface.
 */

/** Renders nothing on native. */
export function ReadingSurface() {
  return null
}
