import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * The composer's Private offer by posting route (2K design 8.1, T-13), with
 * the real membership, feature and route stores; the design system is
 * replaced by stand-ins that record their props.
 */
const DID = 'did:plc:privateaaaaaaaaaaaaaaaaa'
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: DID}}),
}))
jest.mock('#/state/persisted', () => ({
  get: (key: string) => (key === 'session' ? {accounts: []} : undefined),
  write: () => Promise.resolve(),
}))
const mockLocal = new Map<string, string>()
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: (key: string) => mockLocal.get(key),
  writeLocal: (key: string, value: string | undefined) => {
    if (value === undefined) mockLocal.delete(key)
    else mockLocal.set(key, value)
  },
  subscribeLocal: () => () => {},
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
let mockEncoderAvailable = true
const mockPrewarm = jest.fn()
jest.mock('#/horizon/private/encoder', () => ({
  encoderAvailable: () => mockEncoderAvailable,
  prewarmEncoder: () => mockPrewarm(),
}))

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {
  membershipStorageKey,
  type ProbeEnvironment,
  resetMembership,
  startMembershipProbe,
} from '#/horizon/routing/membership'
import {resetWriteRoutes} from '#/horizon/routing/write-route'
import {privateComposeAllows} from '../composer/blockers'
import {applyDraftVisibility, recordDraftVisibility} from '../composer/drafts'
import {usePrivateComposeSession} from '../composer/session'
import {
  chooseComposeVisibility,
  getComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
} from '../composer/state'
import {
  ComposerAudienceProvider,
  ComposerAudienceRow,
  ComposerAudienceSlot,
} from '../composer/VisibilityControl'
import {fakeClient} from './fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

const LOCUS = 'https://pds.example'
const STOCK = 'https://pds.stock.example'
const PRIVATE_PARENT =
  'at://did:plc:otherbbbbbbbbbbbbbbbbbbbb/tools.kryphocron.feed.postPrivate/3kparent2222'
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
  threadgate: [],
} as never

const NOTE =
  'Private posting isn’t available for your account yet. Your server doesn’t have it, and Horizon can’t prepare private posts for you right now.'
const CHECKING = 'Horizon is still checking your account.'

const quietEnv: ProbeEnvironment = {
  setTimeout: () => undefined,
  clearTimeout: () => {},
  isHidden: () => false,
  onVisible: () => () => {},
}

function publish(pdsUrl: string) {
  const client = fakeClient(DID, () => ({status: 500, body: {}})).client
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl,
    pdsClient: client,
    prismClient: client,
    appviewClient: client,
  })
}

async function answerMembership(body: Record<string, unknown>) {
  const prism = fakeClient(DID, () => ({status: 200, body}))
  const cancel = startMembershipProbe(DID, prism.client, quietEnv)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  cancel()
}

let canPost: boolean | undefined

/**
 * The composer's two hook lines (Comp, PA-26): the session hook's route goes
 * into `privateComposeAllows` with a thread that never changes.
 */
function Composer({replyTo}: {replyTo?: {uri: string}}) {
  const {isPrivate, audience, postingRoute} = usePrivateComposeSession(replyTo)
  canPost = privateComposeAllows(thread, isPrivate, postingRoute, audience)
  return (
    <ComposerAudienceProvider
      replyTo={replyTo}
      thread={thread}
      dispatch={() => {}}>
      <ComposerAudienceRow />
      <ComposerAudienceSlot />
    </ComposerAudienceProvider>
  )
}

function show(replyTo?: {uri: string}) {
  return render(
    <I18nProvider i18n={i18n}>
      <Composer replyTo={replyTo} />
    </I18nProvider>,
  )
}

beforeEach(() => {
  mockLocal.clear()
  mockItems.clear()
  mockRoot.props = undefined
  canPost = undefined
  mockEncoderAvailable = true
  mockPrewarm.mockReset()
  resetMembership()
  resetPrismFeatures()
  resetWriteRoutes()
  clearCurrentClients()
})

