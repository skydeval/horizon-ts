import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The UI side of activity subscriptions: the Activity pill (T-16), the bell
 * dialog's optimistic save (T-1), the dialog's private-posts line (SQ-1),
 * and the mute list (T-19). The design system is replaced by plain
 * stand-ins.
 */

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')
jest.mock('#/components/Toast', () => ({show: () => {}}))
jest.mock('#/state/cache/profile-shadow', () => ({
  updateProfileShadow: () => {},
}))
jest.mock('#/state/queries/activity-subscriptions', () => ({
  RQKEY_getActivitySubscriptions: ['activity-subscriptions'],
}))

const mockSaversRef: {current: unknown} = {current: undefined}
jest.mock('#/horizon/private/activity-subscriptions/saver', () => ({
  ...jest.requireActual<object>(
    '#/horizon/private/activity-subscriptions/saver',
  ),
  getActivitySavers: () => mockSaversRef.current,
}))

jest.mock('#/components/forms/Toggle', () => {
  const {Text, View} = jest.requireActual<{
    Text: React.ComponentType<{children?: React.ReactNode}>
    View: React.ComponentType<{children?: React.ReactNode}>
  }>('react-native')
  return {
    Group: (props: {
      children?: React.ReactNode
      values: string[]
      disabled?: boolean
    }) => (
      <View>
        <Text>{`group:${props.values.join(',')}:${props.disabled ? 'disabled' : 'enabled'}`}</Text>
        {props.children}
      </View>
    ),
    Item: (props: {children?: React.ReactNode}) => <View>{props.children}</View>,
    LabelText: (props: {children?: React.ReactNode}) => (
      <Text>{props.children}</Text>
    ),
    Switch: () => null,
  }
})

const mockAppview: {client: unknown} = {client: undefined}
jest.mock('#/state/session', () => ({
  useSession: () => ({
    currentAccount: {did: 'did:plc:memberaaaaaaaaaaaaaaaaaaa'},
  }),
  useAppviewClient: () => mockAppview.client,
}))
const mockClose: (() => void)[] = []
jest.mock('#/components/Dialog', () => ({
  useDialogContext: () => ({
    close: (callback?: () => void) => {
      mockClose.push(callback ?? (() => {}))
    },
  }),
}))
const mockMetric = jest.fn()
jest.mock('#/analytics', () => ({
  useAnalytics: () => ({metric: mockMetric}),
}))

let mockIsMember = true
let mockSource: unknown
jest.mock('#/horizon/private/membership', () => ({
  useIsMember: () => mockIsMember,
  usePrivateFeedSource: () => mockSource,
}))
let mockActivity = false
jest.mock('#/horizon/private/activity-subscriptions/hooks', () => ({
  useActivitySubscriptionsShown: () => mockActivity,
}))
let mockFeatures = new Set<string>(['private.notifications'])
jest.mock('#/horizon/private/features-hooks', () => ({
  usePrismFeature: (feature: string) => mockFeatures.has(feature),
}))

