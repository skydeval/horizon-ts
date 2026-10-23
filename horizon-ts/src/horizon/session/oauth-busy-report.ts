/*
 * A resume that gave up because its OAuth session stayed busy in another
 * document (see `oauth-lock.ts`). Kept apart from the toast that shows it
 * (`oauth-busy-notice.tsx`), so the session layer does not load the UI.
 */

let pending = false
const listeners = new Set<() => void>()

/**
 * Report that resuming an account gave up because its session stayed busy.
 * At launch this lands before the toast outlet is mounted, so it is held
 * until `OAuthBusyNotice` takes it.
 */
export function reportOAuthBusyResume() {
  pending = true
  for (const listener of listeners) listener()
}

/**
 * Take a held report: true once per report.
 */
export function takeOAuthBusyReport() {
  const was = pending
  pending = false
  return was
}

/**
 * Call `listener` on every later report. Returns the unsubscribe.
 */
export function subscribeOAuthBusyReports(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Forget a held report (tests).
 */
export function resetOAuthBusyReport() {
  pending = false
}
