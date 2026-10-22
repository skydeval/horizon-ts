import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {
  type InfiniteData,
  InfiniteQueryObserver,
  QueryClient,
} from '@tanstack/react-query'
import {act, render, waitFor} from '@testing-library/react-native'

import {type LoadedGroupedNotificationsPage} from '#/state/queries/notifications/grouped'

/*
 * Refreshing the Private notifications view: pressing the Private tab of the
 * Public | Private switch, and the "Refresh" pill offered by prism's unread
 * count. The cached list must stay shown while it asks again, and after a
 * failed ask.
 */

const DID = 'did:plc:privateaaaaaaaaaaaaaaaaa'

const mockEmitSoftReset = jest.fn()
jest.mock('#/state/events', () => ({
  ...jest.requireActual<object>('#/state/events'),
  emitSoftReset: () => mockEmitSoftReset(),
}))
/*
 * The folder tabs are replaced by a stand-in that hands over the press
 * handlers: these tests are about wiring, not looks.
 */
type MockTabs = {
  selected: string
  onSelect: (key: string) => void
  onReselect?: (key: string) => void
}
let mockTabs: MockTabs | undefined
jest.mock('#/horizon/private/tabs/FolderTabs', () => ({
  FolderTabs: (props: MockTabs) => {
    mockTabs = props
    return null
  },
}))
/** Presses `key` as `FolderTabs` does: re-pressing calls `onReselect`. */
function pressTab(key: string) {
  if (!mockTabs) throw new Error('no tabs rendered')
  const tabs = mockTabs
  act(() => {
    if (tabs.selected === key) tabs.onReselect?.(key)
    else tabs.onSelect(key)
  })
}
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: DID}}),
}))
jest.mock('#/horizon/private/membership', () => ({
  useIsMember: () => true,
}))
let mockMode: 'public' | 'private' = 'private'
const mockSetMode = jest.fn()
jest.mock('#/horizon/private/notifications/mode', () => ({
  offersNotificationsSwitch: () => true,
  useNotificationsMode: () => mockMode,
  setNotificationsMode: (did: string, mode: string) => mockSetMode(did, mode),
}))
let mockUnread: number | undefined = 0
jest.mock('#/horizon/private/notifications/query', () => ({
  usePrivateUnreadCount: () => mockUnread,
}))

let mockQueryClient = new QueryClient()
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual<object>('@tanstack/react-query'),
  useQueryClient: () => mockQueryClient,
}))

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'

import {NotificationsModeSwitch} from '../notifications/ModeSwitch'
import {
  isPrivateRefreshPillVisible,
  pressNotificationsModeTab,
  privateNotificationsQueryKey,
  refreshPrivateNotifications,
} from '../notifications/refresh'

i18n.loadAndActivate({locale: 'en', messages: {}})

function showSwitch() {
  return render(<NotificationsModeSwitch />, {
    wrapper: ({children}) => (
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    ),
  })
}

type Data = InfiniteData<LoadedGroupedNotificationsPage, string | undefined>

function page(label: string, requestedAt: number) {
  return {
    notifications: [{id: label}],
    cursor: `${label}-cursor`,
    requestedAt,
    newestAt: undefined,
  } as unknown as LoadedGroupedNotificationsPage
}

/**
 * A cached "All" list of two pages, whose next ask answers with
 * `answer`.
 */
async function cacheList(
  queryClient: QueryClient,
  answer: {current: () => Promise<LoadedGroupedNotificationsPage>},
) {
  const queryKey = privateNotificationsQueryKey(DID, 'all')
  let calls = 0
  // An observer, as the list has, so the query keeps no `pages` option
  const observer = new InfiniteQueryObserver<
    LoadedGroupedNotificationsPage,
    Error,
    Data,
    unknown[],
    string | undefined
  >(queryClient, {
    queryKey,
    queryFn: () => {
      calls++
      return calls <= 2
        ? Promise.resolve(page(`old-${calls}`, calls))
        : answer.current()
    },
    initialPageParam: undefined,
    getNextPageParam: last => last.cursor,
    retry: false,
  })
  await observer.refetch()
  await observer.fetchNextPage()
  return queryKey
}

beforeEach(() => {
  mockEmitSoftReset.mockClear()
  mockTabs = undefined
  mockSetMode.mockClear()
  mockMode = 'private'
  mockUnread = 0
  mockQueryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: Infinity}},
  })
})

