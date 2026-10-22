import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, render, renderHook, waitFor} from '@testing-library/react-native'

import {nearhorizon} from '#/horizon/lexicons'

/*
 * Phase 3, batch B: who sees the Interaction settings sections, the
 * Notifications settings tabs and the Audiences row, and what a choice in
 * the Private posts section saves. The design system is replaced by plain
 * stand-ins: these tests are about gating and wiring, not looks.
 */

const DID = 'did:plc:privateaaaaaaaaaaaaaaaaa'

let mockIsMember = true
/** prism's answers to the private notification preference calls. */
const mockPrismCall = jest.fn<(...args: unknown[]) => Promise<unknown>>()
/** Whether the composer offers Private (2K design 4.7). */
let mockOffered = true
jest.mock('#/horizon/private/membership', () => ({
  useIsMember: () => mockIsMember,
  useCanPostPrivately: () => ({
    offered: mockIsMember && mockOffered,
    route: mockOffered ? 'locus' : 'none',
    reason: undefined,
    showsRouteNote: !mockOffered,
    routes: {
      repoRoute: mockOffered ? 'locus' : 'stock',
      postingRoute: mockOffered ? 'locus' : 'none',
      reason: undefined,
      indexing: false,
    },
  }),
  usePrivateFeedSource: () =>
    mockIsMember
      ? {did: 'did:plc:privateaaaaaaaaaaaaaaaaa', prism: {call: mockPrismCall}}
      : undefined,
}))
let mockFeatures = new Set<string>()
jest.mock('#/horizon/private/features-hooks', () => ({
  usePrismFeature: (feature: string) => mockFeatures.has(feature),
}))
/** Segmented controls' handlers by label, to call them. */
const mockSegments = new Map<string, (value: string) => void>()
jest.mock('#/components/forms/SegmentedControl', () => {
  const pass = (props: {children?: unknown}) => props.children ?? null
  return {
    Root: (props: {
      label: string
      onChange: (mockValue: string) => void
      children?: unknown
    }) => {
      mockSegments.set(props.label, props.onChange)
      return props.children ?? null
    },
    Item: pass,
    ItemText: pass,
  }
})
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: DID}}),
}))
let mockDefaultsSwitch = true
let mockSettingsTabsSwitch = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {
      PRIVATE_POSTING_DEFAULTS: {
        get: () => mockDefaultsSwitch,
        enumerable: true,
      },
      PRIVATE_NOTIFICATION_SETTINGS: {
        get: () => mockSettingsTabsSwitch,
        enumerable: true,
      },
    },
  ),
)
let mockDefaults: unknown = {
  startAs: 'public',
  audience: {kind: 'mode', mode: 'everyone'},
}
const mockSave = jest.fn()
jest.mock('#/horizon/private/defaults/query', () => ({
  usePostingDefaultsQuery: () => ({data: mockDefaults, isError: false}),
  useSetPostingDefaultsMutation: () => ({mutate: mockSave}),
}))
jest.mock('#/horizon/private/audiences/useAudiencesQuery', () => ({
  useAudiencesQuery: () => ({
    data: [
      {
        uri: `at://${DID}/tools.kryphocron.policy.audience/3klist1111111`,
        rkey: '3klist1111111',
        mode: 'list',
        name: 'Close friends',
        members: [],
      },
    ],
    isPending: false,
    isError: false,
  }),
}))
jest.mock('#/horizon/private/audiences/AudienceEditorDialog', () => ({
  AudienceEditorDialog: () => null,
}))
jest.mock('#/horizon/private/composer/AudienceMenu', () => ({
  useModeLabel: () => (mode: string) => mode,
  listName: (entry: {name?: string}) => entry.name,
  pickableListAudiences: (entries: {mode: string; name?: string}[]) =>
    entries.filter(entry => entry.mode === 'list' && entry.name),
}))

jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  tokens: new Proxy({}, {get: () => new Proxy({}, {get: () => 0})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/lib/haptics', () => ({useHaptics: () => ({selection: () => {}})}))

/** Group handlers by their accessibility label, to call them. */
const mockGroups = new Map<string, (values: string[]) => void>()
const mockGroupValues = new Map<string, string[]>()
const mockItems: string[] = []
/** Single toggles' handlers by name, to call them. */
const mockToggles = new Map<string, (value: boolean) => void>()
jest.mock('#/components/forms/Toggle', () => {
  const pass = (props: {children?: unknown}) =>
    typeof props.children === 'function'
      ? (props.children as (mockArg: unknown) => unknown)({selected: false})
      : (props.children ?? null)
  return {
    Group: (props: {
      label: string
      values: string[]
      onChange: (mockValues: string[]) => void
      children?: unknown
    }) => {
      mockGroups.set(props.label, props.onChange)
      mockGroupValues.set(props.label, props.values)
      return props.children ?? null
    },
    Item: (props: {
      name: string
      onChange?: (mockValue: boolean) => void
      children?: unknown
    }) => {
      mockItems.push(props.name)
      if (props.onChange) mockToggles.set(props.name, props.onChange)
      return pass(props)
    },
    Platform: () => null,
    Panel: pass,
    PanelGroup: pass,
    PanelText: pass,
    Radio: () => null,
  }
})
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<{children?: React.ReactNode}>
  }>('react-native')
  return {
    Text: (props: {children?: React.ReactNode}) => (
      <Text>{props.children}</Text>
    ),
  }
})
const mockLinks: string[] = []
jest.mock('#/components/Link', () => ({
  Link: (props: {to: string; children?: unknown}) => {
    mockLinks.push(props.to)
    return typeof props.children === 'function'
      ? (props.children as (mockArg: unknown) => unknown)({
          hovered: false,
          pressed: false,
        })
      : null
  },
}))
jest.mock('#/components/Button', () => ({
  Button: (props: {children?: unknown}) =>
    typeof props.children === 'function'
      ? (props.children as (mockArg: unknown) => unknown)({
          hovered: false,
          pressed: false,
        })
      : null,
}))
jest.mock('#/components/Dialog', () => ({
  useDialogControl: () => ({open: () => {}, close: () => {}}),
}))
jest.mock('#/components/Admonition', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<{children?: React.ReactNode}>
  }>('react-native')
  return {
    Admonition: (props: {children?: React.ReactNode}) => (
      <Text>{props.children}</Text>
    ),
  }
})
jest.mock('#/components/Loader', () => ({Loader: () => null}))
const mockSettingsLinks: string[] = []
jest.mock('#/screens/Settings/components/SettingsList', () => ({
  LinkItem: (props: {to: string; children?: React.ReactNode}) => {
    mockSettingsLinks.push(props.to)
    return props.children ?? null
  },
  Item: (props: {children?: React.ReactNode}) => props.children ?? null,
  ItemIcon: () => null,
  ItemText: (props: {children?: React.ReactNode}) => props.children ?? null,
  Container: (props: {children?: React.ReactNode}) => props.children ?? null,
}))
jest.mock(
  '#/screens/Settings/NotificationSettings/components/ItemTextWithSubtitle',
  () => {
    const {Text} = jest.requireActual<{
      Text: React.ComponentType<{children?: React.ReactNode}>
    }>('react-native')
    return {
      ItemTextWithSubtitle: (props: {titleText: React.ReactNode}) => (
        <Text>{props.titleText}</Text>
      ),
    }
  },
)
jest.mock('#/components/Layout', () => {
  const {View} = jest.requireActual<{
    View: React.ComponentType<{testID?: string; children?: React.ReactNode}>
  }>('react-native')
  return {
    Center: (props: {children?: React.ReactNode}) => (
      <View testID="layoutCenter">{props.children}</View>
    ),
  }
})
const mockFolderTabs = jest.fn((_props: Record<string, unknown>) => null)
jest.mock('#/horizon/private/tabs/FolderTabs', () => ({
  FolderTabs: (props: Record<string, unknown>) => mockFolderTabs(props),
}))
jest.mock('#/components/icons/At', () => ({
  At_Stroke2_Corner2_Rounded: () => null,
}))
jest.mock('#/components/icons/Bubble', () => ({
  Bubble_Stroke2_Corner2_Rounded: () => null,
}))
jest.mock('#/components/icons/Chevron', () => ({
  ChevronRight_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Heart2', () => ({
  Heart2_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/List', () => ({
  ListPlus_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Person', () => ({
  PersonGroup_Stroke2_Corner2_Rounded: () => null,
}))
jest.mock('#/components/icons/Quote', () => ({
  CloseQuote_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Repost', () => ({
  Repost_Stroke2_Corner2_Rounded: () => null,
}))

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'

