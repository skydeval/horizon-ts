/**
 * Native stub of `oauth-signup.web.ts`: OAuth sign-in is not available on
 * this platform yet, so the signup picker always takes the password path.
 */
export function startOAuthSignup(_serviceUrl: string): Promise<void> {
  return Promise.reject(
    new Error('OAuth sign-in is not available on this platform'),
  )
}
