/*
 * The two-tab sign-in form: OAuth (default) and Password (the stock form).
 *
 * Adapted from the Witchsky client (MIT),
 * src/screens/Login/LoginForm.web.tsx (the tab row); mounted beside the stock
 * form instead of replacing it, and the last tab is remembered.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {type SessionAccount, useSession} from '#/state/session'
import {atoms as a, useBreakpoints, useGutters} from '#/alf'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import {OAuthSignInFields} from '#/horizon/auth/OAuthSignInFields'
import {
  getCallbackError,
  getStalledSignIn,
} from '#/horizon/auth/sign-in-notices'
import {isOauthAccount} from '#/horizon/session/accounts'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {OAUTH_AVAILABLE} from '#/horizon/session/oauth-client'

/**
 * The device key that remembers the last tab used.
 */
export const LAST_TAB_KEY = 'horizon.signIn.lastTab'

/**
 * A sign-in tab.
 */
export type SignInTab = 'oauth' | 'password'

/**
 * Which tab opens: OAuth when an OAuth sign-in just failed (its error shows
 * only there), otherwise the known account's kind when the form was opened
 * for one, otherwise the last tab used, otherwise OAuth. Password alone where
 * OAuth is not available.
 */
export function initialSignInTab(
  account: SessionAccount | undefined,
): SignInTab {
  if (!OAUTH_AVAILABLE) return 'password'
  if (getCallbackError()) return 'oauth'
  if (account) return isOauthAccount(account) ? 'oauth' : 'password'
  if (getStalledSignIn()) return 'oauth'
  return readLocal(LAST_TAB_KEY) === 'password' ? 'password' : 'oauth'
}

/**
 * The sign-in form with a tab row. The Password tab is the stock form passed
 * in, so 2FA, the hosting provider control and password reset stay stock.
 */
export function SignInTabs({
  initialHandle = '',
  requestedAccount,
  passwordForm,
  onPressBack,
  oauthMode = 'page',
  onOAuthSignedIn,
}: {
  initialHandle?: string
  /** The account the form was opened for, if any. */
  requestedAccount?: SessionAccount
  passwordForm: React.ReactNode
  onPressBack?: () => void
  oauthMode?: 'page' | 'in-place'
  onOAuthSignedIn?: () => void
}) {
  const {t: l} = useLingui()
  const {accounts} = useSession()
  const {gtMobile} = useBreakpoints()
  const gutter = useGutters([0, 'wide'])
  const knownAccount =
    requestedAccount ??
    (initialHandle
      ? accounts.find(account => account.handle === initialHandle)
      : undefined)
  const [tab, setTab] = useState<SignInTab>(() =>
    initialSignInTab(knownAccount),
  )

  if (!OAUTH_AVAILABLE) {
    return <>{passwordForm}</>
  }

  const onChangeTab = (next: SignInTab) => {
    setTab(next)
    writeLocal(LAST_TAB_KEY, next)
  }

  return (
    <View style={[a.flex_1, a.gap_md]}>
      <View style={[!gtMobile && gutter]}>
        <SegmentedControl.Root
          type="tabs"
          label={l`Sign-in method`}
          value={tab}
          onChange={onChangeTab}>
          <SegmentedControl.Item
            testID="signInOAuthTab"
            value="oauth"
            label={l`OAuth`}>
            <SegmentedControl.ItemText>{l`OAuth`}</SegmentedControl.ItemText>
          </SegmentedControl.Item>
          <SegmentedControl.Item
            testID="signInPasswordTab"
            value="password"
            label={l`Password`}>
            <SegmentedControl.ItemText>{l`Password`}</SegmentedControl.ItemText>
          </SegmentedControl.Item>
        </SegmentedControl.Root>
      </View>
      {tab === 'oauth' ? (
        <View style={[!gtMobile && gutter]}>
          <OAuthSignInFields
            initialHandle={initialHandle}
            mode={oauthMode}
            onPressBack={onPressBack}
            onSignedIn={onOAuthSignedIn}
          />
        </View>
      ) : (
        passwordForm
      )}
    </View>
  )
}
