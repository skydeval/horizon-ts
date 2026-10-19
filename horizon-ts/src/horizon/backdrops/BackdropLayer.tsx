/*
 * The backdrop layer on native: nothing (Phase 3 design, 7.6). The native
 * reading area is the whole screen, so the backdrop shows only through the
 * compact windows, which paint it themselves. `BackdropLayer.web.tsx` is the
 * web layer.
 */

/** Renders nothing on native. */
export function BackdropLayer(_props: {active: boolean}) {
  return null
}
