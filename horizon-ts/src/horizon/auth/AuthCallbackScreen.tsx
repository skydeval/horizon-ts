/*
 * The `/auth/web/callback` screen: completes an OAuth sign-in.
 *
 * Adapted from the Witchsky client (MIT),
 * src/screens/Login/AuthCallback.tsx.
 */

import {useEffect} from 'react'
import {View} from 'react-native'
import {type OAuthSession} from '@atproto/oauth-client-browser'
import {Trans, useLingui} from '@lingui/react/macro'
import {StackActions, useNavigation} from '@react-navigation/native'

import {type NavigationProp} from '#/lib/routes/types'
import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {useSession, useSessionApi} from '#/state/session'
import {readLastActiveAccount} from '#/state/session/util'
import {useLoggedOutViewControls} from '#/state/shell/logged-out'
import {atoms as a} from '#/alf'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {
  isOauthAccount,
  isOAuthSignedOut,
  isSignedInAccount,
} from '#/horizon/session/accounts'
import {
  AccountMismatchError,
  assertExpectedAccount,
  decodeExpectedDidState,
} from '#/horizon/session/expected-account'
import {useHorizonSessionApi} from '#/horizon/session/HorizonSessionProvider'
import {completeWebOAuth} from '#/horizon/session/oauth-callback'
import {isOAuthPopupComplete} from '#/horizon/session/oauth-metadata'
import {
  consumeOAuthReturnUrl,
  saveOAuthCallbackError,
} from '#/horizon/session/oauth-return-url'
import {router} from '#/routes'

/**
 * Move the page URL to `path` without navigating. Signing in changes the DID
 * that keys the whole tree, so the navigator unmounts at once and picks the
 * URL up when it remounts; a later `navigate` would be too late.
 */
function replaceUrl(path: string) {
  history.replaceState(null, '', path)
}

/**
 * Completes the exchange, then: moves the URL to where the user started (or
 * `/`) before signing in, because signing in remounts the app. In a popup the
 * library hands the result to the opener and the popup closes. On failure the
 * error is kept for the sign-in form, and the last account is resumed if it
 * still has a session; otherwise the sign-in form opens with the error.
 */
export function AuthCallbackScreen() {
  const {t: l} = useLingui()
  const navigation = useNavigation<NavigationProp>()
  const {accounts} = useSession()
  const {resumeSession} = useSessionApi()
  const {loginWithOAuth} = useHorizonSessionApi()
  const {requestSwitchToAccount, setShowLoggedOut} = useLoggedOutViewControls()

  useEffect(() => {
    const login = async (session: OAuthSession, state: string | null) => {
      // Refuse a different account than the one the sign-in was started for.
      await assertExpectedAccount(session, decodeExpectedDidState(state), did =>
        accounts.some(
          account =>
            account.did === did &&
            isOauthAccount(account) &&
            !isOAuthSignedOut(account),
        ),
      )
      replaceUrl(consumeOAuthReturnUrl() ?? '/')
      await loginWithOAuth(session)
      setShowLoggedOut(false)
    }

    const run = async () => {
      try {
        const completed = await completeWebOAuth(login)
        if (!completed) {
          // No callback here and no exchange in flight: never log in twice.
          navigation.replace('Home')
        }
      } catch (e) {
        if (isOAuthPopupComplete(e)) return
        const message = e instanceof Error ? e.message : String(e)
        logger.error('OAuth callback failed', {error: message})
        if (e instanceof AccountMismatchError) {
          const asked = e.expectedHandle
            ? `@${e.expectedHandle}`
            : e.expectedDid
          const got = e.actualHandle ? `@${e.actualHandle}` : e.actualDid
          saveOAuthCallbackError(
            l`Your server signed you in as ${got}, not ${asked}. It used the account you're signed in to on its own website. Sign out there, or switch to ${asked}, then try again.`,
          )
        } else if (/access[_ ]denied/i.test(message)) {
          // The user cancelled at the server (or declined consent).
          saveOAuthCallbackError(l`Sign-in was cancelled.`)
        } else {
          saveOAuthCallbackError(cleanError(message))
        }
        const returnUrl = consumeOAuthReturnUrl() ?? '/'
        const lastAccount = readLastActiveAccount()
        if (
          lastAccount &&
          isSignedInAccount(lastAccount, !!lastAccount.refreshJwt)
        ) {
          try {
            replaceUrl(returnUrl)
            await resumeSession(lastAccount)
            return
          } catch (resumeError) {
            logger.error('OAuth callback: resuming the last account failed', {
              error:
                resumeError instanceof Error
                  ? resumeError.message
                  : String(resumeError),
            })
          }
        }
        requestSwitchToAccount({requestedAccount: lastAccount?.did ?? 'none'})
        // Nothing remounts here, so navigate to the return path in the app.
        const [name, params] = router.matchPath(
          new URL(returnUrl, window.location.origin).pathname,
        )
        navigation.dispatch(StackActions.replace(name, params))
      }
    }

    void run()
    // The callback runs once per load; `accounts` and `l` are read as they are then.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loginWithOAuth,
    navigation,
    requestSwitchToAccount,
    resumeSession,
    setShowLoggedOut,
  ])

  return (
    <View
      style={[a.flex_1, a.align_center, a.justify_center, a.gap_md, a.p_xl]}>
      <Loader size="xl" />
      <Text style={[a.text_md]}>
        <Trans>Signing in…</Trans>
      </Text>
    </View>
  )
}