const mockPills: {
  tabs: {key: string; label: string}[]
  selectedTab: string
  onSelectTab: (key: string) => void
  progress: {get: () => number}
}[] = []
jest.mock('#/screens/Notifications/components/TabPills', () => ({
  TabPills: (props: {
    tabs: {key: string; label: string}[]
    selectedTab: string
    onSelectTab: (key: string) => void
    dragProgress: {get: () => number}
  }) => {
    mockPills.push({...props, progress: props.dragProgress})
    return null
  },
}))
jest.mock('#/horizon/private/notifications/PrivateNotificationsList', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<{children?: React.ReactNode}>
  }>('react-native')
  return {
    PrivateNotificationsList: (props: {tab: string}) => (
      <Text>{`list:${props.tab}`}</Text>
    ),
  }
})
const mockPrefetch = jest.fn()
jest.mock('#/horizon/private/notifications/query', () => ({
  usePrefetchPrivateNotifications: (tab: string, enabled: boolean) =>
    mockPrefetch(tab, enabled),
}))
const mockSoftReset = jest.fn()
jest.mock('#/state/events', () => ({
  emitSoftReset: () => mockSoftReset(),
}))
jest.mock('#/lib/hooks/useBottomBarOffset', () => ({
  useBottomBarOffset: () => 0,
}))
jest.mock('react-native-reanimated', () => {
  const React = jest.requireActual<{
    useRef: <T>(initial: T) => {current: T}
  }>('react')
  return {
    useSharedValue: (initial: number) => {
      const ref = React.useRef<{
        value: number
        get: () => number
        set: (v: number) => void
      } | null>(null)
      if (!ref.current) {
        const shared = {
          value: initial,
          get: () => shared.value,
          set: (v: number) => {
            shared.value = v
          },
        }
        ref.current = shared
      }
      return ref.current
    },
  }
})
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  web: () => ({}),
  platform: () => ({}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<{children?: React.ReactNode}>
  }>('react-native')
  return {
    Text: (props: {children?: React.ReactNode}) => <Text>{props.children}</Text>,
  }
})
jest.mock('#/components/Layout', () => {
  const {View} = jest.requireActual<{
    View: React.ComponentType<{children?: React.ReactNode}>
  }>('react-native')
  return {
    Center: (props: {children?: React.ReactNode}) => (
      <View>{props.children}</View>
    ),
  }
})

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, render, renderHook} from '@testing-library/react-native'

import {findAllProfilesInQueryData} from '#/state/queries/my-muted-accounts'
import {fakeClient} from '../../__tests__/fixtures'
import {PrivateNotificationsContent} from '../../notifications/PrivateNotificationsContent'
import {OFF} from '../common'
import {
  nextPair,
  PrivateActivityToggles,
  useActivitySubscriptionSave,
} from '../dialog'
import {countUnmuted, withoutMutedAuthors} from '../mute-filter'
import {fetchMutedDids, mutedDidsQueryKey, useMutedDids} from '../muted'
import {
  privateActivitySubscriptionsKey,
  usePrivateBellOn,
} from '../private-state'
import {readBellTruth} from '../ui'
import {BOTH, DID, harness, ON, settle, SUBJECT, xrpcError} from './harness'

const LIST = privateActivitySubscriptionsKey(DID)

/** prism's list lands in the cache. */
async function setList(queryClient: QueryClient, data: unknown) {
  await act(async () => {
    queryClient.setQueryData(LIST, data)
    // TanStack notifies its observers on a timer.
    await new Promise(resolve => setTimeout(resolve, 5))
    await settle(2)
  })
}

i18n.loadAndActivate({locale: 'en', messages: {}})

function show(ui: React.ReactElement, queryClient = new QueryClient()) {
  return render(ui, {
    wrapper: ({children}) => (
      <QueryClientProvider client={queryClient}>
        <I18nProvider i18n={i18n}>{children}</I18nProvider>
      </QueryClientProvider>
    ),
  })
}

function withClient(queryClient: QueryClient) {
  return function Wrapper({children}: {children: React.ReactNode}) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  }
}

beforeEach(() => {
  mockPills.length = 0
  mockPrefetch.mockClear()
  mockSoftReset.mockClear()
  mockMetric.mockClear()
  mockClose.length = 0
  mockActivity = false
  mockIsMember = true
  mockSource = undefined
  mockFeatures = new Set(['private.notifications'])
})

