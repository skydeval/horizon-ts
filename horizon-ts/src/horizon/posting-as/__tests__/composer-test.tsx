import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, fireEvent, render} from '@testing-library/react-native'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * The composer's "Posting as" seams (Phase 5 design 8.2, 13): a stand-in
 * composer that calls the real session hook and builds `canPost`'s term
 * exactly as Composer.tsx does (React Compiler on, as in the app), with the
 * real audience row and Public | Private control. The full composer is too
 * large to render in jest; `publish-paths-test.ts` checks its source.
 */
const mockAccounts: Record<string, unknown>[] = []
jest.mock('#/state/persisted', () => ({
  get: (key: string) =>
    key === 'session' ? {accounts: mockAccounts} : undefined,
  write: () => Promise.resolve(),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: [], currentAccount: undefined}),
  useMaybePdsClient: () => null,
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
jest.mock('#/alf', () => ({
  useBreakpoints: () => ({gtPhone: true}),
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
const mockRoot: {props?: {onChange: (value: string) => void; value: string}} =
  {}
const mockItems = new Map<string, Record<string, unknown>>()
jest.mock('#/components/forms/SegmentedControl', () => ({
  Root: (props: {
    onChange: (value: string) => void
    value: string
    children?: React.ReactNode
  }) => {
    mockRoot.props = props
    return props.children ?? null
  },
  Item: (props: {testID: string; children?: React.ReactNode}) => {
    mockItems.set(props.testID, props)
    return props.children ?? null
  },
  ItemText: () => null,
}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<{testID?: string; children?: React.ReactNode}>
  }>('react-native')
  return {
    Text: (props: {testID?: string; children?: React.ReactNode}) => (
      <Text testID={props.testID}>{props.children}</Text>
    ),
  }
})
jest.mock('#/components/Button', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<{
      testID?: string
      onPress?: () => void
      children?: React.ReactNode
    }>
  }>('react-native')
  return {
    Button: (props: {
      testID?: string
      onPress?: () => void
      children?: React.ReactNode
    }) => (
      <Text testID={props.testID} onPress={props.onPress}>
        {props.children}
      </Text>
    ),
    ButtonText: (props: {children?: React.ReactNode}) => <>{props.children}</>,
    ButtonIcon: () => null,
  }
})
jest.mock('#/components/icons/Lock', () => ({
  Lock_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/horizon/private/composer/AudienceMenu', () => ({
  AudienceMenu: () => null,
}))
jest.mock('#/horizon/private/composer/useReplyAnchor', () => ({
  useReplyAnchor: () => undefined,
}))
jest.mock('#/horizon/private/render/AudienceLabel', () => ({
  usePostAudienceLabel: () => undefined,
}))
jest.mock('#/state/queries/preferences', () => ({
  usePreferencesQuery: () => ({data: undefined}),
}))
jest.mock('#/state/queries/post-interaction-settings', () => ({
  usePostInteractionSettingsMutation: () => ({mutate: () => {}}),
}))
jest.mock('#/horizon/private/defaults/compose', () => ({
  usePrivateComposeDefaults: () => undefined,
}))
jest.mock('#/horizon/private/encoder', () => ({
  encoderAvailable: () => true,
  prewarmEncoder: () => {},
}))
const mockTemps = new Map<string, Record<string, unknown>>()
jest.mock('#/horizon/posting-as/temp-client', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '#/horizon/posting-as/temp-client',
  ),
  acquireTemporaryClient: (did: string) => mockTemps.get(did),
  peekTemporaryClient: (did: string) => mockTemps.get(did),
  releaseTemporaryClient: () => {},
}))

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'

