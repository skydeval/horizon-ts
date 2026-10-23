/*
 * The OAuth library's cross-tab lock on a stored session.
 *
 * `@atproto/oauth-client` reads (and, when due, refreshes) a stored session
 * inside `runtime.usingLock('@atproto-oauth-client-' + sub, ...)`
 * (dist/session-getter.js), and `@atproto/oauth-client-browser` implements
 * that lock as an exclusive Web Lock (dist/browser-runtime-implementation.js).
 * Every tab and every document of this origin shares it, so a document that
 * holds it and is then frozen (the back/forward cache) stalls every other
 * restore of that account until it is thawed or discarded.
 */

/**
 * The Web Lock name the OAuth library takes around a session read or refresh.
 */
export function oauthLockName(did: string) {
  return `@atproto-oauth-client-${did}`
}

/**
 * How a wait on the lock ended: `free` once it was granted (and released at
 * once), `timeout` after `ms`, `unavailable` where there are no Web Locks or
 * the request failed.
 */
export type OAuthLockWait = 'free' | 'timeout' | 'unavailable'

function webLocks(): LockManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  const locks = (navigator as {locks?: LockManager}).locks
  return typeof locks?.request === 'function' ? locks : undefined
}

/**
 * Wait until the OAuth lock for `did` is free, at most `ms`. Takes the lock
 * only to learn that it is free and does nothing inside it, so it never
 * reads, refreshes or writes the session. The request queues behind every
 * holder and waiter, this tab's own restores included; a timeout withdraws
 * it from the queue.
 */
export async function waitForOAuthLock(
  did: string,
  ms: number,
): Promise<OAuthLockWait> {
  const locks = webLocks()
  if (!locks) return 'unavailable'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    await locks.request(
      oauthLockName(did),
      {mode: 'exclusive', signal: controller.signal},
      () => undefined,
    )
    return 'free'
  } catch {
    // Anything but our own abort (a document without lock access): no lock.
    return controller.signal.aborted ? 'timeout' : 'unavailable'
  } finally {
    clearTimeout(timer)
  }
}
