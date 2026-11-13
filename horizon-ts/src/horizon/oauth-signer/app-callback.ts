/*
 * The Android app's OAuth return address (`functions/auth/app/callback.ts`).
 *
 * The authorization server allows a signed (confidential) client only with
 * `application_type: web`, and a web client must return to an https
 * address. So the app's document names this page, and the page hands the
 * answer straight to the app's own scheme with a server redirect: Chrome
 * opens an app from a redirect in a chain the person started (the consent
 * button), which a script on the page could not count on.
 *
 * The query is passed on untouched; the app checks `state` and `iss` and
 * exchanges the code with PKCE, as before.
 */

/** Where the app listens (its `scheme`, nearhorizon.app reversed). */
export const APP_CALLBACK_URI = 'app.nearhorizon:/oauth/callback'

export function handleAppCallback(request: Request): Response {
  const url = new URL(request.url)
  return new Response(null, {
    status: 302,
    headers: {
      location: `${APP_CALLBACK_URI}${url.search}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}
