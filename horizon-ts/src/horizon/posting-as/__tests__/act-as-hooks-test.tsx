/* oxlint-disable import/no-nodejs-modules -- reads the hooked stock files as text, in jest only */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {renderHook} from '@testing-library/react-native'

/*
 * Act as on the stock controls (Phase 5 design 8.6, section 10, hooks PA-6
 * to PA-8): who is offered, the `ACT_AS_CONTROLS` switch restoring stock,
 * and the hook lines in the stock files, which are too large to render
 * here, checked in source as `publish-paths-test.ts` does for the composer.
 */
type MockAccount = {
  did: string
  handle: string
  refreshJwt?: string
  isOauthSession?: boolean
}
let mockSession: {
  hasSession: boolean
  currentAccount: MockAccount | undefined
  accounts: MockAccount[]
} = {hasSession: false, currentAccount: undefined, accounts: []}
jest.mock('#/state/session', () => ({
  useSession: () => mockSession,
}))
let mockSwitch = true
// A getter, read at render: the factory runs before `mockSwitch` is set.
jest.mock('#/horizon/switches', () =>
  Object.defineProperty(
    {...jest.requireActual<object>('#/horizon/switches')},
    'ACT_AS_CONTROLS',
    {get: () => mockSwitch, enumerable: true},
  ),
)
let mockRestoredHidden = false
jest.mock('#/horizon/refract/visitor', () => ({
  useRestoredActionsHidden: () => mockRestoredHidden,
}))
jest.mock('#/state/queries/profile', () => ({
  useProfileQuery: () => ({data: undefined}),
}))
jest.mock('#/state/persisted', () => ({
  get: () => ({accounts: []}),
  write: () => Promise.resolve(),
}))
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => Promise.reject(new Error('no network in tests')),
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
// The design system, replaced: only the hooks are rendered here.
jest.mock('#/view/com/util/UserAvatar', () => ({UserAvatar: () => null}))
jest.mock('#/components/Toast', () => ({show: jest.fn()}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => ''}),
  }),
  web: () => ({}),
}))
jest.mock('#/components/Dialog', () => ({
  useDialogControl: () => ({open: jest.fn(), close: jest.fn()}),
}))
jest.mock('#/components/Button', () => ({
  Button: () => null,
  ButtonText: () => null,
}))
jest.mock('#/components/Menu', () => ({}))
jest.mock('#/components/Typography', () => ({Text: () => null}))
jest.mock('#/components/icons/Heart2', () => ({}))
jest.mock('#/components/icons/Person', () => ({}))
jest.mock('#/components/icons/Repost', () => ({}))
/*
 * System accounts (system accounts design 8.1, SA-20): the rows are the
 * current account's listed accounts, never the switcher's others.
 */
let mockRows: {did: string; handle?: string; addedAt: string; state: string}[] =
  []
jest.mock('#/horizon/system-accounts/hooks', () => ({
  useSystemAccountRows: () => mockRows,
}))
jest.mock('#/horizon/system-accounts/AddSystemAccountDialog', () => ({
  AddSystemAccountDialog: () => null,
}))
const mockHolds: string[] = []
const mockLoads: string[] = []
jest.mock('#/horizon/posting-as/act-as', () => ({
  ...jest.requireActual<object>('#/horizon/posting-as/act-as'),
  loadActAsPost: (did: string, post: {uri: string}) => {
    mockLoads.push(`${did} ${post.uri}`)
    return Promise.resolve()
  },
  loadActAsProfile: (did: string, subject: string) => {
    mockLoads.push(`${did} ${subject}`)
    return Promise.resolve()
  },
  holdActAsClients: (dids: string[]) => {
    mockHolds.push(...dids)
    return () => {}
  },
}))

import {useActAsPost, useActAsProfile} from '../ActAs'
import {jwt, MAIN, OTHER, STOCKY, STRANGER} from './harness'

const POST = {
  uri: `at://${STRANGER}/app.bsky.feed.post/3kpostaaaa222`,
  cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
}

function account(did: string, handle: string, signedIn = true): MockAccount {
  return {
    did,
    handle,
    refreshJwt: signedIn
      ? jwt(did, 30 * 24 * 3600, 'com.atproto.refresh')
      : undefined,
    isOauthSession: false,
  }
}

beforeEach(() => {
  mockSwitch = true
  mockRestoredHidden = false
  mockLoads.length = 0
  mockHolds.length = 0
  const main = account(MAIN, 'main.test')
  mockSession = {
    hasSession: true,
    currentAccount: main,
    accounts: [
      main,
      account(OTHER, 'other.test'),
      account(STOCKY, 'stocky.test', false),
    ],
  }
  mockRows = [
    {did: OTHER, handle: 'other.test', addedAt: '', state: 'ready'},
    {did: STRANGER, handle: 'stranger.test', addedAt: '', state: 'signIn'},
  ]
})

