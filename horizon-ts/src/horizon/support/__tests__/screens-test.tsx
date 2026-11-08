import type * as ReactNative from 'react-native'
import {describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {
  HORIZON_PRIVACY_PATH,
  HORIZON_SUPPORT_PATH,
  HORIZON_TERMS_PATH,
} from '#/horizon/support/links'
import {
  HorizonPrivacyScreen,
  HorizonSupportScreen,
  HorizonTermsScreen,
} from '#/horizon/support/SupportScreens'
import {router} from '#/routes'

/*
 * Support, privacy and terms are app screens at their /about/support paths
 * (so links open them in the app, not a browser), and show their text.
 */

jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<typeof ReactNative>('react-native')
  return {Text, H2: Text}
})
jest.mock('#/components/Link', () => {
  const {Text} = jest.requireActual<typeof ReactNative>('react-native')
  return {
    InlineLinkText: ({children}: {children?: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/components/Layout', () => {
  const {View} = jest.requireActual<typeof ReactNative>('react-native')
  // Lower case, so the React Compiler leaves the mock factory alone
  const pass = ({children}: {children?: React.ReactNode}) => (
    <View>{children}</View>
  )
  const none = () => null
  return {
    Screen: pass,
    Content: pass,
    Header: {
      Outer: pass,
      BackButton: none,
      Content: pass,
      TitleText: pass,
      Slot: none,
    },
  }
})

i18n.loadAndActivate({locale: 'en', messages: {}})

function show(node: React.ReactElement) {
  return render(<I18nProvider i18n={i18n}>{node}</I18nProvider>)
}

const supportProps = {} as React.ComponentProps<typeof HorizonSupportScreen>
const privacyProps = {} as React.ComponentProps<typeof HorizonPrivacyScreen>
const termsProps = {} as React.ComponentProps<typeof HorizonTermsScreen>

describe('Horizon support screens', () => {
  it('are app routes', () => {
    expect(router.matchPath(HORIZON_SUPPORT_PATH)[0]).toBe('HorizonSupport')
    expect(router.matchPath(HORIZON_PRIVACY_PATH)[0]).toBe('HorizonPrivacy')
    expect(router.matchPath(HORIZON_TERMS_PATH)[0]).toBe('HorizonTerms')
  })

  it('show their text', () => {
    expect(
      show(<HorizonSupportScreen {...supportProps} />).getByText(
        'Report a bug or share an idea',
      ),
    ).toBeTruthy()
    expect(
      show(<HorizonPrivacyScreen {...privacyProps} />).getByText(
        'Data stored on your device',
      ),
    ).toBeTruthy()
    expect(
      show(<HorizonTermsScreen {...termsProps} />).getByText(
        'Limitation of liability',
      ),
    ).toBeTruthy()
  })
})
