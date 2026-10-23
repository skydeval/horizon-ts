/*
 * The setting (appearance storage choice design, section 2; AP-B5): two
 * rows unless prism lists `private.appearance` for a member, three then;
 * "Moving…" on the chosen row while a choice change or its record step is
 * due; the radio follows the copy (a refusal that drops `pending.store`
 * reverts it); hidden when signed out.
 */

import type * as ReactNative from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {fireEvent, render as rtlRender} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {
  type AccountCopy,
  defaultDeviceValue,
  emptyAccountCopy,
} from '#/horizon/appearance/device-value'
import {SaveAppearanceGroup} from '#/horizon/appearance/settings/SaveAppearance'

const DID = 'did:plc:alice'
let mockDid: string | undefined = DID
let mockCopy: AccountCopy | undefined
let mockOffersPrivate = false
const mockChoose = jest.fn()
const mockDismiss = jest.fn()

jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: mockDid ? {did: mockDid} : undefined}),
}))
jest.mock('#/horizon/appearance/store', () => ({
  useAppearanceState: () => ({
    device: {
      ...jest
        .requireActual<{defaultDeviceValue: () => object}>(
          '#/horizon/appearance/device-value',
        )
        .defaultDeviceValue(),
      accounts: mockCopy ? {'did:plc:alice': mockCopy} : {},
    },
    preview: null,
  }),
  chooseAppearanceStore: (...args: unknown[]) => mockChoose(...args),
  dismissAppearanceNote: (...args: unknown[]) => mockDismiss(...args),
}))
jest.mock('#/horizon/appearance/prism', () => ({
  offersPrivateAppearance: () => mockOffersPrivate,
}))
jest.mock('#/horizon/appearance/notices', () => ({
  migrationNoteText: () => 'MIGRATION NOTE',
  removalNoteText: () => 'REMOVAL NOTE',
  tooLargeNoteText: () => 'TOO LARGE NOTE',
}))
jest.mock('#/horizon/routing/membership', () => ({
  subscribeMembership: () => () => {},
}))
jest.mock('#/horizon/routing/features', () => ({
  subscribePrismFeatures: () => () => {},
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
}))
jest.mock('#/components/Typography', () => ({
  Text: jest.requireActual<typeof ReactNative>('react-native').Text,
}))
jest.mock('#/components/icons/FloppyDisk', () => ({
  FloppyDisk_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/screens/Settings/components/SettingsList', () => {
  const {Text} = jest.requireActual<typeof ReactNative>('react-native')
  return {
    Group: ({children}: {children: React.ReactNode}) => children,
    ItemIcon: () => null,
    ItemText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/components/Button', () => {
  const {Pressable, Text} =
    jest.requireActual<typeof ReactNative>('react-native')
  return {
    Button: ({
      label,
      onPress,
      children,
    }: {
      label: string
      onPress: () => void
      children: React.ReactNode
    }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint=""
        onPress={onPress}>
        {children}
      </Pressable>
    ),
    ButtonText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/components/forms/Toggle', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  const {Pressable, Text} =
    jest.requireActual<typeof ReactNative>('react-native')
  const Group = React.createContext<{
    values: string[]
    onChange: (values: string[]) => void
  }>({values: [], onChange: () => {}})
  return {
    Group: ({
      values,
      onChange,
      children,
    }: {
      values: string[]
      onChange: (values: string[]) => void
      children: React.ReactNode
    }) => (
      <Group.Provider value={{values, onChange}}>{children}</Group.Provider>
    ),
    Item: ({name, children}: {name: string; children: React.ReactNode}) => {
      const group = React.useContext(Group)
      return (
        <Pressable
          testID={`row-${name}`}
          accessibilityRole="radio"
          accessibilityState={{checked: group.values.includes(name)}}
          onPress={() => group.onChange([name])}>
          {children}
        </Pressable>
      )
    },
    Radio: () => null,
    LabelText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})

i18n.loadAndActivate({locale: 'en', messages: {}})

function render() {
  return rtlRender(
    <I18nProvider i18n={i18n}>
      <SaveAppearanceGroup />
    </I18nProvider>,
  )
}

function checked(view: ReturnType<typeof render>, name: string) {
  const props = view.getByTestId(`row-${name}`).props as {
    accessibilityState: {checked: boolean}
  }
  return props.accessibilityState.checked
}

beforeEach(() => {
  mockDid = DID
  mockCopy = undefined
  mockOffersPrivate = false
  mockChoose.mockClear()
  mockDismiss.mockClear()
})

describe('Save my appearance (section 2)', () => {
  it('non-members, and members until prism lists the feature, see two rows', () => {
    mockCopy = {...emptyAccountCopy(), store: 'device', storeKnown: true}
    const view = render()
    expect(view.queryByText('Private, synced')).toBeNull()
    expect(view.getByText('Public, in my account')).toBeTruthy()
    expect(view.getByText('This device only')).toBeTruthy()
    expect(checked(view, 'device')).toBe(true)
  })

  it('members of a prism listing it see three, with the description lines', () => {
    mockOffersPrivate = true
    mockCopy = {...emptyAccountCopy(), store: 'private', storeKnown: true}
    const view = render()
    expect(view.getByText('Private, synced')).toBeTruthy()
    expect(
      view.getByText(
        'Horizon keeps it for you and syncs it across your devices. It isn’t in your public account.',
      ),
    ).toBeTruthy()
    expect(
      view.getByText(
        'Saved in your account’s public data. Other apps can read it.',
      ),
    ).toBeTruthy()
    expect(
      view.getByText(
        'Not saved anywhere else. Your other devices keep their own.',
      ),
    ).toBeTruthy()
    expect(checked(view, 'private')).toBe(true)
  })

  it('choosing a row sets the choice', () => {
    mockCopy = {...emptyAccountCopy(), store: 'device', storeKnown: true}
    const view = render()
    fireEvent.press(view.getByTestId('row-public'))
    expect(mockChoose).toHaveBeenCalledWith(DID, 'public')
  })

  it('“Moving…” shows on the new choice while it hasn’t landed, or its record step is due', () => {
    mockCopy = {
      ...emptyAccountCopy(),
      store: 'device',
      storeKnown: true,
      pending: {
        fields: [],
        appearance: defaultDeviceValue().device,
        seq: 1,
        store: 'public',
      },
    }
    const view = render()
    expect(checked(view, 'public')).toBe(true)
    expect(view.getByText('Moving…')).toBeTruthy()

    mockCopy = {...emptyAccountCopy(), store: 'public', recordDue: true}
    view.rerender(
      <I18nProvider i18n={i18n}>
        <SaveAppearanceGroup />
      </I18nProvider>,
    )
    expect(view.getByText('Moving…')).toBeTruthy()

    mockCopy = {...emptyAccountCopy(), store: 'public', storeKnown: true}
    view.rerender(
      <I18nProvider i18n={i18n}>
        <SaveAppearanceGroup />
      </I18nProvider>,
    )
    expect(view.queryByText('Moving…')).toBeNull()
  })

  it('a refusal that drops the choice shows the store again', () => {
    mockOffersPrivate = true
    mockCopy = {...emptyAccountCopy(), store: 'private', storeKnown: true}
    const view = render()
    expect(checked(view, 'private')).toBe(true)
    expect(checked(view, 'public')).toBe(false)
  })

  it('the migration and removal notes leave a line until dismissed', () => {
    mockCopy = {...emptyAccountCopy(), store: 'private', noted: true}
    mockOffersPrivate = true
    const view = render()
    expect(view.getByText('MIGRATION NOTE')).toBeTruthy()
    fireEvent.press(view.getByLabelText('Dismiss'))
    expect(mockDismiss).toHaveBeenCalledWith(DID)

    mockCopy = {...emptyAccountCopy(), store: 'device', removalLine: true}
    mockOffersPrivate = false
    view.rerender(
      <I18nProvider i18n={i18n}>
        <SaveAppearanceGroup />
      </I18nProvider>,
    )
    expect(view.getByText('REMOVAL NOTE')).toBeTruthy()
  })

  it('the too-large note leaves a line until dismissed', () => {
    mockCopy = {
      ...emptyAccountCopy(),
      store: 'public',
      tooLarge: true,
      tooLargeLine: true,
    }
    mockOffersPrivate = true
    const view = render()
    expect(view.getByText('TOO LARGE NOTE')).toBeTruthy()
    expect(checked(view, 'public')).toBe(true)
    fireEvent.press(view.getByLabelText('Dismiss'))
    expect(mockDismiss).toHaveBeenCalledWith(DID)

    mockCopy = {...emptyAccountCopy(), store: 'public', tooLarge: true}
    view.rerender(
      <I18nProvider i18n={i18n}>
        <SaveAppearanceGroup />
      </I18nProvider>,
    )
    expect(view.queryByText('TOO LARGE NOTE')).toBeNull()
  })

  it('hidden when signed out', () => {
    mockDid = undefined
    const view = render()
    expect(view.queryByText('Save my appearance')).toBeNull()
  })
})