describe('Private on posting route none (8.1)', () => {
  it('is shown but inert: a press keeps the compose Public and shows the note, every time', async () => {
    publish(STOCK)
    await answerMembership({status: 'member', features: ['private']})
    const screen = show()
    const item = mockItems.get('composerVisibilityPrivate')
    expect(item).toBeDefined()
    expect(item?.accessibilityHint).toBe(
      'Private posting isn’t available for your account yet.',
    )
    expect(screen.queryByTestId('composerPrivateRouteNote')).toBeNull()

    act(() => mockRoot.props?.onChange('private'))
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
    expect(screen.getByTestId('composerPrivateRouteNote').props.children).toBe(
      NOTE,
    )
    // Blur hides it; focus and the next press show it again.
    act(() => (item?.onBlur as () => void)())
    expect(screen.queryByTestId('composerPrivateRouteNote')).toBeNull()
    act(() =>
      (mockItems.get('composerVisibilityPrivate')?.onFocus as () => void)(),
    )
    expect(screen.getByTestId('composerPrivateRouteNote')).toBeTruthy()
    act(() =>
      (mockItems.get('composerVisibilityPrivate')?.onBlur as () => void)(),
    )
    act(() => mockRoot.props?.onChange('private'))
    expect(screen.getByTestId('composerPrivateRouteNote')).toBeTruthy()
    expect(getComposeVisibility().visibility).toBe('public')
    screen.unmount()
  })

  it('while indexing, the note says Horizon is still checking', async () => {
    publish(STOCK)
    await answerMembership({status: 'indexing', features: ['private']})
    const screen = show()
    act(() => mockRoot.props?.onChange('private'))
    expect(screen.getByTestId('composerPrivateRouteNote').props.children).toBe(
      `Private posting isn’t available for your account yet. ${CHECKING}`,
    )
    screen.unmount()
  })

  it('a non-member sees no control', async () => {
    publish(STOCK)
    await answerMembership({status: 'notEligible', features: ['private']})
    const screen = show()
    expect(mockItems.size).toBe(0)
    screen.unmount()
  })

  it('on a locus origin a confirmed member chooses Private as before', async () => {
    publish(LOCUS)
    await answerMembership({status: 'member', features: ['private']})
    const screen = show()
    expect(mockItems.get('composerVisibilityPrivate')?.accessibilityHint).toBe(
      undefined,
    )
    act(() => mockRoot.props?.onChange('private'))
    expect(getComposeVisibility().visibility).toBe('private')
    expect(screen.queryByTestId('composerPrivateRouteNote')).toBeNull()
    screen.unmount()
  })
})

describe('the route blocker (PA-26, T-13)', () => {
  it('on checking Private is not offered, and a locked reply is blocked with the checking text', () => {
    publish(STOCK)
    // Membership read from the device only.
    mockLocal.set(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private']}),
    )
    const top = show()
    expect(mockItems.size).toBe(0)
    top.unmount()

    const reply = show({uri: PRIVATE_PARENT})
    expect(getComposeVisibility().locked).toBe(true)
    expect(canPost).toBe(false)
    expect(reply.getByText(CHECKING)).toBeTruthy()
    reply.unmount()
  })

  it('with the thread unchanged, Post follows the route: checking, then none, then locus', async () => {
    publish(STOCK)
    const screen = show({uri: PRIVATE_PARENT})
    expect(canPost).toBe(false)
    expect(screen.getByText(CHECKING)).toBeTruthy()

    await act(() => answerMembership({status: 'member', features: ['private']}))
    expect(canPost).toBe(false)
    expect(screen.getByText(NOTE)).toBeTruthy()

    act(() => publish(LOCUS))
    expect(canPost).toBe(true)
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(screen.queryByText(CHECKING)).toBeNull()
    screen.unmount()
  })
})

