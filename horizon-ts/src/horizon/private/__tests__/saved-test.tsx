import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * Private bookmarks (10.2) through the stock bookmark mutation, the private
 * list's cache and the Saved mode store (9.2).
 */
const mockAppviewCalls: string[] = []
jest.mock('#/state/session', () => ({
  useAppviewClient: () => ({
    call: (schema: {$nsid?: string; nsid?: string}) => {
      mockAppviewCalls.push(schema.$nsid ?? schema.nsid ?? 'appview')
      return Promise.resolve({})
    },
  }),
  useSession: () => ({currentAccount: {did: mockSessionDid}}),
}))
const mockShadow = jest.fn()
jest.mock('#/state/cache/post-shadow', () => ({
  updatePostShadow: (...args: unknown[]) => mockShadow(...args),
}))
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))
let mockIsMember = true
jest.mock('#/horizon/private/membership', () => ({
  useIsMember: () => mockIsMember,
}))
let mockSavedSwitch = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {PRIVATE_SAVED_SWITCH: {get: () => mockSavedSwitch, enumerable: true}},
  ),
)
let mockSessionDid = 'did:plc:privateaaaaaaaaaaaaaaaaa'
let mockDeleteRefused = false
const mockToast = jest.fn()
jest.mock('#/components/Toast', () => ({
  show: (...args: unknown[]) => mockToast(...args),
}))

import {i18n} from '@lingui/core'
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'

import {useBookmarkMutation} from '#/state/queries/bookmarks/useBookmarkMutation'
import {
  clearCurrentClients,
  publishCurrentClients,
  requireCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  loadPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {type app} from '#/lexicons'
import {
  asBookmarkedItem,
  fetchPrivateBookmarksPage,
  findPrivateBookmarkPosts,
  isPrivateBookmarkArgs,
  type PrivateBookmarksPage,
  privateBookmarksQueryKey,
  refusesPrivateBookmark,
} from '../api/bookmarks'
import {getNotificationsMode, setNotificationsMode} from '../notifications/mode'
import {
  getSavedMode,
  offersSavedSwitch,
  setSavedMode,
  showsPrivateSaved,
  usePrivateSavedMode,
} from '../saved/mode'
import {clearPrivateStores} from '../store'
import {type Call, DID, fakeClient, OTHER_DID, RECORD_CID} from './fixtures'
import {fakeAppview, privateView} from './read-fixtures'

const PRIVATE = privateView('3kprivate', {did: OTHER_DID})
const PUBLIC_URI = `at://${OTHER_DID}/app.bsky.feed.post/3kpublic`

function privatePostView(): app.bsky.feed.defs.PostView {
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri: PRIVATE.uri,
    cid: RECORD_CID,
    author: PRIVATE.author,
    record: {
      $type: 'app.bsky.feed.post',
      text: 'x',
      createdAt: PRIVATE.indexedAt,
    },
    indexedAt: PRIVATE.indexedAt,
    viewer: {},
  } as app.bsky.feed.defs.PostView
}

let prismCalls: Call[] = []
let queryClient: QueryClient

function wrapper({children}: {children: React.ReactNode}) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  i18n.loadAndActivate({locale: 'en', messages: {}})
  queryClient = new QueryClient()
  mockAppviewCalls.length = 0
  mockShadow.mockReset()
  mockIsMember = true
  mockSavedSwitch = true
  mockSessionDid = DID
  mockDeleteRefused = false
  resetPrismFeatures()
  // prism serves private bookmarks, answered in this run, unless a test says not.
  answerPrismFeatures(DID, ['private', 'private.bookmarks'])
  mockToast.mockReset()
  clearPrivateStores()
  clearCurrentClients()
  const prism = fakeClient(DID, call => {
    if (
      mockDeleteRefused &&
      call.nsid === 'app.nearhorizon.private.deleteBookmark'
    ) {
      return {
        status: 400,
        body: {error: 'InvalidRequest', message: 'not a private post'},
      }
    }
    if (call.nsid === 'app.nearhorizon.private.getBookmarks') {
      return {
        status: 200,
        body: {
          bookmarks: [
            {
              createdAt: PRIVATE.indexedAt,
              subject: {uri: PRIVATE.uri, cid: RECORD_CID},
              item: PRIVATE,
            },
          ],
          cursor: 'next',
        },
      }
    }
    return {status: 200, body: {}}
  })
  prismCalls = prism.calls
  publishCurrentClients({
    did: DID,
    handle: 'reader.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: fakeAppview().client,
    queryClient,
  })
})

