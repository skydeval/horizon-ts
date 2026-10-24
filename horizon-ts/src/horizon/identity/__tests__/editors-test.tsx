import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, fireEvent, render} from '@testing-library/react-native'

/*
 * Phase 5 design 13, the 5C editors (B-13, ID-20 to ID-22): the pronouns
 * field in Edit Profile, its state as the stock dialog holds it, the short
 * field's note and "Show no pronouns", no path that deletes the record, and
 * the switches at the tabs and the field. The own records are read from a
 * fake PDS through the identity layer; no network call is made. The design
 * system's components are replaced by plain views so the field's logic is
 * what is tested.
 */

jest.unmock('multiformats/cid')
jest.mock('#/lib/api/upload-blob', () => ({uploadBlob: jest.fn()}))
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => Promise.reject(new Error('no network in tests')),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({
    currentAccount: {did: 'did:plc:writeraaaaaaaaaaaaaaaaaa'},
  }),
  useMaybePdsClient: () => null,
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))

/** Lingui with the message's values filled in, so text can be asserted. */
function mockFill(message: string, values?: Record<string, unknown>) {
  return message.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values?.[key]
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : ''
  })
}
jest.mock('@lingui/react', () => ({
  useLingui: () => ({
    _: (d: {message?: string; values?: Record<string, unknown>}) =>
      mockFill(d.message ?? '', d.values),
    i18n: {
      _: (d: {message?: string; values?: Record<string, unknown>}) =>
        mockFill(d.message ?? '', d.values),
    },
  }),
  Trans: ({
    message,
    values,
  }: {
    message?: string
    values?: Record<string, unknown>
  }) => {
    const {Text} = require('react-native') as typeof import('react-native')
    return <Text>{mockFill(message ?? '', values)}</Text>
  },
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => ''}),
  }),
  web: () => ({}),
}))
jest.mock('#/components/Dialog', () => {
  const {TextInput} = require('react-native') as typeof import('react-native')
  return {Input: TextInput}
})
jest.mock('#/components/forms/TextField', () => {
  const {View, Text} = require('react-native') as typeof import('react-native')
  return {
    LabelText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
    Root: ({children}: {children: React.ReactNode}) => <View>{children}</View>,
  }
})
jest.mock('#/components/forms/SegmentedControl', () => {
  const {View, Pressable, Text} =
    require('react-native') as typeof import('react-native')
  return {
    Root: ({children}: {children: React.ReactNode}) => <View>{children}</View>,
    Item: ({
      testID,
      children,
    }: {
      testID?: string
      children: React.ReactNode
    }) => (
      <Pressable accessibilityRole="tab" testID={testID}>
        {children}
      </Pressable>
    ),
    ItemText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/components/Button', () => {
  const {Pressable, View} =
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
        <View>{children}</View>
      </Pressable>
    ),
    ButtonIcon: () => null,
    ButtonText: ({children}: {children: React.ReactNode}) => <>{children}</>,
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
jest.mock('#/components/Typography', () => {
  const {Text} = require('react-native') as typeof import('react-native')
  return {Text}
})
jest.mock('#/components/icons/Arrow', () => ({
  ArrowBottom_Stroke2_Corner0_Rounded: () => null,
  ArrowTop_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Plus', () => ({
  PlusLarge_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Times', () => ({
  TimesLarge_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/view/com/composer/char-progress/CharProgress', () => ({
  CharProgress: () => null,
}))
jest.mock('#/horizon/identity/edit/PluralityTab', () => {
  const {Text} = require('react-native') as typeof import('react-native')
  return {PluralityTab: () => <Text testID="pluralityTabStub">plurality</Text>}
})

import {i18n} from '@lingui/core'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {EditProfileTabs} from '#/horizon/identity/edit/EditProfileTabs'
import {
  type IdentityEditParts,
  PronounsField,
  useIdentityEditParts,
} from '#/horizon/identity/edit/PronounsField'
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
import * as switches from '#/horizon/switches'
import {createRepo} from './write-harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const DID = 'did:plc:writeraaaaaaaaaaaaaaaaaa'
const PRONOUNS = 'app.nearhorizon.actor.pronouns'
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

async function settle(ms = 100) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

/** The field as Edit Profile mounts it, with its state exposed. */
function mount(profile: {did: string; pronouns?: string}) {
  const ref: {parts?: IdentityEditParts} = {}
  function Field() {
    const parts = useIdentityEditParts(profile)
    ref.parts = parts
    return <PronounsField parts={parts} />
  }
  const view = render(
    <QueryClientProvider client={qc}>
      <Field />
    </QueryClientProvider>,
  )
  return {view, ref}
}

function saved() {
  const calls = repo.writesOf('putRecord')
  return calls[calls.length - 1]?.body.record
}

describe('the pronouns field (7.1)', () => {
  it('with no record and a short field set, names the short field, and "Show no pronouns" writes empty sets', async () => {
    const {view, ref} = mount({did: DID, pronouns: 'he/him'})
    await settle()
    expect(view.getByTestId('pronounsShortFieldNote')).toBeTruthy()
    expect(view.getByText('Your Bluesky profile shows: he/him')).toBeTruthy()
    expect(ref.parts?.dirty).toBe(false)

    fireEvent.press(view.getByTestId('pronounsShowNone'))
    expect(ref.parts?.dirty).toBe(true)
    await act(async () => {
      await ref.parts?.save()
    })
    expect(saved()).toMatchObject({$type: PRONOUNS, sets: []})
    expect(repo.writesOf('putRecord')[0].body.swapRecord).toBeNull()
    expect(repo.writesOf('deleteRecord')).toHaveLength(0)
  })

  it('shows no note without a short field, and none once a record exists', async () => {
    const first = mount({did: DID})
    await settle()
    expect(first.view.queryByTestId('pronounsShortFieldNote')).toBeNull()
    first.view.unmount()

    repo.seed(PRONOUNS, 'self', {
      $type: PRONOUNS,
      sets: [],
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    qc.clear()
    resetIdentityReads()
    resetIdentitySchedule()
    const second = mount({did: DID, pronouns: 'he/him'})
    await settle()
    expect(second.view.queryByTestId('pronounsShortFieldNote')).toBeNull()
  })

  it('a preset chip then a typed second row writes two sets', async () => {
    const {view, ref} = mount({did: DID})
    await settle()
    fireEvent.press(view.getByTestId('pronounsPreset-she/her'))
    fireEvent.press(view.getByTestId('pronounsAddRow'))
    fireEvent.changeText(view.getByTestId('pronounsRow1'), 'fae/faer/faerself')
    expect(ref.parts?.dirty).toBe(true)
    await act(async () => {
      await ref.parts?.save()
    })
    expect(saved().sets).toEqual([
      {forms: ['she', 'her']},
      {forms: ['fae', 'faer', 'faerself']},
    ])
    expect('updatedAt' in saved()).toBe(false)
  })

  it('clearing every row writes empty sets and keeps the record', async () => {
    repo.seed(PRONOUNS, 'self', {
      $type: PRONOUNS,
      sets: [{forms: ['he', 'him']}, {forms: ['they', 'them']}],
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    const {view, ref} = mount({did: DID, pronouns: 'xe/xem'})
    await settle()
    fireEvent.press(view.getByTestId('pronounsRemove1'))
    fireEvent.press(view.getByTestId('pronounsRemove0'))
    // A record exists, so the short field is not offered.
    expect(view.queryByTestId('pronounsShortFieldNote')).toBeNull()
    expect(view.getByText('No pronouns will show once you save.')).toBeTruthy()
    await act(async () => {
      await ref.parts?.save()
    })
    expect(saved()).toMatchObject({
      sets: [],
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    expect(typeof saved().updatedAt).toBe('string')
    expect(repo.get(PRONOUNS, 'self')).toBeDefined()
    expect(repo.writesOf('deleteRecord')).toHaveLength(0)
  })

  it('an untouched "he/him" row and an unknown key are written as read', async () => {
    repo.seed(PRONOUNS, 'self', {
      $type: PRONOUNS,
      sets: [{forms: ['he/him']}],
      createdAt: '2026-10-01T00:00:00.000Z',
      'com.example.extra': 'kept',
    })
    const {ref} = mount({did: DID})
    await settle()
    act(() => ref.parts?.setDisplayMode('firstOnly'))
    expect(ref.parts?.dirty).toBe(true)
    await act(async () => {
      await ref.parts?.save()
    })
    expect(saved()).toMatchObject({
      sets: [{forms: ['he/him']}],
      displayMode: 'firstOnly',
      'com.example.extra': 'kept',
    })
  })

  it('refuses a 25-grapheme form with a note, holding Save, never cutting it', async () => {
    const {view, ref} = mount({did: DID})
    await settle()
    fireEvent.press(view.getByTestId('pronounsAddRow'))
    fireEvent.changeText(
      view.getByTestId('pronounsRow0'),
      'she/abcdefghijklmnopqrstuvwxy',
    )
    expect(ref.parts?.invalid).toBe(true)
    expect(
      view.getByText(
        '“abcdefghijklmnopqrstuvwxy” is too long. Each form can have up to 24 characters.',
      ),
    ).toBeTruthy()
    await act(async () => {
      await expect(ref.parts!.save()).rejects.toBeDefined()
    })
    expect(repo.writesOf('putRecord')).toHaveLength(0)
  })

  it('is not dirty until something changes, so the stock Save writes nothing extra', async () => {
    repo.seed(PRONOUNS, 'self', {
      $type: PRONOUNS,
      sets: [{forms: ['she', 'her']}],
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    const {ref} = mount({did: DID})
    await settle()
    expect(ref.parts?.dirty).toBe(false)
    await act(async () => {
      await ref.parts?.save()
    })
    expect(repo.writesOf('putRecord')).toHaveLength(0)
  })

  it('with PRONOUNS off renders nothing and reads nothing', async () => {
    jest.replaceProperty(switches, 'PRONOUNS', false)
    const {view, ref} = mount({did: DID, pronouns: 'he/him'})
    await settle()
    expect(view.queryByTestId('pronounsField')).toBeNull()
    expect(ref.parts?.dirty).toBe(false)
    expect(repo.writes).toHaveLength(0)
  })

  it('renders nothing for another account’s profile', async () => {
    const {view} = mount({did: 'did:plc:otherbbbbbbbbbbbbbbbbbbb'})
    await settle()
    expect(view.queryByTestId('pronounsField')).toBeNull()
  })
})

describe('Edit Profile tabs (ID-20)', () => {
  function tabs(did = DID) {
    return render(
      <QueryClientProvider client={qc}>
        <EditProfileTabs profile={{did}}>
          <></>
        </EditProfileTabs>
      </QueryClientProvider>,
    )
  }

  it('shows Profile and Plurality, starting on Profile', () => {
    const view = tabs()
    expect(view.getByTestId('editProfileTabProfile')).toBeTruthy()
    expect(view.getByTestId('editProfileTabPlurality')).toBeTruthy()
    expect(view.queryByTestId('pluralityTabStub')).toBeNull()
  })

  it('with PLURAL_EDITING off is the stock body alone', () => {
    jest.replaceProperty(switches, 'PLURAL_EDITING', false)
    const view = tabs()
    expect(view.queryByTestId('editProfileTabPlurality')).toBeNull()
  })

  it('is the stock body alone for another account', () => {
    const view = tabs('did:plc:otherbbbbbbbbbbbbbbbbbbb')
    expect(view.queryByTestId('editProfileTabPlurality')).toBeNull()
  })
})
