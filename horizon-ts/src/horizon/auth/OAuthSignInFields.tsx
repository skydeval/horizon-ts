/*
 * The OAuth tab of the sign-in form.
 *
 * Adapted from the Witchsky client (MIT),
 * src/screens/Login/LoginForm.web.tsx (the OAuth field and submit).
 */

import {useRef, useState} from 'react'
import {Keyboard, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {cleanError, isNetworkError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {useSession} from '#/state/session'
import {atoms as a} from '#/alf'
import * as Admonition from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as TextField from '#/components/forms/TextField'
import {At_Stroke2_Corner0_Rounded as AtIcon} from '#/components/icons/At'
import {Loader} from '#/components/Loader'
import {
  clearCallbackError,
  clearStalledSignIn,
  getCallbackError,
  getStalledSignIn,
} from '#/horizon/auth/sign-in-notices'
import {AppViewButton} from '#/horizon/routing/AppViewSwitcher'
import {isOauthAccount, isOAuthSignedOut} from '#/horizon/session/accounts'
import {
  AccountMismatchError,
  assertExpectedAccount,
  encodeExpectedDidState,
  resolveExpectedDid,
} from '#/horizon/session/expected-account'
import {useHorizonSessionApi} from '#/horizon/session/HorizonSessionProvider'
import {cleanSignInIdentifier} from '#/horizon/session/identifier'
import {getOAuthClient} from '#/horizon/session/oauth-client'
import {getOAuthDisplay} from '#/horizon/session/oauth-display'
import {OAUTH_SCOPE} from '#/horizon/session/oauth-metadata'
import {
  saveOAuthReturnUrl,
  savePendingSignIn,
} from '#/horizon/session/oauth-return-url'

/**
 * Leave for the authorization server in this tab. The return URL and a
 * pending sign-in record are saved first, so the user comes back to where
 * they started, and a server that never sends them back can be retried. The
 * requested account's DID rides in the OAuth `state`, so the callback can
 * refuse a different account.
 */
async function signInInThisTab(identifier: string) {
  const expectedDid = await resolveExpectedDid(identifier)
  saveOAuthReturnUrl()
  savePendingSignIn(identifier)
  await getOAuthClient().signIn(identifier, {
    scope: OAUTH_SCOPE,
    state: encodeExpectedDidState(expectedDid),
  })
}

/**
 * The OAuth tab: one field for a handle, DID or server address, then the
 * authorization server's own sign-in.
 *
 * - `page` (the main sign-in): the page redirects; the callback route signs
 *   the account in.
 * - `in-place` (the in-place window): a popup, so the page and its state stay
 *   put, with **Continue in this tab** while it is open in case the browser
 *   blocked it. An installed web app always redirects instead.
 */
export function OAuthSignInFields({
  initialHandle = '',
  mode = 'page',
  onPressBack,
  onSignedIn,
}: {
  initialHandle?: string
  mode?: 'page' | 'in-place'
  onPressBack?: () => void
  onSignedIn?: () => void
}) {
  const {t: l} = useLingui()
  const {accounts} = useSession()
  const {loginWithOAuth} = useHorizonSessionApi()
  const stalled = getStalledSignIn()
  const [identifier, setIdentifier] = useState(
    initialHandle || stalled?.identifier || '',
  )
  const [error, setError] = useState(() => getCallbackError() ?? '')
  const [showStalled, setShowStalled] = useState(!!stalled)
  const [isProcessing, setIsProcessing] = useState(false)
  const [popupOpen, setPopupOpen] = useState(false)
  const popupAbort = useRef<AbortController | null>(null)
  const continuedInTab = useRef(false)

  const showError = (e: unknown) => {
    const message = String(e)
    if (e instanceof AccountMismatchError) {
      logger.warn('oauth sign-in: server signed in a different account', {
        expectedDid: e.expectedDid,
        actualDid: e.actualDid,
      })
      const asked = e.expectedHandle ? `@${e.expectedHandle}` : e.expectedDid
      const got = e.actualHandle ? `@${e.actualHandle}` : e.actualDid
      setError(
        l`Your server signed you in as ${got}, not ${asked}. It used the account you're signed in to on its own website. Sign out there, or switch to ${asked}, then try again.`,
      )
    } else if (isNetworkError(e)) {
      logger.warn('oauth sign-in: network error', {error: message})
      setError(
        l`Unable to contact your service. Please check your Internet connection.`,
      )
    } else {
      logger.warn('oauth sign-in: failed', {error: message})
      setError(cleanError(e))
    }
  }

  const continueInThisTab = async () => {
    continuedInTab.current = true
    popupAbort.current?.abort()
    setPopupOpen(false)
    setIsProcessing(true)
    try {
      await signInInThisTab(cleanSignInIdentifier(identifier))
    } catch (e) {
      setIsProcessing(false)
      showError(e)
    }
  }

  const onPressNext = async () => {
    if (isProcessing) return
    Keyboard.dismiss()
    setError('')
    clearCallbackError()
    setShowStalled(false)
    clearStalledSignIn()
    const value = cleanSignInIdentifier(identifier)
    if (!value) {
      setError(l`Please enter your handle, DID or server address`)
      return
    }
    setIsProcessing(true)
    continuedInTab.current = false
    try {
      if (mode === 'page' || getOAuthDisplay() === 'page') {
        await signInInThisTab(value)
        return
      }
      const expectedDid = await resolveExpectedDid(value)
      const abort = new AbortController()
      popupAbort.current = abort
      setPopupOpen(true)
      const session = await getOAuthClient().signIn(value, {
        scope: OAUTH_SCOPE,
        display: 'popup',
        signal: abort.signal,
      })
      setPopupOpen(false)
      await assertExpectedAccount(session, expectedDid, did =>
        accounts.some(
          account =>
            account.did === did &&
            isOauthAccount(account) &&
            !isOAuthSignedOut(account),
        ),
      )
      await loginWithOAuth(session)
      onSignedIn?.()
    } catch (e) {
      if (continuedInTab.current) {
        // "Continue in this tab" aborted the popup and took over.
        return
      }
      setPopupOpen(false)
      setIsProcessing(false)
      showError(e)
    } finally {
      popupAbort.current = null
    }
  }

  return (
    <View style={[a.gap_md]}>
      {showStalled && (
        <Admonition.Outer type="warning">
          <Admonition.Row>
            <Admonition.Icon />
            <Admonition.Content>
              <Admonition.Text>
                <Trans>Did signing in at your server stop? Try again.</Trans>
              </Admonition.Text>
            </Admonition.Content>
            <Admonition.Button
              label={l`Try again`}
              color="secondary"
              onPress={() => void onPressNext()}>
              <ButtonText>
                <Trans>Try again</Trans>
              </ButtonText>
            </Admonition.Button>
          </Admonition.Row>
        </Admonition.Outer>
      )}
      <View>
        <TextField.LabelText>
          <Trans>Handle, DID or server address</Trans>
        </TextField.LabelText>
        <TextField.Root isInvalid={!!error}>
          <TextField.Icon icon={AtIcon} />
          <TextField.Input
            testID="oauthIdentifierInput"
            label={l`Handle, DID or server address`}
            placeholder={null}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            autoFocus={!identifier}
            returnKeyType="go"
            editable={!isProcessing}
            value={identifier}
            onChangeText={value => {
              setIdentifier(value)
              if (error) setError('')
            }}
            onSubmitEditing={() => void onPressNext()}
            accessibilityHint={l`Your handle, your account's DID, or the address of the server that hosts your account`}
          />
        </TextField.Root>
      </View>
      {error ? (
        <Admonition.Admonition type="error">{error}</Admonition.Admonition>
      ) : null}
      {popupOpen && (
        <Admonition.Outer type="info">
          <Admonition.Row>
            <Admonition.Icon />
            <Admonition.Content>
              <Admonition.Text>
                <Trans>
                  Finish signing in in the window that opened. If no window
                  opened, continue in this tab.
                </Trans>
              </Admonition.Text>
            </Admonition.Content>
            <Admonition.Button
              label={l`Continue in this tab`}
              color="secondary"
              onPress={() => void continueInThisTab()}>
              <ButtonText>
                <Trans>Continue in this tab</Trans>
              </ButtonText>
            </Admonition.Button>
          </Admonition.Row>
        </Admonition.Outer>
      )}
      <View style={[a.flex_row, a.align_center, a.gap_sm, a.pt_md]}>
        {onPressBack && (
          <Button
            label={l`Back`}
            color="secondary"
            size="large"
            onPress={onPressBack}>
            <ButtonText>
              <Trans>Back</Trans>
            </ButtonText>
          </Button>
        )}
        {mode === 'page' && <AppViewButton />}
        <View style={a.flex_1} />
        <Button
          testID="oauthNextButton"
          label={l`Next`}
          accessibilityHint={l`Continues to your server's sign-in page`}
          color="primary"
          size="large"
          disabled={isProcessing}
          onPress={() => void onPressNext()}>
          <ButtonText>
            <Trans>Next</Trans>
          </ButtonText>
          {isProcessing && <ButtonIcon icon={Loader} />}
        </Button>
      </View>
    </View>
  )
}
