/*
 * The server clock from Horizon's own site (web; 2026-10-26): a `HEAD` of
 * the page with `no-store`, so the `Date` header is the server's now, not a
 * cached response's. Same-origin, so script can read `Date` (a cross-origin
 * `Date` is not CORS-safelisted). One-second resolution, which is plenty
 * against a 50-minute token.
 */

/** Whether this platform reads the server clock from its own site. */
export const ORIGIN_CLOCK_AVAILABLE = true

/** The server clock minus the device's, in whole seconds, or `undefined`. */
export async function readOriginClockOffsetSecs(): Promise<number | undefined> {
  if (typeof location === 'undefined') return undefined
  const response = await fetch(location.origin + '/', {
    method: 'HEAD',
    cache: 'no-store',
  })
  const date = response.headers.get('date')
  const at = date ? Date.parse(date) : NaN
  if (!Number.isFinite(at)) return undefined
  return Math.floor(at / 1000) - Math.floor(Date.now() / 1000)
}
