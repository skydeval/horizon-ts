import {useEffect} from 'react'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {useLoggedOutViewControls} from '#/state/shell/logged-out'
import * as Toast from '#/components/Toast'
import {setStalledSignIn} from '#/horizon/auth/sign-in-notices'
import {isOAuthCallbackLoad} from '#/horizon/session/oauth-callback'
import {
  type PendingSignIn,
  takePendingSignIn,
} from '#/horizon/session/oauth-return-url'

/**
 * Whether this page load opened on the OAuth callback; read at module load,
 * before the library clears the callback parameters.
 */
const LAUNCHED_ON_CALLBACK = isOAuthCallbackLoad()

let launchChecked = false

/**
 * Take the pending sign-in record once per page load. A load on the callback
 * route leaves it to the callback, which clears it.
 */
export function takeStalledSignInAtLaunch(): PendingSignIn | undefined {
  if (launchChecked) return undefined
  launchChecked = true
  if (LAUNCHED_ON_CALLBACK) return undefined
  return takePendingSignIn()
}

/**
 * Allow the launch check to run again (tests).
 */
export function resetStalledSignInCheck() {
  launchChecked = false
}

/**
 * A page-mode sign-in that left for the server and never came back (an
 * expired request on aurora-locus shows the server's own page). At launch,
 * signed out: open the sign-in form, whose OAuth tab offers **Try again**
 * with the identifier filled. Signed in: a toast with **Try again**.
 */
export function StalledSignInCheck() {
  const {t: l} = useLingui()
  const {accounts, hasSession} = useSession()
  const {requestSwitchToAccount} = useLoggedOutViewControls()

  useEffect(() => {
    const stalled = takeStalledSignInAtLaunch()
    if (!stalled) return
    setStalledSignIn(stalled)
    const known = accounts.find(
      account =>
        account.handle === stalled.identifier ||
        account.did === stalled.identifier,
    )
    const openSignIn = () =>
      requestSwitchToAccount({requestedAccount: known?.did ?? 'none'})
    if (!hasSession) {
      openSignIn()
      return
    }
    Toast.show(
      <Toast.Outer>
        <Toast.Icon />
        <Toast.Text>
          <Trans>Did signing in at your server stop?</Trans>
        </Toast.Text>
        <Toast.Action label={l`Try again`} onPress={openSignIn}>
          <Trans>Try again</Trans>
        </Toast.Action>
      </Toast.Outer>,
      {type: 'warning'},
    )
  }, [accounts, hasSession, l, requestSwitchToAccount])

  return null
}
