import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 6.2, 13 ("Profile header", P5R1-L3), B-8, B-9: the real
 * profile header with who is fronting now in the name and images, the
 * system badge, the front indicator and pronouns under the handle, while
 * the `profile` handed to Edit Profile and the unfollow prompt stays the
 * account's; and the hover card, headed by the account with a "Fronting
 * now" line. Fixtures only; no network call.
 */

jest.mock(
  '#/state/session/network',
  () => jest.requireActual<{networkMock: unknown}>('./harness').networkMock,
)
let mockIsMe = false
jest.mock('#/state/session', () => ({
  useMaybePdsClient: () => null,
  useSession: () => ({
    hasSession: true,
    currentAccount: mockIsMe
      ? {did: 'did:plc:authoraaaaaaaaaaaaaaaaaa'}
      : {did: 'did:plc:readeraaaaaaaaaaaaaaaaaa'},
    // One account signed in: act as (5E) offers nothing.
    accounts: [],
  }),
  useRequireAuth: () => (fn: () => unknown) => fn(),
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
jest.unmock('multiformats/cid')

const mockEditProfiles: unknown[] = []
/** Every Edit Profile dialog mounted, with its control and initial tab. */
const mockEditDialogs: {
  profile: unknown
  control: unknown
  initialTab?: string
}[] = []
const mockToasts: string[] = []
jest.mock('#/screens/Profile/Header/EditProfileDialog', () => ({
  EditProfileDialog: (props: {
    profile: unknown
    control: unknown
    initialTab?: string
  }) => {
    mockEditProfiles.push(props.profile)
    mockEditDialogs.push(props)
    return null
  },
}))
jest.mock('#/components/Toast', () => ({
  show: (message: string) => {
    mockToasts.push(message)
  },
}))
jest.mock('#/state/cache/profile-shadow', () => ({
  useProfileShadow: (profile: unknown) => profile,
}))
jest.mock('#/state/queries/profile', () => ({
  useProfileBlockMutationQueue: () => [() => {}, () => Promise.resolve()],
  useProfileFollowMutationQueue: () => [
    () => Promise.resolve(),
    () => Promise.resolve(),
  ],
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
/** Dialog controls opened, and the controls the front switcher was given. */
const mockOpened: unknown[] = []
const mockSwitchers: {control: unknown; did: string}[] = []
jest.mock('#/components/Dialog', () => ({
  useDialogControl: () => {
    const control = {
      open: () => {
        mockOpened.push(control)
      },
      close: () => {},
    }
    return control
  },
}))
jest.mock('#/horizon/identity/edit/FrontSwitcherDialog', () => ({
  FrontSwitcherDialog: (props: {control: unknown; did: string}) => {
    mockSwitchers.push(props)
    return null
  },
}))
/** The member lists mounted, with their "Edit" callback. */
const mockMemberLists: {did: string; onEdit?: () => void}[] = []
jest.mock('#/horizon/identity/MemberListDialog', () => ({
  MemberListDialog: (props: {did: string; onEdit?: () => void}) => {
    mockMemberLists.push(props)
    return null
  },
}))
jest.mock('#/screens/Profile/Header/Shell', () => ({
  ProfileHeaderShell: (props: {children?: React.ReactNode}) => props.children,
}))
jest.mock('#/screens/Profile/Header/Handle', () => ({
  ProfileHeaderHandle: () => null,
}))
jest.mock('#/screens/Profile/Header/Metrics', () => ({
  ProfileHeaderMetrics: () => null,
}))
jest.mock('#/screens/Profile/Header/SuggestedFollows', () => ({
  ProfileHeaderSuggestedFollows: () => null,
}))
jest.mock('#/screens/Profile/components/GermButton', () => ({
  GermButton: () => null,
  isGermButtonShown: () => false,
}))
jest.mock('#/view/com/profile/ProfileMenu', () => ({ProfileMenu: () => null}))
jest.mock('#/components/activity-notifications/SubscribeProfileButton', () => ({
  SubscribeProfileButton: () => null,
}))
jest.mock('#/components/dms/MessageProfileButton', () => ({
  MessageProfileButton: () => null,
}))
jest.mock('#/components/DebugFieldDisplay', () => ({
  DebugFieldDisplay: () => null,
}))
jest.mock('#/components/KnownFollowers', () => ({
  KnownFollowers: () => null,
  shouldShowKnownFollowers: () => false,
}))
jest.mock('#/components/Prompt', () => ({
  usePromptControl: () => ({open: () => {}, close: () => {}}),
  Basic: () => null,
}))
jest.mock('#/components/RichText', () => ({RichText: () => null}))
jest.mock('#/components/ProfileBadges', () => ({ProfileBadges: () => null}))
jest.mock('#/features/inviteFriends', () => ({InviteFriendsDialog: () => null}))
jest.mock('#/features/liveNow', () => ({
  useActorStatus: () => ({isActive: false}),
}))
jest.mock('#/features/profileLinks', () => ({ProfileHeaderLinks: () => null}))
jest.mock('#/horizon/refract/labeler', () => ({
  restoredModerationOpts: (opts: unknown) => opts,
}))
jest.mock('#/horizon/refract/visitor', () => ({
  useRestoredActionsHidden: () => false,
}))
jest.mock('#/analytics', () => ({
  useAnalytics: () => ({metric: () => {}}),
}))
jest.mock('#/lib/haptics', () => ({
  useHaptics: () => ({tap: () => {}, confirm: () => {}}),
}))

import {moderateProfile, type ModerationOpts} from '@bsky/sdk/moderation'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {type QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, fireEvent, render, screen} from '@testing-library/react-native'

import {ProfileHeaderStandard} from '#/screens/Profile/Header/ProfileHeaderStandard'
import * as switches from '#/horizon/switches'
import {HoverCardIdentity} from '../HoverCardIdentity'
import {resetMemberImageFailures} from '../images'
import {usePluralHeaderImages} from '../ProfileIdentity'
import {setIdentityRunStart} from '../queries'
import {resetIdentityReads} from '../reads'
import {resetIdentitySchedule, setIdentityVisibility} from '../schedule'
import {
  AUTHOR,
  FRONT,
  MEMBER,
  newQueryClient,
  pds,
  PRONOUNS,
  records,
  resetHarness,
  SPARROW,
  SYSTEM,
  uriOf,
  world,
  WREN,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const START = 1_790_000_000_000
const WREN_AVATAR = 'bafkreiwrenavatar'
const WREN_BANNER = 'bafkreiwrenbanner'
let qc: QueryClient

const moderationOpts: ModerationOpts = {
  userDid: undefined,
  prefs: {
    adultContentEnabled: false,
    labels: {},
    labelers: [],
    mutedWords: [],
    hiddenPosts: [],
  },
  labelDefs: {},
}

const profile = {
  did: AUTHOR,
  handle: 'flock.example',
  displayName: 'The Flock',
  avatar: 'https://cdn.example/account.jpg',
  banner: 'https://cdn.example/account-banner.jpg',
  pronouns: 'he/him',
  viewer: {following: 'at://x/app.bsky.graph.follow/1'},
} as const

function blob(cid: string) {
  return {$type: 'blob', ref: {$link: cid}, mimeType: 'image/png', size: 10}
}

function wrap(children: React.ReactNode) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nProvider>
  )
}

function header() {
  return render(
    wrap(
      <ProfileHeaderStandard
        profile={profile as never}
        descriptionRT={null}
        moderationOpts={moderationOpts}
      />,
    ),
  )
}

async function advance(ms = 300) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

type Node = ReturnType<typeof screen.getByTestId>

/** An element's text, nested texts included, without bidi marks. */
function textOf(node: Node | string): string {
  if (typeof node === 'string') return node.replace(/[\u202A-\u202E]/g, '')
  return node.children.map(child => textOf(child)).join('')
}

beforeEach(() => {
  jest.useFakeTimers({now: START})
  resetHarness()
  resetIdentityReads()
  resetIdentitySchedule()
  setIdentityVisibility({isVisible: () => true, subscribe: () => () => {}})
  setIdentityRunStart(START)
  resetMemberImageFailures()
  qc = newQueryClient()
  mockIsMe = false
  mockEditProfiles.length = 0
  mockEditDialogs.length = 0
  mockMemberLists.length = 0
  mockToasts.length = 0
  mockOpened.length = 0
  mockSwitchers.length = 0
  world.records.set(uriOf(AUTHOR, SYSTEM), records.system())
  world.records.set(
    uriOf(AUTHOR, MEMBER, WREN),
    records.member('Wren', {
      pronouns: [{forms: ['she', 'her']}],
      avatar: blob(WREN_AVATAR),
      banner: blob(WREN_BANNER),
    }),
  )
  world.records.set(
    uriOf(AUTHOR, MEMBER, SPARROW),
    records.member('Sparrow', {pronouns: [{forms: ['they', 'them']}]}),
  )
  world.records.set(uriOf(AUTHOR, PRONOUNS), records.pronouns([['it', 'its']]))
})

afterEach(() => {
  qc.clear()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('the profile header (ID-17, ID-17a, 6.2)', () => {
  it('one engaging member: its name with &, its pronouns, the badge; Edit Profile keeps the account (P5R1-L3)', async () => {
    mockIsMe = true
    world.records.set(uriOf(AUTHOR, FRONT), records.front([WREN]))
    header()
    await advance()
    expect(textOf(screen.getByTestId('profileHeaderDisplayName'))).toBe(
      'Wren ',
    )
    expect(textOf(screen.getByTestId('profilePronouns'))).toBe('she/her')
    expect(textOf(screen.getByTestId('pluralBadge'))).toBe(
      'The Flock \u00B7 2 members',
    )
    const seeded = mockEditProfiles.at(-1)
    expect(seeded).toBe(profile)
    expect(seeded).toMatchObject({
      displayName: 'The Flock',
      avatar: 'https://cdn.example/account.jpg',
    })
  })

  it('several engaging: names with one & after the last, the account`s pronouns, each member`s in the indicator', async () => {
    world.records.set(
      uriOf(AUTHOR, FRONT),
      records.front([SPARROW, WREN], {state: 'co-fronting'}),
    )
    header()
    await advance()
    expect(textOf(screen.getByTestId('profileHeaderDisplayName'))).toBe(
      'Wren & Sparrow ',
    )
    expect(textOf(screen.getByTestId('profilePronouns'))).toBe('it/its')
    const indicator = screen.getByTestId('frontIndicator')
    expect(indicator.props.accessibilityLabel).toBe(
      'Front: Co-fronting. Wren, she/her. Sparrow, they/them',
    )
  })

  it('the unfollow toast names the account, not the member', async () => {
    world.records.set(uriOf(AUTHOR, FRONT), records.front([WREN]))
    header()
    await advance()
    fireEvent.press(screen.getByTestId('unfollowBtn'))
    await advance(10)
    expect(mockToasts).toEqual(['No longer following The Flock'])
  })

  it('an empty front says "Nobody fronting"; no front record shows no indicator', async () => {
    world.records.set(uriOf(AUTHOR, FRONT), records.front([]))
    const first = header()
    await advance()
    expect(textOf(screen.getByTestId('frontIndicator'))).toContain(
      'Nobody fronting',
    )
    expect(textOf(screen.getByTestId('profileHeaderDisplayName'))).toBe(
      'The Flock ',
    )
    first.unmount()
    world.records.delete(uriOf(AUTHOR, FRONT))
    qc.clear()
    resetIdentitySchedule()
    header()
    await advance()
    expect(screen.queryByTestId('frontIndicator')).toBeNull()
  })

  it('an account with no system is stock: no badge, no indicator, its own pronouns', async () => {
    world.records.delete(uriOf(AUTHOR, SYSTEM))
    world.records.set(uriOf(AUTHOR, FRONT), records.front([WREN]))
    header()
    await advance()
    expect(textOf(screen.getByTestId('profileHeaderDisplayName'))).toBe(
      'The Flock ',
    )
    expect(screen.queryByTestId('pluralBadge')).toBeNull()
    expect(screen.queryByTestId('frontIndicator')).toBeNull()
    expect(textOf(screen.getByTestId('profilePronouns'))).toBe('it/its')
  })

  it('holds the header at the account while an engaging member is unknown', async () => {
    world.records.set(uriOf(AUTHOR, FRONT), records.front([SPARROW, WREN]))
    world.unknown.add(uriOf(AUTHOR, MEMBER, SPARROW))
    world.listStatus.set(AUTHOR, 'unknown')
    header()
    await advance()
    expect(textOf(screen.getByTestId('profileHeaderDisplayName'))).toBe(
      'The Flock ',
    )
  })
})

describe('the front switcher from the indicator (6.2, 7.3, 5C)', () => {
  it('on one`s own profile the indicator opens the switcher for one`s own DID', async () => {
    mockIsMe = true
    world.records.set(
      uriOf(AUTHOR, FRONT),
      records.front([WREN], {state: 'solo'}),
    )
    header()
    await advance()
    const switcher = mockSwitchers.at(-1)
    expect(switcher?.did).toBe(AUTHOR)
    fireEvent.press(screen.getByTestId('frontIndicatorButton'))
    expect(mockOpened).toContain(mockSwitchers.at(-1)?.control)
  })

  it('on one`s own profile with no front record, "Set front" opens it', async () => {
    mockIsMe = true
    header()
    await advance()
    expect(screen.queryByTestId('frontIndicator')).toBeNull()
    fireEvent.press(screen.getByTestId('setFrontButton'))
    expect(mockOpened).toContain(mockSwitchers.at(-1)?.control)
  })

  it('on another account`s profile the indicator is text, with no switcher', async () => {
    world.records.set(
      uriOf(AUTHOR, FRONT),
      records.front([WREN], {state: 'solo'}),
    )
    header()
    await advance()
    expect(screen.getByTestId('frontIndicator')).toBeTruthy()
    expect(screen.queryByTestId('frontIndicatorButton')).toBeNull()
    expect(screen.queryByTestId('setFrontButton')).toBeNull()
    expect(mockSwitchers).toHaveLength(0)
  })
})

describe('the member list`s Edit (6.2, ID-20a)', () => {
  it('on one`s own system opens Edit Profile on the Plurality tab, with the account`s profile', async () => {
    mockIsMe = true
    header()
    await advance()
    const list = mockMemberLists.at(-1)
    expect(list?.did).toBe(AUTHOR)
    expect(list?.onEdit).toBeInstanceOf(Function)
    const plurality = mockEditDialogs.filter(d => d.initialTab === 'plurality')
    expect(plurality.length).toBeGreaterThan(0)
    expect(plurality.at(-1)?.profile).toBe(profile)
    act(() => list?.onEdit?.())
    expect(mockOpened).toContain(plurality.at(-1)?.control)
    // The stock Edit Profile button's dialog still opens on Profile.
    expect(mockEditDialogs.some(d => d.initialTab === undefined)).toBe(true)
  })

  it('on another account`s system offers no Edit and mounts no Plurality dialog', async () => {
    header()
    await advance()
    expect(mockMemberLists.length).toBeGreaterThan(0)
    expect(mockMemberLists.every(m => m.onEdit === undefined)).toBe(true)
    expect(mockEditDialogs.some(d => d.initialTab === 'plurality')).toBe(false)
  })

  it('with PLURAL_EDITING off offers no Edit on one`s own system', async () => {
    jest.replaceProperty(switches, 'PLURAL_EDITING', false)
    mockIsMe = true
    header()
    await advance()
    expect(mockMemberLists.length).toBeGreaterThan(0)
    expect(mockMemberLists.every(m => m.onEdit === undefined)).toBe(true)
    expect(mockEditDialogs.some(d => d.initialTab === 'plurality')).toBe(false)
  })
})

describe('the header images (ID-18)', () => {
  it('one engaging member: its avatar and banner through the CDN; several: the account`s', async () => {
    world.records.set(uriOf(AUTHOR, FRONT), records.front([WREN]))
    const {result} = renderImages()
    await advance()
    expect(result.current.avatar).toContain(WREN_AVATAR)
    expect(result.current.banner).toContain(WREN_BANNER)
    world.records.set(uriOf(AUTHOR, FRONT), records.front([WREN, SPARROW]))
    qc.clear()
    resetIdentitySchedule()
    const second = renderImages()
    await advance()
    expect(second.result.current).toEqual({
      avatar: profile.avatar,
      banner: profile.banner,
    })
  })

  it('another account`s member the CDN fails on: the account`s own avatar and banner, never its PDS (PP-12, L9)', async () => {
    world.records.set(uriOf(AUTHOR, FRONT), records.front([WREN]))
    const {result} = renderImages()
    await advance()
    expect(result.current.avatar).toContain('cdn.bsky.app')
    expect(result.current.banner).toContain('cdn.bsky.app')
    act(() => result.current.onAvatarError?.())
    expect(result.current.avatar).toBe(profile.avatar)
    expect(result.current.banner).toContain(WREN_BANNER)
    act(() => result.current.onBannerError?.())
    expect(result.current).toEqual({
      avatar: profile.avatar,
      banner: profile.banner,
    })
    await advance()
    expect(pds.calls).toHaveLength(0)
  })
})

function renderImages() {
  let current: ReturnType<typeof usePluralHeaderImages> = {
    avatar: undefined,
    banner: undefined,
  }
  function Probe() {
    current = usePluralHeaderImages(profile)
    return null
  }
  render(wrap(<Probe />))
  return {
    result: {
      get current() {
        return current
      },
    },
  }
}

describe('the hover card (ID-19, P5R1-N3)', () => {
  it('keeps the account`s pronouns and adds a "Fronting now" line', async () => {
    world.records.set(uriOf(AUTHOR, FRONT), records.front([WREN]))
    render(
      wrap(
        <HoverCardIdentity
          profile={profile}
          moderation={moderateProfile(profile as never, moderationOpts)}
        />,
      ),
    )
    await advance()
    expect(textOf(screen.getByTestId('profilePronouns'))).toBe('it/its')
    expect(
      screen.getByTestId('hoverFrontingNow').props.accessibilityLabel,
    ).toBe('Fronting now: Wren, she/her')
    expect(textOf(screen.getByTestId('pluralBadge'))).toContain('The Flock')
  })
})