describe('T-16: the Activity pill', () => {
  const last = () => mockPills[mockPills.length - 1]

  it('is absent without the feature', () => {
    const screen = show(<PrivateNotificationsContent headerOffset={0} />)
    expect(last().tabs.map(tab => tab.key)).toEqual(['all', 'replies'])
    expect(mockPrefetch).toHaveBeenLastCalledWith('activity', false)
    expect(screen.getByText('list:all')).toBeTruthy()
  })

  it('with it: three pills, a 0/1/2 mapping, the soft reset, and a prefetch', () => {
    mockActivity = true
    const screen = show(<PrivateNotificationsContent headerOffset={0} />)
    expect(last().tabs.map(tab => tab.key)).toEqual([
      'all',
      'replies',
      'activity',
    ])
    expect(mockPrefetch).toHaveBeenLastCalledWith('activity', true)
    act(() => last().onSelectTab('activity'))
    expect(last().selectedTab).toBe('activity')
    expect(last().progress.get()).toBe(2)
    expect(screen.getByText('list:activity')).toBeTruthy()
    act(() => last().onSelectTab('replies'))
    expect(last().progress.get()).toBe(1)
    act(() => last().onSelectTab('replies'))
    expect(mockSoftReset).toHaveBeenCalledTimes(1)
    act(() => last().onSelectTab('all'))
    expect(last().progress.get()).toBe(0)
  })

  it('falls back to All when the feature goes while Activity is selected', () => {
    mockActivity = true
    const screen = show(<PrivateNotificationsContent headerOffset={0} />)
    act(() => last().onSelectTab('activity'))
    mockActivity = false
    screen.rerender(<PrivateNotificationsContent headerOffset={0} />)
    expect(last().selectedTab).toBe('all')
    expect(last().progress.get()).toBe(0)
    expect(screen.getByText('list:all')).toBeTruthy()
  })
})

describe('T-1: the optimistic save (hook Dlg 1)', () => {
  it('closes with no request; writes the bell in the close; toasts only after Bluesky accepts', async () => {
    const h = harness()
    mockSaversRef.current = h.savers
    mockAppview.client = h.bluesky.client
    h.bluesky.state.putReply = 'hang'
    const profile = {did: SUBJECT, handle: 'subject.test'}
    const {result} = renderHook(
      () => useActivitySubscriptionSave(profile as never, OFF),
      {wrapper: withClient(h.queryClient)},
    )
    act(() => result.current.press(ON))
    // The dialog is closing; nothing is written or sent yet.
    expect(mockClose).toHaveLength(1)
    expect(readBellTruth(h.queryClient, SUBJECT)).toEqual(OFF)
    await settle()
    expect(h.bluesky.calls).toEqual([])
    // The close ends: the bell and the list are written, then the put goes.
    act(() => mockClose[0]())
    expect(readBellTruth(h.queryClient, SUBJECT)).toEqual(ON)
    expect(mockMetric).toHaveBeenCalledWith('activitySubscription:enable', {
      setting: 'posts',
    })
    await settle()
    expect(h.bluesky.puts()).toEqual([ON])
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
    h.bluesky.held[0].resolve({status: 200, body: {}})
    await settle()
    expect(h.toasts.savedToast).toHaveBeenCalledWith('subject.test', ON, OFF)
    expect(h.savers.bluesky.status(DID, SUBJECT)?.idle).toBe(true)
  })
})