import {
  registerOwnIdentityClient,
  resetIdentityReads,
} from '#/horizon/identity/reads'
import {privateComposeAllows} from '#/horizon/private/composer/blockers'
import {
  applyDraftVisibility,
  captureDraftVisibility,
  recordDraftVisibility,
} from '#/horizon/private/composer/drafts'
import {usePrivateComposeSession} from '#/horizon/private/composer/session'
import {
  chooseComposeVisibility,
  getComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
} from '#/horizon/private/composer/state'
import {
  ComposerAudienceProvider,
  ComposerAudienceRow,
  ComposerAudienceSlot,
} from '#/horizon/private/composer/VisibilityControl'
import {resetWriteRoutes} from '#/horizon/routing/write-route'
import {writeLocal} from '#/horizon/session/local-store'
import {
  getPostingState,
  resetPostingRecord,
  updatePosting,
} from '../compose-store'
import {choosePostingAccount} from '../gates'
import {
  audienceUri,
  type FakeAccount,
  fakeAccount,
  LOCUS_URL,
  MAIN,
  OTHER,
  publishCurrent,
  settle,
  storedAccount,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const thread = {
  posts: [
    {
      id: 'p',
      richtext: {text: 'hello'},
      labels: [],
      embed: {quote: undefined, media: undefined, link: undefined},
      shortenedGraphemeLength: 5,
    },
  ],
  postgate: {},
  threadgate: [{type: 'everybody'}],
} as never

const SWITCH_NOTE =
  'Choose an audience for @other.test. Audiences belong to the account that posts.'

let canPost: boolean | undefined
let renders = 0

/** The composer's two hook lines (PA-9), unchanged from Composer.tsx. */
function Composer() {
  renders++
  const {isPrivate, audience, postingRoute, postingAllows} =
    usePrivateComposeSession(undefined)
  canPost =
    privateComposeAllows(thread, isPrivate, postingRoute, audience) &&
    postingAllows
  return (
    <ComposerAudienceProvider
      replyTo={undefined}
      thread={thread}
      dispatch={() => {}}>
      <ComposerAudienceRow />
      <ComposerAudienceSlot />
    </ComposerAudienceProvider>
  )
}

function show() {
  return render(
    <I18nProvider i18n={i18n}>
      <Composer />
    </I18nProvider>,
  )
}

let main: FakeAccount
let other: FakeAccount

beforeEach(() => {
  resetIdentityReads()
  resetWriteRoutes()
  resetPostingRecord()
  mockItems.clear()
  mockRoot.props = undefined
  canPost = undefined
  renders = 0
  mockAccounts.length = 0
  mockAccounts.push(
    storedAccount(MAIN, LOCUS_URL, 'main.test'),
    storedAccount(OTHER, LOCUS_URL, 'other.test'),
  )
  writeLocal(`horizon:draft-visibility:${MAIN}`, undefined)
  main = fakeAccount(MAIN, {replyRules: []})
  other = fakeAccount(OTHER, {replyRules: []})
  publishCurrent(main, LOCUS_URL, 'main.test')
  mockTemps.set(OTHER, {
    did: OTHER,
    handle: 'other.test',
    pdsClient: other.client,
    appviewClient: other.client,
    chatClient: other.client,
    prismClient: other.client,
  })
  registerOwnIdentityClient(OTHER, other.client)
  setComposeVisibility(PUBLIC_COMPOSE)
})

describe('canPost takes the posting account’s values as arguments (P5R7-N1, PA-26)', () => {
  it('Private "Close friends" to Private unpicked disables Post in the same render; Post follows the hold through its store alone', async () => {
    const screen = show()
    await act(() => settle())
    act(() =>
      setComposeVisibility({
        visibility: 'private',
        audience: {kind: 'list', uri: audienceUri(MAIN)},
        locked: false,
      }),
    )
    expect(canPost).toBe(true)
    act(() => choosePostingAccount(OTHER))
    expect(getComposeVisibility().audience).toEqual({
      kind: 'unpicked',
      why: 'switch',
    })
    expect(canPost).toBe(false)
    await act(() => settle())
    expect(getPostingState().resetPending).toBe(false)
    expect(canPost).toBe(false)
    expect(screen.getByText(SWITCH_NOTE)).toBeTruthy()
    act(() =>
      chooseComposeVisibility({audience: {kind: 'mode', mode: 'followers'}}),
    )
    expect(canPost).toBe(true)
    expect(screen.queryByText(SWITCH_NOTE)).toBeNull()
    // Only the hold changes, through its store: Post follows each time.
    for (const kind of ['pending', 'none', 'failed', 'none'] as const) {
      const before = renders
      act(() => updatePosting({hold: {kind}}))
      expect(renders).toBeGreaterThan(before)
      expect(canPost).toBe(kind === 'none')
    }
    screen.unmount()
  })
})

describe('the Public | Private control is held until the reset applies (P5R5-N1)', () => {
  it('both segments are disabled and a press changes nothing while held; live once the reads land', async () => {
    let release: () => void = () => {}
    other.fail = call =>
      call.nsid === 'app.bsky.actor.getPreferences'
        ? new Promise(resolve => {
            release = () => resolve(undefined)
          })
        : undefined
    const screen = show()
    await act(() => settle())
    // Private shows the segments on any route.
    act(() =>
      setComposeVisibility({
        visibility: 'private',
        audience: {kind: 'mode', mode: 'followers'},
        locked: false,
      }),
    )
    act(() => choosePostingAccount(OTHER))
    await act(() => settle())
    expect(mockItems.get('composerVisibilityPublic')?.disabled).toBe(true)
    expect(mockItems.get('composerVisibilityPrivate')?.disabled).toBe(true)
    act(() => mockRoot.props?.onChange('public'))
    expect(getComposeVisibility().visibility).toBe('private')
    expect(canPost).toBe(false)
    release()
    await act(() => settle())
    expect(mockItems.get('composerVisibilityPublic')?.disabled).toBe(false)
    // Still Private with no audience chosen once live: Public is the way out.
    expect(canPost).toBe(false)
    act(() => mockRoot.props?.onChange('public'))
    expect(getComposeVisibility().visibility).toBe('public')
    expect(canPost).toBe(true)
    screen.unmount()
  })
})

describe('a failed read: "Couldn’t load @other’s settings." and Try again (P5R3-L1)', () => {
  it('shows the note, keeps Post off, and Try again reads again until it lands', async () => {
    other.fail = () => ({status: 500, body: {error: 'InternalServerError'}})
    const screen = show()
    await act(() => settle())
    act(() => choosePostingAccount(OTHER))
    await act(() => settle())
    // The handle is wrapped in direction isolates, as every shown handle is.
    expect(
      String(
        screen.getByTestId('composerPostingAsFailed').props.children,
      ).replace(/[‪-‮⁦-⁩]/g, ''),
    ).toBe('Couldn’t load @other.test’s settings.')
    expect(canPost).toBe(false)
    other.fail = undefined
    fireEvent.press(screen.getByTestId('composerPostingAsRetry'))
    await act(() => settle())
    expect(screen.queryByTestId('composerPostingAsFailed')).toBeNull()
    expect(getPostingState().hold.kind).toBe('none')
    expect(canPost).toBe(true)
    screen.unmount()
  })
})

describe('a draft restored from a recorded Public save (P5R8-Q1)', () => {
  it('posts Public with no pick, and flipped to Private waits for a pick with the draft’s note', async () => {
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('public-draft', captureDraftVisibility())
    const screen = show()
    await act(() => settle())
    act(() => applyDraftVisibility('public-draft'))
    expect(getComposeVisibility()).toEqual({
      visibility: 'public',
      audience: {kind: 'unpicked', why: 'draft'},
      locked: false,
    })
    expect(canPost).toBe(true)
    act(() => chooseComposeVisibility({visibility: 'private'}))
    expect(canPost).toBe(false)
    expect(screen.getByText('Choose who can see this draft.')).toBeTruthy()
    act(() =>
      chooseComposeVisibility({audience: {kind: 'mode', mode: 'nobody'}}),
    )
    expect(canPost).toBe(true)
    screen.unmount()
  })
})
