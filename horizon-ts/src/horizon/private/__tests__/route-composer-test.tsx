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
import {usePrivateComposeSession} from '../composer/session'
import {getComposeVisibility, PUBLIC_COMPOSE} from '../composer/state'
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
  const {isPrivate, postingRoute} = usePrivateComposeSession(replyTo)
  canPost = privateComposeAllows(thread, isPrivate, postingRoute)
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
