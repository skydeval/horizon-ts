/*
 * What a page-mode OAuth sign-in leaves behind for the page it returns to:
 * the URL to go back to, a callback error for the sign-in form, and a pending
 * sign-in record.
 *
 * Adapted from the Witchsky client (MIT),
 * src/state/session/oauth-web-return-url.ts.
 */

import {OAUTH_CALLBACK_PATH} from '#/horizon/session/oauth-metadata'

const RETURN_URL_KEY = 'horizon.oauth.returnUrl'
const CALLBACK_ERROR_KEY = 'horizon.oauth.callbackError'
const PENDING_SIGN_IN_KEY = 'horizon.oauth.pendingSignIn'

/**
 * A pending sign-in older than this is dropped rather than offered again.
 */
export const PENDING_SIGN_IN_MAX_AGE_MS = 30 * 60_000

/**
 * A page-mode sign-in that left for the authorization server.
 */
export type PendingSignIn = {
  identifier: string
  startedAt: number
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

/**
 * Remember where to come back to after a page-mode sign-in (the current URL
 * unless given).
 */
export function saveOAuthReturnUrl(url?: string) {
  storage()?.setItem(RETURN_URL_KEY, url ?? window.location.href)
}

/**
 * Take the saved return URL as a same-origin path, never the callback route
 * itself, or `undefined`.
 */
export function consumeOAuthReturnUrl(): string | undefined {
  const store = storage()
  if (!store) return undefined
  const saved = store.getItem(RETURN_URL_KEY)
  store.removeItem(RETURN_URL_KEY)
  if (!saved) return undefined
  try {
    const url = new URL(saved, window.location.origin)
    if (url.origin !== window.location.origin) return undefined
    if (url.pathname === OAUTH_CALLBACK_PATH) return undefined
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return undefined
  }
}

/**
 * Keep a callback error for the sign-in form to show.
 */
export function saveOAuthCallbackError(error: string) {
  storage()?.setItem(CALLBACK_ERROR_KEY, error)
}

/**
 * Take the saved callback error, or `undefined`.
 */
export function consumeOAuthCallbackError(): string | undefined {
  const store = storage()
  if (!store) return undefined
  const error = store.getItem(CALLBACK_ERROR_KEY)
  store.removeItem(CALLBACK_ERROR_KEY)
  return error || undefined
}

/**
 * Record a page-mode sign-in about to leave for the authorization server.
 * If the server never sends the user back (aurora-locus shows its own page
 * for an expired request), the next load offers to try again.
 */
export function savePendingSignIn(identifier: string, now = Date.now()) {
  const record: PendingSignIn = {identifier, startedAt: now}
  storage()?.setItem(PENDING_SIGN_IN_KEY, JSON.stringify(record))
}

/**
 * Forget the pending sign-in; every callback does this.
 */
export function clearPendingSignIn() {
  storage()?.removeItem(PENDING_SIGN_IN_KEY)
}

/**
 * Take the pending sign-in record: it is removed either way, and returned
 * only when it is younger than {@link PENDING_SIGN_IN_MAX_AGE_MS}.
 */
export function takePendingSignIn(now = Date.now()): PendingSignIn | undefined {
  const store = storage()
  if (!store) return undefined
  const saved = store.getItem(PENDING_SIGN_IN_KEY)
  store.removeItem(PENDING_SIGN_IN_KEY)
  if (!saved) return undefined
  try {
    const record: unknown = JSON.parse(saved)
    if (
      !record ||
      typeof record !== 'object' ||
      !('identifier' in record) ||
      !('startedAt' in record) ||
      typeof record.identifier !== 'string' ||
      typeof record.startedAt !== 'number'
    ) {
      return undefined
    }
    const age = now - record.startedAt
    if (age < 0 || age > PENDING_SIGN_IN_MAX_AGE_MS) return undefined
    return {identifier: record.identifier, startedAt: record.startedAt}
  } catch {
    return undefined
  }
}