import {AudiencesSettingsItem} from '../audiences/AudiencesSettingsItem'
import {usePrivateComposeDefaults} from '../defaults/compose'
import {
  PrivatePostsSection,
  PublicPostsHeading,
} from '../defaults/InteractionSections'
import {
  NotificationSettingsTabs,
  PrivateNotificationSettings,
} from '../notifications/NotificationSettingsTabs'
import {
  getNotificationSettingsMode,
  setNotificationSettingsMode,
} from '../notifications/settings-mode'

i18n.loadAndActivate({locale: 'en', messages: {}})

function show(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false}, mutations: {retry: false}},
  })
  return render(ui, {
    wrapper: ({children}) => (
      <QueryClientProvider client={queryClient}>
        <I18nProvider i18n={i18n}>{children}</I18nProvider>
      </QueryClientProvider>
    ),
  })
}

beforeEach(() => {
  mockIsMember = true
  mockFeatures = new Set()
  mockDefaultsSwitch = true
  mockSettingsTabsSwitch = true
  mockDefaults = {startAs: 'public', audience: {kind: 'mode', mode: 'everyone'}}
  mockSave.mockClear()
  mockGroups.clear()
  mockGroupValues.clear()
  mockItems.length = 0
  mockLinks.length = 0
  mockSettingsLinks.length = 0
  mockFolderTabs.mockClear()
  setNotificationSettingsMode(DID, 'public')
})

