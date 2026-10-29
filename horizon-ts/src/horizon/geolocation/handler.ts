/*
 * Horizon's own rough location for web, from Cloudflare (the host that
 * serves the page already knows the visitor's country and region). Bluesky's
 * `ip.bsky.app` answers only pages from bsky.app, so on Horizon's web
 * address the browser blocks it, the location stays unknown, and every
 * country's legal labeler is added (skydeval, 2026-10-29: "why are
 * international labelers required for me"). Same response shape as
 * Bluesky's service. Nothing is logged or stored.
 */

/** What Cloudflare puts on a request (`request.cf`), the parts read here. */
export type CloudflareGeo = {
  country?: string
  regionCode?: string
}

export function geolocationResponse(cf: CloudflareGeo | undefined): Response {
  const country = cf?.country
  // Cloudflare's "XX" is unknown, "T1" is Tor
  const countryCode =
    country && /^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1'
      ? country
      : undefined
  const regionCode =
    countryCode && cf?.regionCode && /^[A-Z0-9]{1,3}$/.test(cf.regionCode)
      ? cf.regionCode
      : undefined
  return new Response(JSON.stringify({countryCode, regionCode}), {
    headers: {
      'content-type': 'application/json',
      // Per visitor: never cached by the CDN or shared
      'cache-control': 'private, no-store',
    },
  })
}
