/*
 * Keep local development on one origin.
 *
 * Adapted from the Witchsky client (MIT), src/App.web.tsx (the `localhost`
 * to `127.0.0.1` redirect).
 */

/**
 * Replace `localhost` with `127.0.0.1` in the page URL. The atproto loopback
 * client redirects to `127.0.0.1`, and OAuth state lives in IndexedDB, which
 * is per origin, so sign-in and its callback must use the same host. Does
 * nothing on any other host.
 */
export function redirectLocalhostToLoopbackIp() {
  if (typeof window === 'undefined') return
  if (window.location.hostname !== 'localhost') return
  const url = new URL(window.location.href)
  url.hostname = '127.0.0.1'
  window.location.replace(url.href)
}
