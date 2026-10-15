/**
 * How long Horizon waits on a stored-session read or a `getSession` check
 * before giving up on it. Never applied to a token refresh.
 */
export const OAUTH_WAIT_MS = 10_000

/**
 * Resolve or reject with `promise`, or reject with `onTimeout()` after `ms`.
 * The underlying work is not cancelled; its late result is dropped.
 */
export function bounded<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
