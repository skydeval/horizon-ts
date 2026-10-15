/*
 * The in-place sign-in window: switching to an account whose session has
 * ended opens a sign-in window over the current page instead of the
 * signed-out screen, so the user signs in again without losing their place.
 * It has the same two tabs as the sign-in screen; signing in to a different
 * account than the one offered is accepted (a sign-in window, not a
 * credential check). The request store is `in-place-store.ts`.
 */

import {useEffect, useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {DEFAULT_SERVICE} from '#/lib/constants'
import {useServiceQuery} from '#/state/queries/service'
import {type SessionAccount} from '#/state/session'
import {useLoggedOutViewControls} from '#/state/shell/logged-out'
import {LoginForm} from '#/screens/Login/LoginForm'
import {atoms as a, web} from '#/alf'
import * as Dialog from '#/components/Dialog'
import {Text} from '#/components/Typography'
import {
  closeInPlaceSignIn,
  type InPlaceSignInRequest,
  useInPlaceSignInRequest,
} from '#/horizon/auth/in-place-store'
import {SignInTabs} from '#/horizon/auth/SignInTabs'

export {
  closeInPlaceSignIn,
  type InPlaceSignInRequest,
  openInPlaceSignIn,
  readInPlaceSignIn,
} from '#/horizon/auth/in-place-store'

/**
 * The stock password form, with the state the stock sign-in screen keeps for
 * it (hosting provider, its description, the error).
 */
function InPlacePasswordForm({
  account,
  onPressBack,
  onPressForgotPassword,
}: {
  account: SessionAccount
  onPressBack: () => void
  onPressForgotPassword: () => void
}) {
  const {t: l} = useLingui()
  const [error, setError] = useState('')
  const [serviceUrl, setServiceUrl] = useState(
    account.service || DEFAULT_SERVICE,
  )
  const {
    data: serviceDescription,
    error: serviceError,
    refetch,
  } = useServiceQuery(serviceUrl)
  const shownError =
    error ||
    (serviceError
      ? l`Unable to contact your service. Please check your Internet connection.`
      : '')

  return (
    <LoginForm
      error={shownError}
      serviceUrl={serviceUrl}
      serviceDescription={serviceDescription}
      initialHandle={account.handle}
      setError={setError}
      setServiceUrl={setServiceUrl}
      onPressRetryConnect={() => void refetch()}
      onPressBack={onPressBack}
      onPressForgotPassword={onPressForgotPassword}
      onAttemptSuccess={() => {}}
      onAttemptFailed={() => {}}
      onPressCreateAccount={() => {}}
    />
  )
}

function InPlaceSignInInner({
  request,
  control,
}: {
  request: InPlaceSignInRequest
  control: Dialog.DialogControlProps
}) {
  const {t: l} = useLingui()
  const {requestSwitchToAccount} = useLoggedOutViewControls()
  const {account} = request

  const onPressForgotPassword = () => {
    closeInPlaceSignIn({cancelled: false})
    control.close(() => {
      requestSwitchToAccount({requestedAccount: account.did})
    })
  }

  return (
    <Dialog.ScrollableInner
      label={l`Sign in again`}
      style={web({maxWidth: 480})}>
      <View style={[a.gap_md, a.pb_md]}>
        <Text style={[a.text_xl, a.font_semi_bold, a.leading_snug]}>
          <Trans>Sign in as @{account.handle}</Trans>
        </Text>
        <Text style={[a.text_sm, a.leading_snug]}>
          <Trans>
            This account's session has ended. Sign in again to switch to it.
          </Trans>
        </Text>
      </View>
      <SignInTabs
        initialHandle={account.handle}
        requestedAccount={account}
        oauthMode="in-place"
        onPressBack={() => control.close()}
        passwordForm={
          <InPlacePasswordForm
            account={account}
            onPressBack={() => control.close()}
            onPressForgotPassword={onPressForgotPassword}
          />
        }
      />
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

/**
 * The window, mounted once by `HorizonHost`. A successful sign-in switches
 * accounts, which remounts the app below the session and closes the window
 * without undoing anything.
 */
export function InPlaceSignInWindow() {
  const request = useInPlaceSignInRequest()
  const control = Dialog.useDialogControl()

  useEffect(() => {
    if (request) control.open()
  }, [request, control])

  useEffect(() => {
    return () => closeInPlaceSignIn({cancelled: false})
  }, [])

  return (
    <Dialog.Outer
      control={control}
      onClose={() => closeInPlaceSignIn({cancelled: true})}>
      <Dialog.Handle />
      {request && <InPlaceSignInInner request={request} control={control} />}
    </Dialog.Outer>
  )
}
