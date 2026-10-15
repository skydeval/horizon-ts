/*
 * Which failures mean "sign in again".
 *
 * Adapted from the Witchsky client (MIT), src/state/session/ephemeral-auth.ts.
 */

/**
 * Thrown by Horizon when it decides an OAuth session is over (the server
 * refused it, or no session is stored), so callers can offer a fresh sign-in.
 */
export class OAuthSessionEndedError extends Error {
  constructor(message = 'The OAuth session has ended') {
    super(message)
    this.name = 'OAuthSessionEndedError'
  }
}

/**
 * Thrown when waiting on the OAuth session store took too long, for example
 * because another tab holds the refresh lock. Not an auth error: the session
 * may be fine.
 */
export class OAuthSessionBusyError extends Error {
  constructor() {
    super('Timed out waiting for the stored OAuth session')
    this.name = 'OAuthSessionBusyError'
  }
}

/**
 * The XRPC errors with which a PDS refuses the access token itself.
 * aurora-locus answers `AuthenticationRequired` for every token refusal.
 */
export const TOKEN_ERRORS: readonly string[] = [
  'AuthenticationRequired',
  'InvalidToken',
  'ExpiredToken',
]

/**
 * Whether an HTTP status and XRPC error name are a refusal of the access
 * token (as opposed to a refusal of the action, which is a 403 or another
 * error name).
 */
export function isTokenRefusal(status: number, error: string | undefined) {
  return status === 401 && !!error && TOKEN_ERRORS.includes(error)
}

const AUTH_ERROR_PATTERN =
  /ScopeMissing|Missing required scope|TokenInvalid|TokenExpired|TokenRevoked|TokenRefreshError|invalid_grant|InvalidToken|ExpiredToken|AuthRequired|AuthenticationRequired|SessionNotFound|Session not found|Unknown session|No session|Expected an active session|OAuthSessionEndedError/i

const AUTH_MESSAGE_PATTERN =
  /^(?:The session was (?:deleted by another process|revoked)|The session for ".+" (?:is invalid|was successfully revoked)|No refresh token available|Stored session sub mismatch|Token set sub mismatch)$/

/**
 * Whether an error means the account must sign in again. Network failures,
 * timeouts and refusals of a single action are not auth errors.
 */
export function isAuthError(error: unknown): boolean {
  if (error instanceof OAuthSessionEndedError) return true
  if (error instanceof OAuthSessionBusyError) return false
  if (!error || typeof error !== 'object') return false
  const value = error as {
    status?: unknown
    error?: unknown
    code?: unknown
    name?: unknown
    message?: unknown
    cause?: unknown
  }
  if (value.status === 401) return true
  /*
   * The OAuth library's session errors keep the name `Error`, so their class
   * names alone miss a missing or invalid session. Match their messages too.
   */
  const text = [value.error, value.code, value.name, value.message]
    .filter(part => typeof part === 'string')
    .join(' ')
  const message = typeof value.message === 'string' ? value.message : ''
  return (
    AUTH_ERROR_PATTERN.test(text) ||
    AUTH_MESSAGE_PATTERN.test(message) ||
    (value.cause !== error && isAuthError(value.cause))
  )
}
