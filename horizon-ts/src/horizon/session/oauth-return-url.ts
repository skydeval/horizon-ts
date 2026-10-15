/*
 * Native stub of `oauth-return-url.web.ts`: there are no page-mode sign-ins
 * on this platform, so nothing is saved and nothing is pending.
 */

/**
 * Same value as on web; unused here.
 */
export const PENDING_SIGN_IN_MAX_AGE_MS = 30 * 60_000

/**
 * A page-mode sign-in that left for the authorization server.
 */
export type PendingSignIn = {
  identifier: string
  startedAt: number
}

/**
 * No-op on this platform.
 */
export function saveOAuthReturnUrl(_url?: string) {}

/**
 * Nothing is saved on this platform.
 */
export function consumeOAuthReturnUrl(): string | undefined {
  return undefined
}

/**
 * No-op on this platform.
 */
export function saveOAuthCallbackError(_error: string) {}

/**
 * Nothing is saved on this platform.
 */
export function consumeOAuthCallbackError(): string | undefined {
  return undefined
}

/**
 * No-op on this platform.
 */
export function savePendingSignIn(_identifier: string, _now?: number) {}

/**
 * No-op on this platform.
 */
export function clearPendingSignIn() {}

/**
 * Nothing is pending on this platform.
 */
export function takePendingSignIn(_now?: number): PendingSignIn | undefined {
  return undefined
}