describe('Private on posting route encode (2K-3)', () => {
  const ANY_PDS = {status: 'member', features: ['private', 'private.anyPds']}

  it('is offered as on locus, and a locked reply can be posted', async () => {
    publish(STOCK)
    await answerMembership(ANY_PDS)
    const top = show()
    expect(mockItems.get('composerVisibilityPrivate')?.accessibilityHint).toBe(
      undefined,
    )
    act(() => mockRoot.props?.onChange('private'))
    expect(getComposeVisibility().visibility).toBe('private')
    expect(top.queryByTestId('composerPrivateRouteNote')).toBeNull()
    top.unmount()

    const reply = show({uri: PRIVATE_PARENT})
    expect(canPost).toBe(true)
    expect(reply.queryByText(NOTE)).toBeNull()
    reply.unmount()
  })

  it('pre-warms the encoder once when the composer opens, whatever the segment (PA-30, T-26)', async () => {
    publish(STOCK)
    await answerMembership(ANY_PDS)
    const screen = show()
    expect(getComposeVisibility().visibility).toBe('public')
    expect(mockPrewarm).toHaveBeenCalledTimes(1)
    act(() => mockRoot.props?.onChange('private'))
    expect(mockPrewarm).toHaveBeenCalledTimes(1)
    screen.unmount()
  })

  it('a composer opened while checking pre-warms when the route becomes encode, and never on locus (K6-N11)', async () => {
    publish(STOCK)
    const screen = show()
    expect(mockPrewarm).not.toHaveBeenCalled()
    await act(() => answerMembership(ANY_PDS))
    expect(mockPrewarm).toHaveBeenCalledTimes(1)
    screen.unmount()

    mockPrewarm.mockReset()
    resetMembership()
    resetPrismFeatures()
    publish(LOCUS)
    await answerMembership(ANY_PDS)
    const locus = show()
    expect(mockPrewarm).not.toHaveBeenCalled()
    locus.unmount()
  })

  it('without an encoder the segment is inert with the no-encoder note, and nothing is pre-warmed', async () => {
    mockEncoderAvailable = false
    publish(STOCK)
    await answerMembership(ANY_PDS)
    const screen = show()
    act(() => mockRoot.props?.onChange('private'))
    expect(getComposeVisibility().visibility).toBe('public')
    expect(screen.getByTestId('composerPrivateRouteNote').props.children).toBe(
      'Private posting isn’t available for your account yet. Posting privately from your server isn’t available in this app yet.',
    )
    expect(mockPrewarm).not.toHaveBeenCalled()
    screen.unmount()
  })
})

describe('a draft restored with no visibility entry on this device (P5R7-L1)', () => {
  const UNSAVED_NOTE =
    'This draft’s visibility wasn’t saved on this device. Choose Public or who can see it.'

  async function member() {
    publish(LOCUS)
    await answerMembership({status: 'member', features: ['private']})
  }

  it('comes back Private and unpicked: Post disabled, the note shown, Public offered', async () => {
    await member()
    const screen = show()
    act(() => applyDraftVisibility('draft-from-another-device'))
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'unsaved'},
      locked: false,
    })
    expect(canPost).toBe(false)
    expect(screen.getByText(UNSAVED_NOTE)).toBeTruthy()
    expect(mockItems.get('composerVisibilityPublic')).toBeDefined()
    expect(mockRoot.props?.value).toBe('private')

    // Picking Public enables Post and drops the note.
    act(() => mockRoot.props?.onChange('public'))
    expect(canPost).toBe(true)
    expect(screen.queryByText(UNSAVED_NOTE)).toBeNull()
    screen.unmount()
  })

  it('picking an audience enables Post', async () => {
    await member()
    const screen = show()
    act(() => applyDraftVisibility('draft-from-another-device'))
    expect(canPost).toBe(false)
    act(() =>
      chooseComposeVisibility({audience: {kind: 'mode', mode: 'followers'}}),
    )
    expect(getComposeVisibility().visibility).toBe('private')
    expect(canPost).toBe(true)
    expect(screen.queryByText(UNSAVED_NOTE)).toBeNull()
    screen.unmount()
  })

  it('an unreadable table restores the same way', async () => {
    await member()
    mockLocal.set(`horizon:draft-visibility:${DID}`, '{not json')
    const screen = show()
    act(() => applyDraftVisibility('draft-1'))
    expect(canPost).toBe(false)
    expect(screen.getByText(UNSAVED_NOTE)).toBeTruthy()
    screen.unmount()
  })

  it('a draft saved Public, or Private with an audience, restores with Post enabled', async () => {
    await member()
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('public-draft')
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'nobody'},
      locked: false,
    })
    recordDraftVisibility('private-draft')
    const screen = show()
    act(() => applyDraftVisibility('public-draft'))
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
    expect(canPost).toBe(true)
    act(() => applyDraftVisibility('private-draft'))
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'nobody'},
      locked: false,
    })
    expect(canPost).toBe(true)
    expect(screen.queryByText(UNSAVED_NOTE)).toBeNull()
    screen.unmount()
  })
})
