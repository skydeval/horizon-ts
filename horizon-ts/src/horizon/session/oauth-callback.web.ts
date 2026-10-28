/*
 * Completing an OAuth sign-in at the callback route.
 *
 * Adapted from the Witchsky client (MIT),
 * src/state/session/oauth-appview-switch.ts (`readOAuthCallbackParams`,
 * `completeWebOAuth`); the AppView-switch record is not carried over.
 */

import {
  type BrowserOAuthClient,
  type OAuthSession,
} from '@atproto/oauth-client-browser'

import {getOAuthClient} from '#/horizon/session/oauth-client'
import {OAUTH_CALLBACK_PATH} from '#/horizon/session/oauth-metadata'
import {clearPendingSignIn} from '#/horizon/session/oauth-return-url'

/**
 * The callback parameters from the fragment or the query, read before the
 * library clears them, or `undefined` when this URL carries none.
 */
export function readOAuthCallbackParams(): URLSearchParams | undefined {
  if (typeof window === 'undefined') return undefined
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const query = new URLSearchParams(window.location.search)
  for (const params of [hash, query]) {
    if (params.has('state') && (params.has('code') || params.has('error'))) {
      return params
    }
  }
  return undefined
}

/**
 * Whether this window opened on the callback route with callback parameters
 * (a page-mode return or a popup). Such a load must not resume the last
 * account: a popup would start a second refresh of the same single-use
 * refresh token, and a page-mode return would race its own login.
 */
export function isOAuthCallbackLoad(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.location.pathname === OAUTH_CALLBACK_PATH &&
    !!readOAuthCallbackParams()
  )
}

let completion: Promise<boolean> | undefined

async function completeCallback(
  params: URLSearchParams,
  login: (session: OAuthSession, state: string | null) => Promise<void>,
) {
  clearPendingSignIn()
  // This file runs on web only, where the client is the browser one
  const client = getOAuthClient() as unknown as BrowserOAuthClient
  const result = await client.initCallback(params)
  await login(result.session, result.state)
  return true
}

/**
 * Complete the authorization exchange once, shared by every caller. Resolves
 * `true` after `login` ran, `false` when the URL carries no callback and no
 * exchange is in flight. In a popup the library hands the result to the
 * opener and rejects with `LOGIN_CONTINUED_IN_PARENT_WINDOW`.
 */
export function completeWebOAuth(
  login: (session: OAuthSession, state: string | null) => Promise<void>,
): Promise<boolean> {
  if (completion) return completion
  const params = readOAuthCallbackParams()
  if (!params) return Promise.resolve(false)
  const operation = completeCallback(params, login)
  completion = operation
  const clear = () => {
    if (completion === operation) completion = undefined
  }
  operation.then(clear, clear)
  return operation
}
