import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 13, the 5B display items, through the real stock author
 * line (`PostMeta`, ID-1, ID-2) and avatar (`PreviewableUserAvatar`, ID-9):
 * fronters in place of the name with the `&` never read, the name link's
 * label in words, pronouns after the handle by the three answers, the scope
 * check, stock caches kept clean, the account's avatar moderation on the
 * member's image, and the switches. Fixtures only; no network call.
 */

jest.mock(
  '#/state/session/network',
  () => jest.requireActual<{networkMock: unknown}>('./harness').networkMock,
)
jest.mock('#/state/session', () => ({
  useMaybePdsClient: () => null,
  useSession: () => ({hasSession: false, currentAccount: undefined}),
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
jest.unmock('multiformats/cid')

const mockCached: unknown[] = []
jest.mock('#/state/queries/profile', () => ({
  unstableCacheProfileView: (_qc: unknown, profile: unknown) => {
    mockCached.push(profile)
  },
}))
jest.mock('#/state/queries/unstable-profile-cache', () => ({
  unstableCacheProfileView: (_qc: unknown, profile: unknown) => {
    mockCached.push(profile)
  },
}))
jest.mock('#/state/cache/profile-shadow', () => ({
  useProfileShadow: (profile: unknown) => profile,
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  tokens: {space: {lg: 16}},
  web: () => ({}),
  native: () => ({}),
  ios: () => ({}),
  android: () => ({}),
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
jest.mock('#/components/Link', () => {
  const {Text, Pressable, View} = jest.requireActual<{
    Text: React.ComponentType<Record<string, unknown>>
    Pressable: React.ComponentType<Record<string, unknown>>
    View: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  const inlineLink = (props: {
    label: string
    onPress?: () => void
    children?: React.ReactNode
    testID?: string
  }) => (
    <Text
      accessibilityLabel={props.label}
      accessibilityHint=""
      onPress={props.onPress}
      testID={props.testID ?? 'inlineLink'}>
      {props.children}
    </Text>
  )
  return {
    WebOnlyInlineLinkText: inlineLink,
    InlineLinkText: inlineLink,
    Link: (props: {
      label: string
      onPress?: () => void
      children?: React.ReactNode
    }) => (
      <Pressable
        accessibilityLabel={props.label}
        accessibilityHint=""
        onPress={props.onPress}>
        <View>{props.children}</View>
      </Pressable>
    ),
  }
})
jest.mock('#/components/ProfileBadges', () => ({ProfileBadges: () => null}))
jest.mock('#/components/ProfileHoverCard', () => ({
  ProfileHoverCard: (props: {children?: React.ReactNode}) => props.children,
}))
jest.mock('#/features/liveNow', () => ({
  useActorStatus: () => ({isActive: false}),
}))
jest.mock('#/features/liveNow/components/LiveIndicator', () => ({
  LiveIndicator: () => null,
}))
jest.mock('#/features/liveNow/components/LiveStatusDialog', () => ({
  LiveStatusDialog: () => null,
}))
jest.mock('#/view/com/composer/photos/EditImageDialog', () => ({
  EditImageDialog: () => null,
}))
// The avatar's editing and native modules, which the preview never uses.
jest.mock('expo-image', () => {
  const {View} = jest.requireActual<{
    View: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {Image: (props: Record<string, unknown>) => <View {...props} />}
})
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
  Circle: () => null,
  Path: () => null,
  Rect: () => null,
}))
jest.mock('#/lib/haptics', () => ({useHaptics: () => ({tap: () => {}})}))
jest.mock('#/lib/hooks/usePermissions', () => ({
  useCameraPermission: () => ({}),
  usePhotoLibraryPermission: () => ({}),
}))
jest.mock('#/lib/media/manip', () => ({compressIfNeeded: () => {}}))
jest.mock('#/lib/media/picker', () => ({}))
jest.mock('#/state/gallery', () => ({}))
jest.mock('#/components/Dialog', () => ({
  useDialogControl: () => ({open: () => {}, close: () => {}}),
}))
jest.mock('#/components/Dialog/sheet-wrapper', () => ({
  useSheetWrapper: () => (value: unknown) => value,
}))
jest.mock('#/components/Menu', () => ({}))
jest.mock('#/components/Button', () => ({Button: () => null}))
jest.mock('#/components/icons/Camera', () => ({}))
jest.mock('#/components/icons/StreamingLive', () => ({}))
jest.mock('#/components/icons/Trash', () => ({}))
jest.mock('#/components/MediaInsetBorder', () => ({
  MediaInsetBorder: () => null,
}))
jest.mock('#/analytics', () => ({
  useAnalytics: () => ({metric: () => {}}),
}))
jest.mock('#/horizon/private/render/PrivateBadge', () => ({
  PrivateHeaderLock: () => null,
}))
jest.mock('#/horizon/private/render/SyncingLabel', () => ({
  SyncingMetaLabel: () => null,
}))
jest.mock('#/view/com/util/TimeElapsed', () => ({
  TimeElapsed: (props: {
    children: (args: {timeElapsed: string}) => React.ReactNode
  }) => props.children({timeElapsed: '1h'}),
}))

import {type ModerationDecision} from '@bsky/sdk/moderation'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {type QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, fireEvent, render, screen} from '@testing-library/react-native'

import {PostMeta} from '#/view/com/util/PostMeta'
import {PreviewableUserAvatar} from '#/view/com/util/UserAvatar'
import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'
import * as switches from '#/horizon/switches'
import {resetMemberImageFailures} from '../images'
import {setIdentityRunStart} from '../queries'
import {resetIdentityReads} from '../reads'
import {resetIdentitySchedule, setIdentityVisibility} from '../schedule'
import {PostFrontersScope} from '../scope'
import {
  AUTHOR,
  MEMBER,
  newQueryClient,
  OTHER,
  pds,
  prism,
  PRONOUNS,
  records,
  resetHarness,
  signIn,
  signOut,
  SPARROW,
  SYSTEM,
  uriOf,
  world,
  WREN,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const START = 1_790_000_000_000
let qc: QueryClient

const AVATAR_CID = 'bafkreiwrenavatar'

const author = {
  did: AUTHOR,
  handle: 'flock.example',
  displayName: 'The Flock',
  pronouns: 'he/him',
} as const

function postWith(ids: string[] | undefined) {
  return {
    uri: `at://${AUTHOR}/app.bsky.feed.post/3m4kq9post222`,
    author,
    record: {
      $type: 'app.bsky.feed.post',
      text: 'we both agree on this one',
      createdAt: '2026-10-24T12:00:00.000Z',
      ...(ids ? {[PLURAL_FRONTERS_KEY]: {members: ids.map(id => ({id}))}} : {}),
    },
  }
}

const moderation = {
  ui: () => ({
    blur: false,
    alert: false,
    alerts: [],
    blurs: [],
    filter: false,
    filters: [],
    noOverride: false,
    inform: false,
    informs: [],
  }),
} as unknown as ModerationDecision

function meta(
  post: ReturnType<typeof postWith> | undefined,
  {metaAuthor = author}: {metaAuthor?: typeof author | typeof other} = {},
) {
  const line = (
    <PostMeta
      author={metaAuthor}
      moderation={moderation}
      postHref="/profile/flock.example/post/3m4kq9post222"
      timestamp="2026-10-24T12:00:00.000Z"
    />
  )
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        {post ? (
          <PostFrontersScope post={post}>{line}</PostFrontersScope>
        ) : (
          line
        )}
      </QueryClientProvider>
    </I18nProvider>,
  )
}

const other = {
  did: OTHER,
  handle: 'other.example',
  displayName: 'Other',
  pronouns: undefined,
} as const

async function advance(ms = 100) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

function nameLink() {
  return screen.getAllByTestId('inlineLink')[0]
}

type Node = ReturnType<typeof screen.getByTestId>

/** An element's text, nested texts included, spaces normalised. */
function textOf(node: Node | string): string {
  if (typeof node === 'string') return node.replace(/[\u202A-\u202E]/g, '')
  return node.children.map(child => textOf(child)).join('')
}

/** A label without the bidi marks the handle carries on native. */
function plain(label: unknown): string {
  return String(label).replace(/[\u202A-\u202E]/g, '')
}

function expectText(node: Node, text: string) {
  expect(
    textOf(node)
      .replace(/\u00A0/g, ' ')
      .trim(),
  ).toBe(text)
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
  mockCached.length = 0
  world.records.set(uriOf(AUTHOR, SYSTEM), records.system())
  world.records.set(
    uriOf(AUTHOR, MEMBER, WREN),
    records.member('Wren', {
      color: '#3366ff',
      pronouns: [{forms: ['she', 'her']}],
      avatar: {
        $type: 'blob',
        ref: {$link: AVATAR_CID},
        mimeType: 'image/png',
        size: 10,
      },
    }),
  )
  world.records.set(uriOf(AUTHOR, MEMBER, SPARROW), records.member('Sparrow'))
})

afterEach(() => {
  qc.clear()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('the author line (ID-1, ID-2, 6.3, 6.5)', () => {
  it('names two fronters with one & that is never read, the label in words, and no pronouns', async () => {
    meta(postWith([SPARROW, WREN]))
    await advance()
    expectText(nameLink(), 'Wren, Sparrow&')
    expect(screen.getByText('&').props.accessible).toBe(false)
    expect(plain(nameLink().props.accessibilityLabel)).toBe(
      'Wren, she/her and Sparrow, of The Flock, @flock.example',
    )
    // Several fronters: no pronouns on the author line (Q6).
    expect(screen.queryByTestId('authorPronouns')).toBeNull()
  })

  it('gives one fronter its pronouns in the account`s place, after the handle', async () => {
    meta(postWith([WREN]))
    await advance()
    expectText(nameLink(), 'Wren&')
    expectText(screen.getByTestId('authorPronouns'), 'she/her')
    expect(plain(nameLink().props.accessibilityLabel)).toBe(
      'Wren, of The Flock, @flock.example, she/her',
    )
  })

  it('shows the account exactly as stock while a member is unknown, then the members', async () => {
    world.unknown.add(uriOf(AUTHOR, MEMBER, SPARROW))
    meta(postWith([WREN, SPARROW]))
    await advance()
    expectText(nameLink(), 'The Flock')
    expect(screen.queryByText('&')).toBeNull()
    expect(plain(nameLink().props.accessibilityLabel)).toBe('View profile')
    world.unknown.clear()
    await advance(31_000)
    expectText(nameLink(), 'Wren, Sparrow&')
  })

  it('shows the account with no & when no named member is left', async () => {
    world.records.delete(uriOf(AUTHOR, MEMBER, WREN))
    meta(postWith([WREN]))
    await advance()
    expectText(nameLink(), 'The Flock')
    expect(screen.queryByText('&')).toBeNull()
  })

  it('shows the account when the system record is gone, whatever the post names', async () => {
    world.records.delete(uriOf(AUTHOR, SYSTEM))
    meta(postWith([WREN]))
    await advance()
    expectText(nameLink(), 'The Flock')
    expect(screen.queryByText('&')).toBeNull()
  })

  it('draws another DID`s line inside the scope as stock (PP-15)', async () => {
    world.records.set(uriOf(OTHER, SYSTEM), records.system())
    meta(postWith([WREN]), {metaAuthor: other})
    await advance()
    expectText(nameLink(), 'Other')
    expect(screen.queryByText('&')).toBeNull()
  })

  it('keeps stock caches clean: pressing the name caches the account`s own profile (PP-14)', async () => {
    meta(postWith([WREN]))
    await advance()
    expectText(nameLink(), 'Wren&')
    fireEvent.press(nameLink())
    expect(mockCached).toHaveLength(1)
    expect(mockCached[0]).toBe(author)
    expect(mockCached[0]).toMatchObject({displayName: 'The Flock'})
  })
})

describe('pronouns on the author line, three answers (PP-8)', () => {
  it('shows the record, by its displayMode', async () => {
    world.records.set(
      uriOf(AUTHOR, PRONOUNS),
      records.pronouns(
        [
          ['they', 'them'],
          ['xe', 'xem'],
        ],
        {displayMode: 'firstOnly'},
      ),
    )
    meta(undefined)
    await advance()
    expectText(screen.getByTestId('authorPronouns'), 'they/them')
  })

  it('shows the short field only on a proven none', async () => {
    meta(undefined)
    await advance()
    expectText(screen.getByTestId('authorPronouns'), 'he/him')
  })

  it('shows nothing while unknown, never the short field', async () => {
    world.unknown.add(AUTHOR)
    meta(undefined)
    await advance()
    expect(screen.queryByTestId('authorPronouns')).toBeNull()
  })

  it('shows nothing for an empty-sets record, and no fallback', async () => {
    world.records.set(uriOf(AUTHOR, PRONOUNS), records.pronouns([]))
    meta(undefined)
    await advance()
    expect(screen.queryByTestId('authorPronouns')).toBeNull()
  })
})

describe('the switches restore stock at the author line (10)', () => {
  it('PLURAL_DISPLAY off: the account, no &, no plural read', async () => {
    jest.replaceProperty(switches, 'PLURAL_DISPLAY', false)
    world.unknown.add(AUTHOR)
    meta(postWith([WREN]))
    await advance()
    expectText(nameLink(), 'The Flock')
    expect(screen.queryByText('&')).toBeNull()
    const asked = prism.calls.flatMap(call => call.params.getAll('members'))
    expect(asked).toHaveLength(0)
  })

  it('PRONOUNS off: no pronouns text and no read', async () => {
    jest.replaceProperty(switches, 'PRONOUNS', false)
    jest.replaceProperty(switches, 'PLURAL_DISPLAY', false)
    meta(undefined)
    await advance()
    expect(screen.queryByTestId('authorPronouns')).toBeNull()
    expect(prism.calls).toHaveLength(0)
  })
})

describe('the avatar (ID-9, P5R1-L2, P5R2-N12)', () => {
  function avatar(
    post: ReturnType<typeof postWith> | undefined,
    blurred = false,
  ) {
    const el = (
      <PreviewableUserAvatar
        size={42}
        profile={{...author, avatar: 'https://cdn.example/account.jpg'}}
        moderation={{
          blur: blurred,
          alert: blurred,
          noOverride: false,
          alerts: [],
          blurs: [],
          filter: false,
          filters: [],
          inform: false,
          informs: [],
        }}
        type="user"
        disableHoverCard
        disableNavigation
      />
    )
    return render(
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          {post ? <PostFrontersScope post={post}>{el}</PostFrontersScope> : el}
        </QueryClientProvider>
      </I18nProvider>,
    )
  }

  it('shows the single fronter`s image through the CDN, blurred with the alert when the account`s avatar is', async () => {
    avatar(postWith([WREN]), true)
    await advance()
    const image = screen.getByTestId('userAvatarImage')
    expect(String((image.props.source as {uri: string}).uri)).toContain(
      AVATAR_CID,
    )
    expect(image.props.blurRadius).toBeGreaterThan(0)
    expect(screen.getByText('!')).toBeTruthy()
  })

  it('keeps the account`s image with several fronters', async () => {
    avatar(postWith([WREN, SPARROW]))
    await advance()
    const image = screen.getByTestId('userAvatarImage')
    expect(String((image.props.source as {uri: string}).uri)).toContain(
      'account',
    )
  })

  function shownUri() {
    const image = screen.getByTestId('userAvatarImage')
    return String((image.props.source as {uri: string}).uri)
  }

  function failImage() {
    const image = screen.getByTestId('userAvatarImage')
    const onError = image.props.onError as (() => void) | undefined
    expect(onError).toBeInstanceOf(Function)
    act(() => onError?.())
  }

  it('another account`s member the CDN fails on: the account`s own avatar, and no PDS is asked (PP-12, L9)', async () => {
    avatar(postWith([WREN]))
    await advance()
    const seen = [shownUri()]
    expect(seen[0]).toBe(
      `https://cdn.bsky.app/img/avatar_thumbnail/plain/${AUTHOR}/${AVATAR_CID}@jpeg`,
    )
    failImage()
    seen.push(shownUri())
    expect(seen[1]).toBe('https://cdn.example/account.jpg')
    // The account's own image is stock's: no member fallback is attached.
    expect(screen.getByTestId('userAvatarImage').props.onError).toBeUndefined()
    await advance()
    expect(seen.some(uri => uri.includes('getBlob'))).toBe(false)
    expect(pds.calls).toHaveLength(0)
    expect(
      prism.calls.every(call =>
        call.method.startsWith('app.nearhorizon.plural.'),
      ),
    ).toBe(true)
  })

  it('a second post by the same member after a CDN failure starts at the account`s avatar', async () => {
    const first = avatar(postWith([WREN]))
    await advance()
    failImage()
    first.unmount()
    avatar(postWith([WREN]))
    await advance()
    expect(shownUri()).toBe('https://cdn.example/account.jpg')
  })

  it('one`s own member the CDN fails on: the own PDS copy, then the account`s avatar', async () => {
    signIn(AUTHOR, qc)
    try {
      pds.records.set(uriOf(AUTHOR, SYSTEM), records.system())
      pds.records.set(
        uriOf(AUTHOR, MEMBER, WREN),
        records.member('Wren', {
          avatar: {
            $type: 'blob',
            ref: {$link: AVATAR_CID},
            mimeType: 'image/png',
            size: 10,
          },
        }),
      )
      avatar(postWith([WREN]))
      await advance()
      expect(shownUri()).toContain('cdn.bsky.app')
      failImage()
      const own = new URL(shownUri())
      expect(`${own.origin}${own.pathname}`).toBe(
        'https://pds.example/xrpc/com.atproto.sync.getBlob',
      )
      expect(own.searchParams.get('did')).toBe(AUTHOR)
      expect(own.searchParams.get('cid')).toBe(AVATAR_CID)
      failImage()
      expect(shownUri()).toBe('https://cdn.example/account.jpg')
    } finally {
      signOut()
    }
  })

  it('outside any scope adds no query observer and asks nothing', async () => {
    avatar(undefined)
    await advance()
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
    expect(prism.calls).toHaveLength(0)
  })
})
