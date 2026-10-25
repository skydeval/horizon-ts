/*
 * Whether this page is an installed web app on a phone or tablet (system
 * accounts design 4.3 step 3, SA-17, SAR2-N7): standalone or fullscreen
 * display mode (or iOS's `navigator.standalone`) and a coarse primary
 * pointer. There the popup may be suspended before it reaches the server,
 * so registration offers an app password only. Side-effect free: unlike
 * `getOAuthDisplay()`, it saves no return URL. An installed desktop app
 * uses the popup as a browser tab does.
 */

function matches(query: string): boolean {
  try {
    return window.matchMedia?.(query).matches ?? false
  } catch {
    return false
  }
}

export function isInstalledMobileWebApp(): boolean {
  if (typeof window === 'undefined') return false
  const installed =
    matches('(display-mode: standalone)') ||
    matches('(display-mode: fullscreen)') ||
    (window.navigator as {standalone?: boolean}).standalone === true
  return installed && matches('(pointer: coarse)')
}