describe('T7-1: the four-toggle dialog (hooks Dlg 1 and Dlg 2)', () => {
  const profile = {did: SUBJECT, handle: 'subject.test'} as never

  function setup() {
    const h = harness()
    mockSaversRef.current = h.savers
    mockAppview.client = h.bluesky.client
    mockSource = {did: DID, prism: h.prism.client, appview: h.bluesky.client}
    mockActivity = true
    return h
  }

  function Toggles() {
    const save = useActivitySubscriptionSave(profile, OFF)
    return <PrivateActivityToggles save={save} />
  }

  it('shows the private pair for a member with the feature, and not otherwise', () => {
    const h = setup()
    h.queryClient.setQueryData(LIST, {})
    expect(show(<Toggles />, h.queryClient).queryByText('Private posts')).toBeTruthy()
    expect(show(<Toggles />, h.queryClient).queryByText('Private replies')).toBeTruthy()
    mockActivity = false
    expect(show(<Toggles />, h.queryClient).queryByText('Private posts')).toBeNull()
    mockActivity = true
    mockIsMember = false
    expect(show(<Toggles />, h.queryClient).queryByText('Private posts')).toBeNull()
  })

  it('is disabled until prism’s list loads, seeded once, and a later fetch changes neither the state nor the seed', async () => {
    const h = setup()
    h.prism.state.listReply = xrpcError(500, 'InternalServerError')
    const screen = show(<Toggles />, h.queryClient)
    await act(() => settle())
    expect(screen.getByText('group::disabled')).toBeTruthy()
    const {result} = renderHook(
      () => useActivitySubscriptionSave(profile, OFF),
      {wrapper: withClient(h.queryClient)},
    )
    expect(result.current.privateReady).toBe(false)
    await setList(h.queryClient, {[SUBJECT]: ON})
    expect(result.current.privateReady).toBe(true)
    expect(result.current.privateState).toEqual(ON)
    expect(result.current.privateInitial).toEqual(ON)
    expect(screen.getByText('group:post:enabled')).toBeTruthy()
    await setList(h.queryClient, {[SUBJECT]: BOTH})
    expect(result.current.privateState).toEqual(ON)
    expect(result.current.privateInitial).toEqual(ON)
    expect(result.current.privateDirty).toBe(false)
  })

  it('keeps reply-needs-post, and Save is dirty when the private pair changed', () => {
    expect(nextPair(OFF, ['reply'])).toEqual(BOTH)
    expect(nextPair(BOTH, ['reply'])).toEqual(OFF)
    expect(nextPair(OFF, ['post'])).toEqual(ON)
    const h = setup()
    h.queryClient.setQueryData(LIST, {})
    const {result} = renderHook(
      () => useActivitySubscriptionSave(profile, OFF),
      {wrapper: withClient(h.queryClient)},
    )
    expect(result.current.privateDirty).toBe(false)
    act(() => result.current.setPrivate(['reply']))
    expect(result.current.privateState).toEqual(BOTH)
    expect(result.current.privateDirty).toBe(true)
    expect(result.current.privateHasAny).toBe(true)
  })

  it('a private-only Save closes with no request and sends only to prism', async () => {
    const h = setup()
    h.queryClient.setQueryData(LIST, {})
    const {result} = renderHook(
      () => useActivitySubscriptionSave(profile, OFF),
      {wrapper: withClient(h.queryClient)},
    )
    act(() => result.current.setPrivate(['post']))
    act(() => result.current.press(OFF, result.current.privateState))
    await settle()
    expect(h.prism.calls).toEqual([])
    act(() => mockClose[0]())
    expect(h.queryClient.getQueryData(LIST)).toEqual({[SUBJECT]: ON})
    await settle()
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
    expect(h.bluesky.calls).toEqual([])
    // No public change: no stock metric.
    expect(mockMetric).not.toHaveBeenCalled()
    expect(h.toasts.savedToast).toHaveBeenCalledWith('subject.test', ON, OFF)
  })
})

describe('T7-7: the bell icon (hook Btn 1)', () => {
  it('a private toggle alone lights it; all off, or not loaded, leaves it unlit', async () => {
    const h = harness()
    mockSaversRef.current = h.savers
    mockSource = {did: DID, prism: h.prism.client, appview: h.bluesky.client}
    mockActivity = true
    h.prism.state.listReply = xrpcError(500, 'InternalServerError')
    const {result} = renderHook(() => usePrivateBellOn(SUBJECT), {
      wrapper: withClient(h.queryClient),
    })
    expect(result.current).toBe(false)
    await setList(h.queryClient, {[SUBJECT]: ON})
    expect(result.current).toBe(true)
    await setList(h.queryClient, {[SUBJECT]: {post: false, reply: true}})
    expect(result.current).toBe(true)
    await setList(h.queryClient, {})
    expect(result.current).toBe(false)
  })
})