describe('who is offered (8.6, system accounts 8.1)', () => {
  it('the current account’s system accounts with their states, never another switcher account', () => {
    const {result} = renderHook(() => useActAsPost(POST))
    expect(result.current.available).toBe(true)
    expect(result.current.accounts).toEqual([
      {did: OTHER, handle: 'other.test', state: 'ready'},
      {did: STRANGER, handle: 'stranger.test', state: 'signIn'},
    ])
    // STOCKY is in the switcher but not listed: not offered (S-1).
    expect(result.current.accounts.map(a => a.did)).not.toContain(STOCKY)
  })

  it('opening the list reads nothing; a row’s focus or press reads that row only (SA-20)', async () => {
    jest.useFakeTimers()
    const {result} = renderHook(() => useActAsPost(POST))
    result.current.open('like')
    expect(mockLoads).toEqual([])
    expect(mockHolds).toEqual([])
    await result.current.prepare(OTHER)
    expect(mockLoads).toEqual([`${OTHER} ${POST.uri}`])
    expect(mockHolds).toEqual([OTHER])
    // A second focus shares the read and the hold.
    await result.current.prepare(OTHER)
    expect(mockLoads).toHaveLength(1)
    expect(mockHolds).toHaveLength(1)
    jest.useRealTimers()
  })

  it('follow leaves out the profile’s own account', () => {
    const {result} = renderHook(() => useActAsProfile(OTHER))
    expect(result.current.accounts.map(a => a.did)).toEqual([STRANGER])
  })

  it('absent with no system accounts, signed out, and on a visitor-form restored view', () => {
    mockRows = []
    expect(renderHook(() => useActAsPost(POST)).result.current.available).toBe(
      false,
    )
    mockRows = [{did: OTHER, handle: 'other.test', addedAt: '', state: 'ready'}]
    mockSession = {hasSession: false, currentAccount: undefined, accounts: []}
    expect(
      renderHook(() => useActAsProfile(STRANGER)).result.current.available,
    ).toBe(false)
    beforeEachReset()
    mockRestoredHidden = true
    expect(renderHook(() => useActAsPost(POST)).result.current.available).toBe(
      false,
    )
  })

  it('ACT_AS_CONTROLS off restores stock: nothing offered, nothing read', () => {
    mockSwitch = false
    const post = renderHook(() => useActAsPost(POST)).result.current
    const profile = renderHook(() => useActAsProfile(STRANGER)).result.current
    expect(post.available).toBe(false)
    expect(profile.available).toBe(false)
    post.open('like')
    profile.open('follow')
    expect(mockLoads).toEqual([])
  })
})

function beforeEachReset() {
  const main = account(MAIN, 'main.test')
  mockSession = {
    hasSession: true,
    currentAccount: main,
    accounts: [main, account(OTHER, 'other.test')],
  }
}

const src = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8')

describe('the hooks in the stock controls (PA-6 to PA-8)', () => {
  it('PA-6: a long press on like opens the list only when offered; the list sits beside the controls', () => {
    const controls = src('components/PostControls/index.tsx')
    expect(controls).toMatch(/const likeAs = useActAsPost\(post\)/)
    expect(controls).toMatch(
      /onLongPress=\{\s*likeAs\.available \? \(\) => likeAs\.open\('like'\) : undefined\s*\}/,
    )
    expect(controls).toContain('<ActAsPostDialog actAs={likeAs} post={post} />')
    // The stock like itself is unchanged.
    expect(controls).toContain(
      'onPress={() => requireAuth(() => onPressToggleLike())}',
    )
  })

  it('PA-6, PA-7: "Like as..." and "Repost as..." in the post menu, with their list outside the menu', () => {
    const menu = src('components/PostControls/PostMenu/PostMenuItems.tsx')
    expect(menu).toMatch(/const actAs = useActAsPost\(post\)/)
    expect(menu).toContain(
      '{hasSession && <ActAsPostMenuItems actAs={actAs} />}',
    )
    const outer = menu.indexOf('</Menu.Outer>')
    expect(
      menu.indexOf('<ActAsPostDialog actAs={actAs} post={post} />'),
    ).toBeGreaterThan(outer)
  })

  it('PA-8: a long press on follow and "Follow as..." in the profile menu', () => {
    const header = src('screens/Profile/Header/ProfileHeaderStandard.tsx')
    expect(header).toMatch(/const followAs = useActAsProfile\(profile\.did\)/)
    expect(header).toMatch(
      /onLongPress=\{\s*followAs\.available \? \(\) => followAs\.open\('follow'\) : undefined\s*\}/,
    )
    expect(header).toContain('<ActAsFollowDialog')
    const profileMenu = src('view/com/profile/ProfileMenu.tsx')
    expect(profileMenu).toMatch(
      /const followAs = useActAsProfile\(profile\.did\)/,
    )
    expect(profileMenu).toContain('<ActAsFollowMenuItem actAs={followAs} />')
    expect(profileMenu).toContain('<ActAsFollowDialog')
  })

  it('act-as code writes no stock shadow and uses no sdk action or client clock', () => {
    for (const file of [
      'horizon/posting-as/act-as.ts',
      'horizon/posting-as/ActAs.tsx',
    ]) {
      const text = src(file)
      expect(text).not.toMatch(/update(Post|Profile)Shadow/)
      expect(text).not.toMatch(/from '@bsky\/sdk'/)
      expect(text).not.toMatch(/tid-clock|TID\.next|nextTid/)
      expect(text).not.toMatch(/getCurrentClients|usePdsClient|useAgent/)
    }
  })
})