describe('the bookmark mutation (Bkm 4, Bkm 5)', () => {
  it('saves and removes a private post with prism, never the AppView', async () => {
    const {result} = renderHook(() => useBookmarkMutation(), {wrapper})
    await act(async () => {
      await result.current.mutateAsync({
        action: 'create',
        post: privatePostView(),
      })
    })
    await act(async () => {
      await result.current.mutateAsync({action: 'delete', uri: PRIVATE.uri})
    })
    expect(prismCalls.map(call => call.nsid)).toEqual([
      'app.nearhorizon.private.createBookmark',
      'app.nearhorizon.private.deleteBookmark',
    ])
    expect(prismCalls[0].body).toEqual({uri: PRIVATE.uri, cid: RECORD_CID})
    expect(prismCalls[1].body).toEqual({uri: PRIVATE.uri})
    expect(mockAppviewCalls).toEqual([])
    expect(mockShadow.mock.calls.map(call => call[2])).toEqual([
      {bookmarked: true},
      {bookmarked: false},
    ])
  })

  it("deleteBookmark's InvalidRequest reaches the stock mutation's error", async () => {
    mockDeleteRefused = true
    const {result} = renderHook(() => useBookmarkMutation(), {wrapper})
    let caught: unknown
    await act(async () => {
      try {
        await result.current.mutateAsync({action: 'delete', uri: PRIVATE.uri})
      } catch (error) {
        caught = error
      }
    })
    expect((caught as {error?: string} | undefined)?.error).toBe(
      'InvalidRequest',
    )
  })

  it('a public post is stock', async () => {
    const {result} = renderHook(() => useBookmarkMutation(), {wrapper})
    await act(async () => {
      await result.current.mutateAsync({action: 'delete', uri: PUBLIC_URI})
    })
    expect(mockAppviewCalls).toEqual(['app.bsky.bookmark.deleteBookmark'])
    expect(prismCalls).toEqual([])
    expect(isPrivateBookmarkArgs({action: 'delete', uri: PUBLIC_URI})).toBe(
      false,
    )
  })

  it('a private save goes into the private list’s cache, not the stock bookmarks caches', async () => {
    const privateKey = privateBookmarksQueryKey(DID)
    queryClient.setQueryData<InfiniteData<PrivateBookmarksPage>>(privateKey, {
      pages: [{bookmarks: []}],
      pageParams: [undefined],
    })
    const stockData = {pages: [{bookmarks: []}], pageParams: [undefined]}
    queryClient.setQueryData(['bookmarks'], stockData)
    const {result} = renderHook(() => useBookmarkMutation(), {wrapper})
    await act(async () => {
      await result.current.mutateAsync({
        action: 'create',
        post: privatePostView(),
      })
    })
    const saved =
      queryClient.getQueryData<InfiniteData<PrivateBookmarksPage>>(privateKey)
    expect(saved?.pages[0].bookmarks.map(b => b.item.uri)).toEqual([
      PRIVATE.uri,
    ])
    expect(saved?.pages[0].bookmarks[0].item.viewer?.bookmarked).toBe(true)
    expect(queryClient.getQueryData(['bookmarks'])).toEqual(stockData)
    expect([
      ...findPrivateBookmarkPosts(queryClient, PRIVATE.uri),
    ]).toHaveLength(1)

    await act(async () => {
      await result.current.mutateAsync({action: 'delete', uri: PRIVATE.uri})
    })
    expect(
      queryClient.getQueryData<InfiniteData<PrivateBookmarksPage>>(privateKey)
        ?.pages[0].bookmarks,
    ).toEqual([])
  })
})

