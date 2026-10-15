/*
 * Popup or page for an in-place OAuth sign-in.
 *
 * Adapted from the Witchsky client (MIT),
 * src/state/session/oauth-web-display.ts.
 */

import {saveOAuthReturnUrl} from '#/horizon/session/oauth-return-url'

/**
 * In-place flows use a popup so the page and its state stay put. In an
 * installed web app (standalone or fullscreen display mode) opening a browser
 * window can suspend the app before the popup reaches the authorization
 * server, so the page itself redirects instead, with the return URL saved.
 */
export function getOAuthDisplay(): 'page' | 'popup' {
  const standalone =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
      window.matchMedia?.('(display-mode: fullscreen)').matches ||
      (window.navigator as Navigator & {standalone?: boolean}).standalone)
  if (standalone) {
    saveOAuthReturnUrl()
    return 'page'
  }
  return 'popup'
}