describe('T-19: mutes', () => {
  const MUTED = 'did:plc:mutedaaaaaaaaaaaaaaaaaaaa'
  const OTHER = 'did:plc:otherbbbbbbbbbbbbbbbbbbbb'
  const post = (author: string) =>
    ({uri: `at://${author}/app.bsky.feed.post/3k`, author: {did: author}}) as never

  it('drops muted authors’ subscribed-post items and private replies from the count and the list', () => {
    const muted = new Set([MUTED])
    expect(
      countUnmuted(
        [{author: MUTED}, {author: OTHER}, {author: MUTED}, {author: OTHER}],
        muted,
        30,
      ),
    ).toBe(2)
    const group = {
      type: 'subscribedPost',
      id: 'g',
      isRead: false,
      indexedAt: '',
      count: 2,
      items: [
        {actor: {did: MUTED}, post: post(MUTED)},
        {actor: {did: OTHER}, post: post(OTHER)},
      ],
    } as never
    const kept = withoutMutedAuthors(group, muted) as {items: unknown[]}
    expect(kept.items).toHaveLength(1)
    const reply = {
      type: 'reply',
      id: 'r',
      isRead: false,
      indexedAt: '',
      count: 1,
      post: post(MUTED),
      parent: {type: 'notFound'},
    } as never
    // Even when the author merge failed, the DID alone is enough.
    expect(withoutMutedAuthors(reply, muted)).toBeUndefined()
    expect(withoutMutedAuthors(reply, new Set())).toBe(reply)
  })

  it('reads getMutes in pages of 100, leaving out a repost-only mute', async () => {
    const {client, calls} = fakeClient(DID, call => {
      const cursor = call.params.get('cursor')
      return {
        status: 200,
        body: cursor
          ? {mutes: [{did: OTHER, handle: 'other.test', viewer: {muted: true}}]}
          : {
              cursor: 'p2',
              mutes: [
                {did: MUTED, handle: 'muted.test', viewer: {muted: true}},
                {
                  did: 'did:plc:repostsonlyccccccccccccc',
                  handle: 'reposts.test',
                  viewer: {muted: false, mutedOnlyReposts: true},
                },
              ],
            },
      }
    })
    expect(await fetchMutedDids(client)).toEqual([MUTED, OTHER])
    expect(calls[0].params.get('limit')).toBe('100')
  })

  it('is cached under the stock root: a mute invalidation re-reads it, and the shadow walk passes over it', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(mutedDidsQueryKey(DID), [MUTED])
    await queryClient.invalidateQueries({queryKey: ['my-muted-accounts']})
    expect(
      queryClient.getQueryState(mutedDidsQueryKey(DID))?.isInvalidated,
    ).toBe(true)
    expect(Array.from(findAllProfilesInQueryData(queryClient, MUTED))).toEqual(
      [],
    )
  })

  it('counts as empty until it loads, and is not read without the feature', async () => {
    const asked = jest.fn()
    mockSource = {
      did: DID,
      appview: {
        call: () => {
          asked()
          return new Promise(() => {})
        },
      },
    }
    mockActivity = true
    const queryClient = new QueryClient()
    const {result} = renderHook(() => useMutedDids(), {
      wrapper: ({children}) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })
    expect(result.current.size).toBe(0)
    await settle()
    expect(asked).toHaveBeenCalledTimes(1)

    asked.mockClear()
    mockActivity = false
    const off = renderHook(() => useMutedDids(), {
      wrapper: ({children}) => (
        <QueryClientProvider client={new QueryClient()}>
          {children}
        </QueryClientProvider>
      ),
    })
    expect(off.result.current.size).toBe(0)
    await settle()
    expect(asked).not.toHaveBeenCalled()
  })
})
