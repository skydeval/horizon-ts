import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The Add dialog after Next (system accounts design 4.3), rendered with
 * React Compiler as the app is. The registration is one mutable object;
 * when the dialog's reads were memoised it kept the first value
 * (`undefined`) and went blank after Next on web. The design system is
 * replaced by plain views; the registration store is the real one.
 */

jest.mock('#/components/Dialog', () => {
  const {View} = jest.requireActual<{
    View: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {
    Outer: (props: {children?: React.ReactNode}) => (
      <View>{props.children}</View>
    ),
    Handle: () => null,
    Close: () => null,
    ScrollableInner: (props: {children?: React.ReactNode}) => (
      <View>{props.children}</View>
    ),
  }
})
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  web: () => ({}),
  useBreakpoints: () => ({gtMobile: true, gtTablet: true, gtPhone: true}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {Text: (props: Record<string, unknown>) => <Text {...props} />}
})
jest.mock('#/components/Button', () => {
  const {Pressable, Text} = jest.requireActual<{
    Pressable: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {
    Button: (props: {
      label: string
      onPress?: () => void
      testID?: string
      children?: React.ReactNode
    }) => (
      <Pressable
        accessibilityLabel={props.label}
        accessibilityHint=""
        onPress={props.onPress}
        testID={props.testID}>
        {props.children}
      </Pressable>
    ),
    ButtonText: (props: {children?: React.ReactNode}) => (
      <Text>{props.children}</Text>
    ),
    ButtonIcon: () => null,
  }
})
jest.mock('#/components/forms/TextField', () => {
  const {TextInput, Text, View} = jest.requireActual<{
    TextInput: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
    View: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {
    LabelText: (props: {children?: React.ReactNode}) => (
      <Text>{props.children}</Text>
    ),
    Root: (props: {children?: React.ReactNode}) => (
      <View>{props.children}</View>
    ),
    Icon: () => null,
    Input: (props: Record<string, unknown>) => <TextInput {...props} />,
  }
})
jest.mock('#/components/Loader', () => ({Loader: () => null}))
// The heavy imports, as register-test fakes them.
jest.mock('#/horizon/system-accounts/device', () => {
  const values = new Map<string, string>()
  return {
    readDevice: (key: string) => values.get(key),
    writeDevice: (key: string, value: string | undefined) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
    subscribeDevice: () => () => {},
  }
})
jest.mock('#/horizon/session/revoke', () => ({
  revokeOAuthGrant: () => Promise.resolve(),
  endPasswordSession: () => Promise.resolve(),
  isRevokingOAuthGrant: () => false,
}))
jest.mock('#/state/persisted', () => ({get: () => ({accounts: []})}))
jest.mock('#/horizon/session/oauth-client', () => ({
  OAUTH_AVAILABLE: false,
  getOAuthClient: () => ({}),
}))
jest.mock('#/horizon/posting-as/temp-client', () => ({
  createTemporaryClient: () => ({clients: {}, dispose: () => {}}),
}))
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentClients: () => undefined,
}))
jest.mock('#/horizon/system-accounts/prism', () => ({
  ...jest.requireActual<object>('#/horizon/system-accounts/prism-types'),
  systemAccountsApi: () => ({}),
}))
jest.mock('#/horizon/system-accounts/sync', () => ({
  readList: () => Promise.resolve(true),
  reportDropped: () => {},
}))
jest.mock('../identity', () => {
  class ServerIdentifierError extends Error {}
  class UnresolvedIdentifierError extends Error {}
  return {
    ServerIdentifierError,
    UnresolvedIdentifierError,
    resolveAccount: () =>
      Promise.resolve({
        did: 'did:plc:lalaaaaaaaaaaaaaaaaaaaaa',
        handle: 'lala.test',
        pdsUrl: 'https://pds.example',
      }),
  }
})

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native'

import {AddSystemAccountDialog} from '../AddSystemAccountDialog'
import {
  clearRegistration,
  getRegistration,
  setRegistrationEnvForTests,
} from '../register'

const MAIN = 'did:plc:mainaaaaaaaaaaaaaaaaaaaa'

const control = {
  id: 'add',
  ref: {current: null},
  open: () => {},
  close: (after?: () => void) => after?.(),
} as unknown as Parameters<typeof AddSystemAccountDialog>[0]['control']

function renderDialog() {
  i18n.loadAndActivate({locale: 'en', messages: {}})
  return render(
    <I18nProvider i18n={i18n}>
      <AddSystemAccountDialog control={control} registrar={MAIN} />
    </I18nProvider>,
  )
}

async function enterHandleAndNext() {
  fireEvent.changeText(
    screen.getByTestId('systemAccountsIdentifier'),
    'lala.test',
  )
  await act(() => {
    fireEvent.press(screen.getByTestId('systemAccountsNext'))
    return Promise.resolve()
  })
}

describe('the Add dialog after Next', () => {
  beforeEach(() => {
    clearRegistration(getRegistration())
  })
  afterEach(() => {
    setRegistrationEnvForTests()
    act(() => clearRegistration(getRegistration()))
  })

  it('shows the sign-in step for the account, not a blank dialog', async () => {
    setRegistrationEnvForTests({currentDid: () => MAIN})
    renderDialog()
    await enterHandleAndNext()
    // Native has no popup sign-in, so the step is the app password.
    await waitFor(() =>
      expect(screen.getByTestId('systemAccountsAppPassword')).toBeTruthy(),
    )
    expect(screen.getByText(/@lala\.test/)).toBeTruthy()
    expect(screen.queryByTestId('systemAccountsLost')).toBeNull()
  })

  it('a step with no registration says so and offers Start again', async () => {
    setRegistrationEnvForTests({currentDid: () => undefined})
    renderDialog()
    await enterHandleAndNext()
    await waitFor(() =>
      expect(screen.getByTestId('systemAccountsLost')).toBeTruthy(),
    )
    await act(() => {
      fireEvent.press(screen.getByTestId('systemAccountsRestart'))
      return Promise.resolve()
    })
    expect(screen.getByTestId('systemAccountsIdentifier')).toBeTruthy()
  })
})
