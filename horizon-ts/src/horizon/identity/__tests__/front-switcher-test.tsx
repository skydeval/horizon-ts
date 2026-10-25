import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 6.2 and 7.3 (5B, 5C): on one's own profile the front can
 * always be changed. The real header identity and the real front switcher,
 * reading and writing a fake own PDS: after a front is set, a trigger stays,
 * it opens the switcher (not the member list) with selectable members, Save
 * writes the front, and a trigger is there again when it closes. Dialogs
 * are plain views that show while open. No network call is made.
 */

jest.unmock('multiformats/cid')
jest.mock('#/lib/api/upload-blob', () => ({uploadBlob: jest.fn()}))
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => Promise.reject(new Error('no network in tests')),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({
    hasSession: true,
    currentAccount: {did: 'did:plc:writeraaaaaaaaaaaaaaaaaa'},
    accounts: [],
  }),
  useMaybePdsClient: () => null,
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
  getAndMigrateDeviceId: () => Promise.resolve('device-id-1'),
}))
jest.mock('#/state/queries/profile', () => ({
  useProfileBlockMutationQueue: () => [() => {}, () => Promise.resolve()],
  useProfileFollowMutationQueue: () => [
    () => Promise.resolve(),
    () => Promise.resolve(),
  ],
}))
jest.mock('#/state/cache/profile-shadow', () => ({
  useProfileShadow: (profile: unknown) => profile,
}))
jest.mock('#/analytics', () => ({
  useAnalytics: () => ({metric: () => {}}),
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  tokens: {space: {lg: 16}},
  web: () => ({}),
  native: () => ({}),
  platform: () => ({}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({borderColor: '#000'})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
  useBreakpoints: () => ({gtPhone: true, gtMobile: true, gtTablet: true}),
}))
jest.mock('#/lib/haptics', () => ({
  useHaptics: () => ({tap: () => {}, confirm: () => {}}),
}))
jest.mock('#/components/Typography', () => {
  const {Text} = require('react-native') as typeof import('react-native')
  return {Text}
})
jest.mock('#/components/Button', () => {
  const {Pressable, Text} =
    require('react-native') as typeof import('react-native')
  return {
    Button: ({
      testID,
      label,
      onPress,
      disabled,
      children,
    }: {
      testID?: string
      label: string
      onPress?: () => void
      disabled?: boolean
      children?: React.ReactNode
    }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint=""
        testID={testID}
        onPress={onPress}
        disabled={disabled}>
        {children}
      </Pressable>
    ),
    ButtonText: ({children}: {children?: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
    ButtonIcon: () => null,
  }
})
jest.mock('#/components/Dialog', () => {
  const React = require('react') as typeof import('react')
  const {View} = require('react-native') as typeof import('react-native')
  type MockControl = {
    isOpen: boolean
    open: () => void
    close: (cb?: () => void) => void
    onClose?: () => void
  }
  const Ctx = React.createContext<MockControl | null>(null)
  return {
    useDialogControl: (): MockControl => {
      const [isOpen, setOpen] = React.useState(false)
      const control: MockControl = {
        isOpen,
        open: () => setOpen(true),
        close: cb => {
          setOpen(false)
          setTimeout(() => {
            control.onClose?.()
            cb?.()
          })
        },
      }
      return control
    },
    useDialogContext: () => React.useContext(Ctx),
    Outer: ({
      control,
      onClose,
      children,
    }: {
      control: MockControl
      onClose?: () => void
      children: React.ReactNode
    }) => {
      control.onClose = onClose
      return control.isOpen ? (
        <Ctx.Provider value={control}>
          <View testID="dialogOpen">{children}</View>
        </Ctx.Provider>
      ) : null
    },
    Handle: () => null,
    Close: () => null,
    ScrollableInner: ({children}: {children: React.ReactNode}) => (
      <View>{children}</View>
    ),
  }
})
jest.mock('#/components/forms/Toggle', () => {
  const React = require('react') as typeof import('react')
  const {Pressable, Text, View} =
    require('react-native') as typeof import('react-native')
  const Ctx = React.createContext<{
    values: string[]
    onChange: (next: string[]) => void
  }>({values: [], onChange: () => {}})
  return {
    Group: ({
      values,
      onChange,
      children,
    }: {
      values: string[]
      onChange: (next: string[]) => void
      children: React.ReactNode
    }) => (
      <Ctx.Provider value={{values, onChange}}>
        <View>{children}</View>
      </Ctx.Provider>
    ),
    Item: ({
      name,
      label,
      testID,
      children,
    }: {
      name: string
      label: string
      testID?: string
      children: React.ReactNode
    }) => {
      const {values, onChange} = React.useContext(Ctx)
      const checked = values.includes(name)
      return (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={label}
          accessibilityHint=""
          accessibilityState={{checked}}
          testID={testID}
          onPress={() =>
            onChange(
              checked ? values.filter(v => v !== name) : [...values, name],
            )
          }>
          {children}
        </Pressable>
      )
    },
    Checkbox: () => null,
    LabelText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/horizon/identity/edit/fields', () => {
  const {TextInput} = require('react-native') as typeof import('react-native')
  return {
    HIT_44: {},
    LimitedField: ({
      label,
      value,
      onChange,
      testID,
    }: {
      label: string
      value: string
      onChange: (value: string) => void
      testID?: string
    }) => (
      <TextInput
        accessibilityLabel={label}
        accessibilityHint=""
        value={value}
        onChangeText={onChange}
        testID={testID}
      />
    ),
  }
})
jest.mock('#/components/Admonition', () => {
  const {Text} = require('react-native') as typeof import('react-native')
  return {
    Admonition: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/components/Loader', () => ({Loader: () => null}))
jest.mock('#/components/Toast', () => ({show: () => {}}))
jest.mock('#/screens/Profile/Header/EditProfileDialog', () => ({
  EditProfileDialog: () => null,
}))
jest.mock('#/horizon/identity/MemberListDialog', () => {
  const {View} = require('react-native') as typeof import('react-native')
  return {
    MemberListDialog: ({control}: {control: {isOpen: boolean}}) =>
      control.isOpen ? <View testID="memberListOpen" /> : null,
  }
})

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, fireEvent, render, screen} from '@testing-library/react-native'

import {ProfileHeaderIdentity} from '#/horizon/identity/ProfileIdentity'
import {setIdentityRunStart} from '#/horizon/identity/queries'
import {resetIdentityReads} from '#/horizon/identity/reads'
import {
  resetIdentitySchedule,
  setIdentityVisibility,
} from '#/horizon/identity/schedule'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {FRONT, MEMBER, records, SPARROW, SYSTEM, WREN} from './harness'
import {createRepo} from './write-harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const DID = 'did:plc:writeraaaaaaaaaaaaaaaaaa'
const START = 1_790_000_000_000

let repo: ReturnType<typeof createRepo>
let qc: QueryClient

beforeEach(() => {
  jest.useFakeTimers({now: START})
  resetIdentityReads()
  resetIdentitySchedule()
  setIdentityVisibility({isVisible: () => true, subscribe: () => () => {}})
  setIdentityRunStart(START)
  repo = createRepo(DID)
  repo.seed(SYSTEM, 'self', records.system())
  repo.seed(MEMBER, WREN, records.member('Wren'))
  repo.seed(MEMBER, SPARROW, records.member('Sparrow'))
  qc = new QueryClient({defaultOptions: {queries: {retry: false}}})
  publishCurrentClients({
    did: DID,
    handle: 'writer.test',
    pdsUrl: 'https://pds.example',
    pdsClient: repo.client,
    prismClient: repo.client,
    appviewClient: repo.client,
    queryClient: qc,
  })
})

afterEach(() => {
  clearCurrentClients()
  qc.clear()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

async function settle(ms = 300) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

function mount() {
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <ProfileHeaderIdentity
          profile={{did: DID, handle: 'writer.test'} as never}
          moderation={{} as never}
        />
      </QueryClientProvider>
    </I18nProvider>,
  )
}

/** Whichever front switcher trigger the header shows. */
function trigger() {
  return (
    screen.queryByTestId('frontIndicatorButton') ??
    screen.queryByTestId('changeFrontButton') ??
    screen.getByTestId('setFrontButton')
  )
}

function savedFront() {
  const calls = repo
    .writesOf('putRecord')
    .filter(call => call.body.collection === FRONT)
  return calls.at(-1)?.body.record as {members: {id: string}[]} | undefined
}

describe('changing the front from one`s own profile (6.2, 7.3)', () => {
  it('after a front is set, the trigger opens the switcher with selectable members, and Save writes it', async () => {
    repo.seed(FRONT, 'self', records.front([WREN]))
    mount()
    await settle()

    fireEvent.press(trigger())
    await settle()
    expect(screen.queryByTestId('memberListOpen')).toBeNull()
    expect(screen.getByTestId('frontSwitcher')).toBeTruthy()
    const wren = screen.getByTestId(`frontMember-${WREN}`)
    const sparrow = screen.getByTestId(`frontMember-${SPARROW}`)
    expect(wren.props.accessibilityState).toMatchObject({checked: true})
    expect(sparrow.props.accessibilityState).toMatchObject({checked: false})

    fireEvent.press(sparrow)
    expect(
      screen.getByTestId(`frontMember-${SPARROW}`).props.accessibilityState,
    ).toMatchObject({checked: true})
    fireEvent.press(screen.getByTestId('frontSaveButton'))
    await settle()

    const ids = savedFront()?.members.map(m => m.id)
    expect(ids?.sort()).toEqual([SPARROW, WREN].sort())
    expect(screen.queryByTestId('frontSwitcher')).toBeNull()

    // Closed, the switcher can be opened again to change the front again.
    fireEvent.press(trigger())
    await settle()
    expect(screen.getByTestId('frontSwitcher')).toBeTruthy()
  })

  it('from "Set front" to a front and back to "Nobody fronting", a trigger always stays', async () => {
    mount()
    await settle()
    fireEvent.press(screen.getByTestId('setFrontButton'))
    await settle()
    fireEvent.press(screen.getByTestId(`frontMember-${WREN}`))
    fireEvent.press(screen.getByTestId('frontSaveButton'))
    await settle()
    expect(savedFront()?.members.map(m => m.id)).toEqual([WREN])
    expect(screen.queryByTestId('setFrontButton')).toBeNull()

    fireEvent.press(trigger())
    await settle()
    fireEvent.press(screen.getByTestId('frontNobodyButton'))
    await settle()
    expect(savedFront()?.members).toEqual([])
    const nobody = screen.getByTestId('frontIndicatorButton')
    expect(nobody.props.accessibilityLabel).toContain('Change who’s fronting')
    fireEvent.press(nobody)
    await settle()
    expect(screen.getByTestId('frontSwitcher')).toBeTruthy()
  })
})
