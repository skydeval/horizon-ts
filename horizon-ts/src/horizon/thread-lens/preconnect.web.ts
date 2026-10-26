/*
 * The browser's connection to prism, opened ahead of the first thread
 * (2026-10-26, Prism's item 4): a `preconnect` hint, so a cold thread's
 * `getThread` does not wait for DNS, TCP and TLS. Added while Thread Lens is
 * active for the current account (`TokenPrefetch.tsx`) and removed with it,
 * so a reader without the lens never contacts prism.
 */

import {PRISM_URL} from '#/horizon/routing/prism'

/** Add the hint; returns the function that removes it. */
export function preconnectPrism(): () => void {
  if (typeof document === 'undefined') return () => {}
  let origin: string
  try {
    origin = new URL(PRISM_URL).origin
  } catch {
    return () => {}
  }
  const link = document.createElement('link')
  link.rel = 'preconnect'
  link.href = origin
  // The direct calls carry an Authorization header, so they are CORS.
  link.crossOrigin = 'anonymous'
  document.head.appendChild(link)
  return () => link.remove()
}