describe('Interaction settings (item 5)', () => {
  it('a non-member sees only the stock screen', () => {
    mockIsMember = false
    const screen = show(
      <>
        <PublicPostsHeading />
        <PrivatePostsSection />
      </>,
    )
    expect(screen.toJSON()).toBeNull()
  })

  it('with the switch off, members see the stock screen too', () => {
    mockDefaultsSwitch = false
    const screen = show(<PrivatePostsSection />)
    expect(screen.toJSON()).toBeNull()
  })

  it('a member sees both sections, the reply and quote note and Audiences', () => {
    const screen = show(
      <>
        <PublicPostsHeading />
        <PrivatePostsSection />
      </>,
    )
    expect(screen.getByText('Public posts')).toBeTruthy()
    expect(screen.getByText('Private posts')).toBeTruthy()
    expect(screen.getByText('New posts start as')).toBeTruthy()
    expect(screen.getByText('Default audience')).toBeTruthy()
    expect(screen.getByText('Who can reply and quote')).toBeTruthy()
    expect(mockLinks).toContain('/settings/audiences')
    // The standing audiences, the named list, and Only me last.
    expect(mockItems).toEqual([
      'public',
      'private',
      'everyone',
      'followers',
      'following',
      `list:at://${DID}/tools.kryphocron.policy.audience/3klist1111111`,
      'nobody',
    ])
  })

  it('choosing saves the whole defaults at once', () => {
    show(<PrivatePostsSection />)
    act(() => {
      mockGroups.get('Choose whether new posts start public or private')?.([
        'private',
      ])
    })
    expect(mockSave).toHaveBeenLastCalledWith({
      startAs: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
    })
    const list = `at://${DID}/tools.kryphocron.policy.audience/3klist1111111`
    act(() => {
      mockGroups.get('Choose who can see your private posts by default')?.([
        `list:${list}`,
      ])
    })
    expect(mockSave).toHaveBeenLastCalledWith({
      startAs: 'public',
      audience: {kind: 'list', uri: list},
    })
    act(() => {
      mockGroups.get('Choose who can see your private posts by default')?.([
        'followers',
      ])
    })
    expect(mockSave).toHaveBeenLastCalledWith({
      startAs: 'public',
      audience: {kind: 'mode', mode: 'followers'},
    })
  })

  it('a default list the account no longer has stays chosen, not widened', () => {
    const gone = `at://${DID}/tools.kryphocron.policy.audience/3kgone2222222`
    mockDefaults = {startAs: 'private', audience: {kind: 'list', uri: gone}}
    const screen = show(<PrivatePostsSection />)
    // Panel text is a plain string in the stand-ins.
    expect(JSON.stringify(screen.toJSON())).toContain(
      'A list you no longer have',
    )
    expect(mockItems).toContain(`list:${gone}`)
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('no default audience chosen: none is selected, the hint says what applies, and any choice saves (round 2 list)', () => {
    mockDefaults = {startAs: 'public'}
    const screen = show(<PrivatePostsSection />)
    const label = 'Choose who can see your private posts by default'
    expect(mockGroupValues.get(label)).toEqual([''])
    expect(
      screen.getByText(
        'Until you choose, private posts and quotes of private posts go to Everyone.',
      ),
    ).toBeTruthy()
    // Everyone can be chosen as such.
    act(() => {
      mockGroups.get(label)?.(['everyone'])
    })
    expect(mockSave).toHaveBeenLastCalledWith({
      startAs: 'public',
      audience: {kind: 'mode', mode: 'everyone'},
    })
    // Changing "New posts start as" alone leaves the audience unchosen.
    act(() => {
      mockGroups.get('Choose whether new posts start public or private')?.([
        'private',
      ])
    })
    expect(mockSave).toHaveBeenLastCalledWith({startAs: 'private'})
  })

  it('a chosen default audience is selected and has no hint', () => {
    const screen = show(<PrivatePostsSection />)
    expect(
      mockGroupValues.get('Choose who can see your private posts by default'),
    ).toEqual(['everyone'])
    expect(JSON.stringify(screen.toJSON())).not.toContain('Until you choose')
  })

  it('without Private offered, "New posts start as" and "New audience…" are hidden; the default audience and Audiences stay (2K T-11)', () => {
    mockOffered = false
    try {
      const screen = show(<PrivatePostsSection />)
      expect(screen.queryByText('New posts start as')).toBeNull()
      expect(JSON.stringify(screen.toJSON())).not.toContain('New audience')
      expect(screen.getByText('Default audience')).toBeTruthy()
      expect(mockLinks).toContain('/settings/audiences')
      expect(mockItems).not.toContain('private')
    } finally {
      mockOffered = true
    }
  })

  it('the old Audiences row is not shown while Audiences lives here', () => {
    const screen = show(<AudiencesSettingsItem />)
    expect(screen.toJSON()).toBeNull()
    mockDefaultsSwitch = false
    show(<AudiencesSettingsItem />)
    expect(mockSettingsLinks).toEqual(['/settings/audiences'])
  })
})

describe('Notifications settings tabs (item 6)', () => {
  it('the tabs sit in the centre column, as the Saved tabs do (round 2 list, item 1)', () => {
    const screen = show(<NotificationSettingsTabs />)
    const center = screen.getByTestId('layoutCenter')
    expect(center).toBeTruthy()
    expect(mockFolderTabs).toHaveBeenCalled()
    // Nothing but the tabs is inside it, and nothing outside it.
    expect(screen.toJSON()).toMatchObject({props: {testID: 'layoutCenter'}})
  })

  it('members get Public | Private tabs; choosing one sets the mode', () => {
    show(<NotificationSettingsTabs />)
    const props = mockFolderTabs.mock.calls.at(-1)?.[0] as {
      selected: string
      onSelect: (key: string) => void
    }
    expect(props.selected).toBe('public')
    act(() => props.onSelect('private'))
    expect(getNotificationSettingsMode(DID)).toBe('private')
  })

  it('non-members, and the switch off, get no tabs', () => {
    mockIsMember = false
    show(<NotificationSettingsTabs />)
    mockIsMember = true
    mockSettingsTabsSwitch = false
    show(<NotificationSettingsTabs />)
    expect(mockFolderTabs).not.toHaveBeenCalled()
  })

  it('the Private settings are shown disabled with the note, and store nothing', () => {
    const screen = show(<PrivateNotificationSettings />)
    expect(
      screen.getByText(
        'Private notification settings arrive with server support.',
      ),
    ).toBeTruthy()
    for (const title of ['Likes', 'Replies', 'Mentions', 'Quotes', 'Reposts']) {
      expect(screen.getByText(title)).toBeTruthy()
    }
    expect(
      screen.UNSAFE_root.findAll(
        node =>
          (node.props as {accessibilityState?: {disabled?: boolean}})
            .accessibilityState?.disabled === true,
      ).length,
    ).toBeGreaterThanOrEqual(5)
  })
})

describe('private notification preferences (prism, 2026-10-21)', () => {
  const all = {include: 'all', list: true, push: true}
  const preferences = {
    like: all,
    reply: all,
    mention: all,
    quote: all,
    repost: all,
  }

  beforeEach(() => {
    mockFeatures = new Set(['private.notificationPreferences'])
    mockPrismCall.mockReset()
    mockToggles.clear()
    mockSegments.clear()
  })

  it('with the feature, the rows are live, with no note', async () => {
    mockPrismCall.mockResolvedValue({preferences})
    const screen = show(<PrivateNotificationSettings />)
    await waitFor(() =>
      expect(mockToggles.has('private_notification_like')).toBe(true),
    )
    expect(
      screen.queryByText(
        'Private notification settings arrive with server support.',
      ),
    ).toBeNull()
    for (const reason of ['like', 'reply', 'mention', 'quote', 'repost']) {
      expect(mockToggles.has(`private_notification_${reason}`)).toBe(true)
    }
  })

  it('turning a reason off sends that reason whole, the rest kept', async () => {
    mockPrismCall.mockResolvedValue({preferences})
    show(<PrivateNotificationSettings />)
    await waitFor(() =>
      expect(mockToggles.has('private_notification_like')).toBe(true),
    )
    mockPrismCall.mockResolvedValue({
      preferences: {...preferences, like: {...all, list: false}},
    })
    act(() => mockToggles.get('private_notification_like')!(false))
    const put = await waitFor(() => {
      const call = mockPrismCall.mock.calls.find(
        ([method]) => method === nearhorizon.privatePutNotificationPreferences,
      )
      expect(call).toBeTruthy()
      return call
    })
    expect(put?.[1]).toEqual({like: {include: 'all', list: false, push: true}})
  })

  it('"People I follow" sends include follows', async () => {
    mockPrismCall.mockResolvedValue({preferences})
    show(<PrivateNotificationSettings />)
    await waitFor(() =>
      expect(mockSegments.has('Whose activity notifies you')).toBe(true),
    )
    act(() => mockSegments.get('Whose activity notifies you')!('follows'))
    const put = await waitFor(() => {
      const call = mockPrismCall.mock.calls.find(
        ([method]) => method === nearhorizon.privatePutNotificationPreferences,
      )
      expect(call).toBeTruthy()
      return call
    })
    expect(Object.values(put?.[1] as object)[0]).toMatchObject({
      include: 'follows',
      list: true,
    })
  })

  it('without the feature, prism is not asked', () => {
    mockFeatures = new Set()
    show(<PrivateNotificationSettings />)
    expect(mockPrismCall).not.toHaveBeenCalled()
  })
})

describe('the composer reads the defaults for members only', () => {
  it('a member gets them; a non-member and the switch off get none', () => {
    expect(renderHook(() => usePrivateComposeDefaults()).result.current).toBe(
      mockDefaults,
    )
    mockIsMember = false
    expect(
      renderHook(() => usePrivateComposeDefaults()).result.current,
    ).toBeUndefined()
    mockIsMember = true
    mockDefaultsSwitch = false
    expect(
      renderHook(() => usePrivateComposeDefaults()).result.current,
    ).toBeUndefined()
  })
})
