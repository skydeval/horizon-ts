/*
 * OAuth account creation (`prompt=create`) at a server that advertises it.
 *
 * Adapted from the Witchsky client (MIT),
 * src/screens/Signup/startOauthSignup.web.ts.
 */

import {getOAuthClient} from '#/horizon/session/oauth-client'
import {OAUTH_SCOPE} from '#/horizon/session/oauth-metadata'
import {saveOAuthReturnUrl} from '#/horizon/session/oauth-return-url'

/**
 * Leave for the server's account-creation page in this tab, with the return
 * URL saved. The callback signs the new account in like any OAuth sign-in.
 */
export async function startOAuthSignup(serviceUrl: string) {
  saveOAuthReturnUrl()
  await getOAuthClient().signIn(serviceUrl, {
    prompt: 'create',
    scope: OAUTH_SCOPE,
  })
}