describe('the bookmark press guard (Ctl 4, Menu 8, round 2 fix 6)', () => {
  it('refuses a private post with a toast while prism stores no private bookmarks', () => {
    resetPrismFeatures()
    answerPrismFeatures(DID, ['private'])
    expect(refusesPrivateBookmark(PRIVATE.uri)).toBe(true)
    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(mockToast.mock.calls[0][0]).toBe(
      'Saving private posts isn’t available yet.',
    )
    // Refused before the mutation: no shadow update, no call anywhere
    expect(mockShadow).not.toHaveBeenCalled()
    expect(prismCalls).toEqual([])
    expect(mockAppviewCalls).toEqual([])
  })

  it('lets a public post through, with no toast', () => {
    expect(refusesPrivateBookmark(PUBLIC_URI)).toBe(false)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('lets a private post through to prism once private.bookmarks is answered in this run', () => {
    expect(refusesPrivateBookmark(PRIVATE.uri)).toBe(false)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('refuses a private post while the list is only read from the device', () => {
    resetPrismFeatures()
    loadPrismFeatures(DID, ['private', 'private.bookmarks'])
    expect(refusesPrivateBookmark(PRIVATE.uri)).toBe(true)
    expect(mockToast).toHaveBeenCalledTimes(1)
  })
})

describe('the private list (10.2)', () => {
  it('pages prism’s bookmarks, adapted and marked bookmarked', async () => {
    const page = await fetchPrivateBookmarksPage(
      {
        did: DID,
        prism: requireCurrentClients().prismClient,
        appview: fakeAppview().client,
      },
      undefined,
    )
    expect(page.cursor).toBe('next')
    expect(page.bookmarks).toHaveLength(1)
    expect(page.bookmarks[0].item.uri).toBe(PRIVATE.uri)
    expect(page.bookmarks[0].item.viewer?.bookmarked).toBe(true)
    expect(prismCalls[0].params.get('limit')).toBe('30')
  })

  it('asBookmarkedItem keeps the viewer state and sets bookmarked', () => {
    const item = asBookmarkedItem({
      ...privatePostView(),
      viewer: {like: undefined, pinned: true},
    })
    expect(item.viewer).toEqual({
      like: undefined,
      pinned: true,
      bookmarked: true,
    })
  })
})

describe('the mode stores (9, 9.2)', () => {
  it('each store is Public for any other account', () => {
    setSavedMode(DID, 'private')
    expect(getSavedMode(DID)).toBe('private')
    expect(getSavedMode(OTHER_DID)).toBe('public')
    expect(getSavedMode(undefined)).toBe('public')
  })

  it('the Saved and Notifications stores are independent', () => {
    setSavedMode(DID, 'private')
    setNotificationsMode(DID, 'public')
    expect(getSavedMode(DID)).toBe('private')
    expect(getNotificationsMode(DID)).toBe('public')
    setNotificationsMode(DID, 'private')
    setSavedMode(DID, 'public')
    expect(getNotificationsMode(DID)).toBe('private')
    expect(getSavedMode(DID)).toBe('public')
  })

  it('Private only for a member with the switch on', () => {
    expect(showsPrivateSaved({mode: 'private', isMember: true})).toBe(true)
    expect(showsPrivateSaved({mode: 'private', isMember: false})).toBe(false)
    expect(showsPrivateSaved({mode: 'public', isMember: true})).toBe(false)
    expect(offersSavedSwitch(true)).toBe(true)
    mockSavedSwitch = false
    expect(showsPrivateSaved({mode: 'private', isMember: true})).toBe(false)
    expect(offersSavedSwitch(true)).toBe(false)
  })

  it('usePrivateSavedMode follows the current account’s choice', () => {
    setSavedMode(DID, 'public')
    const {result} = renderHook(() => usePrivateSavedMode())
    expect(result.current).toBe(false)
    act(() => setSavedMode(DID, 'private'))
    expect(result.current).toBe(true)
    mockIsMember = false
    const other = renderHook(() => usePrivateSavedMode())
    expect(other.result.current).toBe(false)
  })
})