describe('pressNotificationsModeTab', () => {
  it('re-pressing Private soft resets, without selecting', () => {
    const softReset = jest.fn()
    const select = jest.fn()
    pressNotificationsModeTab({
      queryClient: mockQueryClient,
      did: DID,
      current: 'private',
      next: 'private',
      unread: 0,
      select,
      softReset,
    })
    expect(softReset).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalled()
  })

  it('re-pressing Public does nothing', () => {
    const softReset = jest.fn()
    const select = jest.fn()
    pressNotificationsModeTab({
      queryClient: mockQueryClient,
      did: DID,
      current: 'public',
      next: 'public',
      unread: 3,
      select,
      softReset,
    })
    expect(softReset).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })

  it('switching to Private with unread asks again, keeping the cache', async () => {
    const asked: {resolve?: (value: LoadedGroupedNotificationsPage) => void} =
      {}
    const queryKey = await cacheList(mockQueryClient, {
      current: () => new Promise(r => (asked.resolve = r)),
    })
    const select = jest.fn()
    pressNotificationsModeTab({
      queryClient: mockQueryClient,
      did: DID,
      current: 'public',
      next: 'private',
      unread: 2,
      select,
      softReset: jest.fn(),
    })
    expect(select).toHaveBeenCalledWith('private')
    // Asking, with the first page still shown
    const state = mockQueryClient.getQueryState(queryKey)
    expect(state?.fetchStatus).toBe('fetching')
    expect(
      mockQueryClient.getQueryData<Data>(queryKey)?.pages.map(p => p.cursor),
    ).toEqual(['old-1-cursor'])
    await waitFor(() => expect(asked.resolve).toBeDefined())
    asked.resolve?.(page('new', 100))
    await waitFor(() =>
      expect(
        mockQueryClient.getQueryData<Data>(queryKey)?.pages[0].requestedAt,
      ).toBe(100),
    )
  })

  it('switching to Private with nothing unread leaves a fresh list as is', async () => {
    const answer = jest.fn(() => Promise.resolve(page('new', 100)))
    const queryKey = await cacheList(mockQueryClient, {current: answer})
    pressNotificationsModeTab({
      queryClient: mockQueryClient,
      did: DID,
      current: 'public',
      next: 'private',
      unread: 0,
      select: jest.fn(),
      softReset: jest.fn(),
    })
    expect(answer).not.toHaveBeenCalled()
    expect(mockQueryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
  })
})

describe('refreshPrivateNotifications', () => {
  it('keeps the cached first page when the ask fails', async () => {
    const queryKey = await cacheList(mockQueryClient, {
      current: () => Promise.reject(new Error('prism down')),
    })
    await refreshPrivateNotifications(mockQueryClient, DID, 'all')
    const data = mockQueryClient.getQueryData<Data>(queryKey)
    expect(data?.pages.map(p => p.cursor)).toEqual(['old-1-cursor'])
    expect(mockQueryClient.getQueryState(queryKey)?.status).toBe('error')
  })
})

describe('NotificationsModeSwitch', () => {
  it('re-pressing the Private tab soft resets the list', () => {
    showSwitch()
    pressTab('private')
    expect(mockEmitSoftReset).toHaveBeenCalledTimes(1)
    expect(mockSetMode).not.toHaveBeenCalled()
  })

  it('pressing Private from Public switches to it', () => {
    mockMode = 'public'
    showSwitch()
    pressTab('private')
    expect(mockSetMode).toHaveBeenCalledWith(DID, 'private')
    expect(mockEmitSoftReset).not.toHaveBeenCalled()
  })
})

describe('isPrivateRefreshPillVisible', () => {
  const top = {requestedAt: 1000}
  const unread = {count: 2, checkedAt: 2000}

  it('shows for unread checked after the first page', () => {
    expect(
      isPrivateRefreshPillVisible({
        isActive: true,
        unread,
        top,
        isFetchingTop: false,
      }),
    ).toBe(true)
  })

  it('hides with nothing unread', () => {
    expect(
      isPrivateRefreshPillVisible({
        isActive: true,
        unread: {count: 0, checkedAt: 2000},
        top,
        isFetchingTop: false,
      }),
    ).toBe(false)
  })

  it('hides when the count is older than the first page', () => {
    expect(
      isPrivateRefreshPillVisible({
        isActive: true,
        unread: {count: 2, checkedAt: 500},
        top,
        isFetchingTop: false,
      }),
    ).toBe(false)
  })

  it('hides while the first page is asked again', () => {
    expect(
      isPrivateRefreshPillVisible({
        isActive: true,
        unread,
        top,
        isFetchingTop: true,
      }),
    ).toBe(false)
  })

  it('hides out of view, before a first page, or with no count', () => {
    expect(
      isPrivateRefreshPillVisible({
        isActive: false,
        unread,
        top,
        isFetchingTop: false,
      }),
    ).toBe(false)
    expect(
      isPrivateRefreshPillVisible({
        isActive: true,
        unread,
        top: undefined,
        isFetchingTop: false,
      }),
    ).toBe(false)
    expect(
      isPrivateRefreshPillVisible({
        isActive: true,
        unread: undefined,
        top,
        isFetchingTop: false,
      }),
    ).toBe(false)
  })
})
