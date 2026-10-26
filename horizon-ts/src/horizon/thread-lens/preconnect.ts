/*
 * Native has no preconnect hint; the first call opens the connection
 * (`preconnect.web.ts` on web).
 */

/** Nothing on native; returns a no-op. */
export function preconnectPrism(): () => void {
  return () => {}
}
