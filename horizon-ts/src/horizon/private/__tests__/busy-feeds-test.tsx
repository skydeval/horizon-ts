import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  ...jest.requireActual<object>('#/horizon/routing/membership'),
  useMembership: () => mockMembership,
}))
// The note's look, without the native design system.
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Typography', () => {
  const {Text} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {Text}
})
jest.mock('#/components/icons/Clock', () => ({
  Clock_Stroke2_Corner0_Rounded: () => null,
}))

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from '@tanstack/react-query'
import {act, render, renderHook, screen} from '@testing-library/react-native'

/*
 * T-8 (prism busy design 6.4, 6.5), the list cases of T-13 and T-10 (4.1,
 * 6.7): degraded pages, the carry of the reader's own posts, the gate on
 * feed rows, notification groups and the actor lists, Following's lift with
 * `refreshPending`, the pill's `stale` input and the note in the header slot.
 */
import {type FeedAPI} from '#/lib/api/feed/types'
import {
  likesListAccess,
  stampListPage,
} from '#/horizon/private/api/interactions'
import {
  gateSlicedPages,
  hiddenInFeedPages,
  privateUrisIn,
} from '#/horizon/private/feed/busy'
import {useFollowingBusy} from '#/horizon/private/feed/busy-view'
import {carryOwnPrivateItems} from '#/horizon/private/feed/carry'
import {
  anyPageDegraded,
  degradedFlags,
  degradedStaleTime,
  isTopPageDegraded,
} from '#/horizon/private/feed/degraded'
import {PrivateLikesMergeFeedAPI} from '#/horizon/private/feed/likes-merge'
import {withPrivateTimeline} from '#/horizon/private/feed/timeline-merge'
import {isSyncing, resetKnown} from '#/horizon/private/known'
import {
  PrivateListBusyError,
  useBusyListQuery,
} from '#/horizon/private/list-busy'
import {gateNotificationPages} from '#/horizon/private/notifications/busy'
import {isPrivateRefreshPillVisible} from '#/horizon/private/notifications/refresh'
import {CatchingUpNote} from '#/horizon/private/status/CatchingUpNote'
import {clearPrivateStores} from '#/horizon/private/store'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  reportProbeStatus,
  reportReadOutcome,
  resetPrismHealth,
} from '#/horizon/routing/health'
import {type app} from '#/lexicons'
import {DID, OTHER_DID, privateUri} from './fixtures'
import {fakeAppview, fakePrism, privateView, publicItem} from './read-fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

const OWN = privateUri('3kown2222222')
const OTHER = privateUri('3kother22222', OTHER_DID)

let now = 1_000_000
let seq = 0
let qc: QueryClient

function minute(m: number) {
  return new Date(Date.UTC(2026, 9, 15, 10, 0, 0) + m * 60_000).toISOString()
}

/** A feed row of the post at `uri`, at minute `m`. */
function row(uri: string, m: number, extra: Partial<FeedViewPost> = {}) {
  const did = uri.split('/')[2]
  return {
    post: {
      uri,
      cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
      author: {did, handle: 'a.test'},
      record: {text: uri, createdAt: minute(m)},
      indexedAt: minute(m),
    },
    ...extra,
  } as unknown as FeedViewPost
}

function publicRow(id: string, m: number) {
  return row(`at://${OTHER_DID}/app.bsky.feed.post/${id}`, m)
}

function answered() {
  reportReadOutcome(DID, {
    kind: 'answered',
    method: 'app.nearhorizon.private.getTimeline',
    seq: ++seq,
    read: true,
    degraded: false,
    retryAfterMs: undefined,
  })
}

function unconfirm() {
  reportProbeStatus(DID, 'reindexing')
}

function confirm() {
  reportProbeStatus(DID, 'member')
  answered()
}

function wrapper({children}: {children: React.ReactNode}) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nProvider>
  )
}

beforeEach(() => {
  now = 1_000_000
  seq = 0
  mockMembership = 'member'
  resetPrismHealth({now: () => now})
  resetKnown()
  clearPrivateStores()
  qc = new QueryClient({defaultOptions: {queries: {retry: false}}})
  publishCurrentClients({
    did: DID,
    queryClient: qc,
  } as unknown as CurrentClients)
})

afterEach(() => {
  qc.clear()
  clearCurrentClients()
})

const ANSWER = {
  did: DID,
  method: 'app.nearhorizon.private.getTimeline',
  seq: 7,
  degraded: false,
  retryAfterMs: undefined,
  unavailable: [],
}

describe('degraded pages (6.4, 6.5)', () => {
  it('marks a page from a degraded answer, an own miss listed, or a failed refill', () => {
    expect(degradedFlags([ANSWER], false)).toEqual({})
    expect(degradedFlags([{...ANSWER, degraded: true}], false)).toMatchObject({
      privateDegraded: true,
      privateAnswer: {did: DID, seq: 7, unavailable: []},
    })
    expect(
      degradedFlags(
        [
          ANSWER,
          {...ANSWER, seq: 9, unavailable: [{uri: OWN, reason: 'x'} as never]},
        ],
        false,
      ),
    ).toMatchObject({
      privateDegraded: true,
      privateAnswer: {unavailable: [OWN]},
    })
    // Two refills, one degraded: the page is degraded.
    expect(
      degradedFlags([ANSWER, {...ANSWER, degraded: true}], false)
        .privateDegraded,
    ).toBe(true)
    expect(degradedFlags([], true)).toEqual({privateDegraded: true})
  })

  it('reads the topmost page by position with no `since`, never a page below', () => {
    const clean = {since: undefined}
    const degraded = {since: undefined, privateDegraded: true}
    const prepend = {since: 'x'}
    // A degraded first page under a public prepend (native).
    expect(isTopPageDegraded([prepend, degraded, clean])).toBe(true)
    // A degraded gap fill that is the topmost page with no `since`.
    expect(isTopPageDegraded([prepend, degraded])).toBe(true)
    // A degraded `fetchNextPage` page below a clean first page.
    expect(isTopPageDegraded([clean, degraded])).toBe(false)
    expect(isTopPageDegraded(undefined)).toBe(false)
  })

  it('is stale at once while a page is degraded', () => {
    const stale = degradedStaleTime(15_000)
    expect(stale({state: {data: {pages: [{}, {privateDegraded: true}]}}})).toBe(
      0,
    )
    expect(stale({state: {data: {pages: [{}]}}})).toBe(15_000)
    expect(anyPageDegraded(undefined)).toBe(false)
  })

  it('the Following merge marks a degraded answer, a failed read and a listed own miss', async () => {
    const stock: FeedAPI = {
      peekLatest: () => Promise.resolve(undefined as never),
      fetch: () =>
        Promise.resolve({
          feed: [publicItem('p1', 1)] as unknown as FeedViewPost[],
          cursor: undefined,
        }),
    }
    const fetchWith = async (body: unknown) => {
      const prism = fakePrism({
        handler: nsid =>
          nsid === 'app.nearhorizon.private.getTimeline'
            ? body instanceof Error
              ? {status: 500, body: {error: 'InternalServerError'}}
              : {status: 200, body}
            : undefined,
      })
      const api = withPrivateTimeline(
        'following',
        {did: DID, prism: prism.client, appview: fakeAppview().client},
        stock,
      )
      return (await api.fetch({cursor: undefined, limit: 30})) as {
        privateDegraded?: true
        privateAnswer?: {unavailable: string[]}
      }
    }
    expect((await fetchWith({feed: []})).privateDegraded).toBeUndefined()
    expect(
      (await fetchWith({feed: [], degraded: true, retryAfter: 30}))
        .privateDegraded,
    ).toBe(true)
    expect((await fetchWith(new Error('fail'))).privateDegraded).toBe(true)
    const listed = await fetchWith({
      feed: [],
      unavailable: [{uri: OWN, reason: 'syncing'}],
    })
    expect(listed.privateDegraded).toBe(true)
    expect(listed.privateAnswer?.unavailable).toEqual([OWN])
  })

  it('the likes merge drops a liked post prism left out and marks the page when it is a suspect', async () => {
    const liked = privateView('3kliked22222', {did: OTHER_DID})
    const stock: FeedAPI = {
      peekLatest: () => Promise.resolve(undefined as never),
      fetch: () => Promise.resolve({feed: [], cursor: undefined}),
    }
    const pageWith = async (body: unknown) => {
      const prism = fakePrism({
        handler: nsid =>
          nsid === 'app.nearhorizon.private.getPosts'
            ? {status: 200, body}
            : undefined,
      })
      const api = new PrivateLikesMergeFeedAPI(
        stock,
        {did: DID, prism: prism.client, appview: fakeAppview().client},
        () =>
          Promise.resolve({
            records: [
              {
                uri: `at://${DID}/app.bsky.feed.like/3klike222222`,
                value: {subject: {uri: liked.uri, cid: liked.cid}},
              },
            ],
          }),
      )
      return (await api.fetch({cursor: undefined, limit: 30})) as {
        feed: unknown[]
        privateDegraded?: true
      }
    }
    // Left out of a healthy answer: dropped, not a suspect.
    const healthy = await pageWith({posts: []})
    expect(healthy.feed).toHaveLength(0)
    expect(healthy.privateDegraded).toBeUndefined()
    // Left out of a degraded answer: a suspect, and the page is degraded.
    const degraded = await pageWith({posts: [], degraded: true, retryAfter: 30})
    expect(degraded.feed).toHaveLength(0)
    expect(degraded.privateDegraded).toBe(true)
  })
})

describe('carryOwnPrivateItems (6.4)', () => {
  it('carries the reader own private rows in the span, tagged and labelled; never another author', () => {
    const previous = [
      {
        fetchedAt: 100,
        feed: [
          publicRow('p9', 9),
          row(OWN, 5),
          row(OTHER, 6),
          publicRow('p4', 4),
        ],
      },
    ]
    const page = {
      feed: [publicRow('p10', 10), publicRow('p2', 2)],
      cursor: 'next',
    }
    const out = carryOwnPrivateItems(previous, page, {
      did: DID,
      top: true,
      answer: {did: DID, seq: 3, unavailable: [OWN]},
    })
    expect(out.feed.map(item => item.post.uri)).toEqual([
      page.feed[0].post.uri,
      OWN,
      page.feed[1].post.uri,
    ])
    expect(
      (out.feed[1].post as {horizonFromCache?: number}).horizonFromCache,
    ).toBe(100)
    // A suspect of the new answer: "Syncing".
    expect(isSyncing(DID, OWN)).toBe(true)
  })

  it('leaves out rows outside the span, already on the page, or with nothing to carry', () => {
    const previous = [{fetchedAt: 100, feed: [row(OWN, 1)]}]
    // Older than the page's oldest row, and the page has a cursor.
    const page = {feed: [publicRow('p5', 5)], cursor: 'next'}
    expect(carryOwnPrivateItems(previous, page, {did: DID, top: true})).toBe(
      page,
    )
    // No cursor: the span reaches the end.
    const last = {feed: [publicRow('p5', 5)], cursor: undefined}
    expect(
      carryOwnPrivateItems(previous, last, {did: DID, top: true}).feed,
    ).toHaveLength(2)
    // Already on the page.
    const has = {feed: [row(OWN, 1)], cursor: undefined}
    expect(carryOwnPrivateItems(previous, has, {did: DID, top: true})).toBe(has)
  })

  it('a fill with no answer carries every private row with its source stamp (item 7)', () => {
    const previous = [{fetchedAt: 50, feed: [row(OTHER, 4), row(OWN, 3)]}]
    const page = {feed: [publicRow('p6', 6), publicRow('p1', 1)], cursor: 'c'}
    const out = carryOwnPrivateItems(previous, page, {did: DID, include: 'all'})
    expect(out.feed.map(item => item.post.uri)).toContain(OTHER)
    const other = out.feed.find(item => item.post.uri === OTHER)
    expect((other?.post as {horizonFromCache?: number}).horizonFromCache).toBe(
      50,
    )
  })

  it('tags a carried own reply’s parent too, so it never counts as fetched with the new page', () => {
    const parent = row(OTHER, 2).post
    const reply = row(OWN, 3, {
      reply: {
        parent: {...parent, $type: 'app.bsky.feed.defs#postView'},
        root: {...parent, $type: 'app.bsky.feed.defs#postView'},
      },
    })
    const out = carryOwnPrivateItems(
      [{fetchedAt: 10, feed: [reply]}],
      {feed: [publicRow('p9', 9)], cursor: undefined},
      {did: DID, top: true},
    )
    const carried = out.feed.find(item => item.post.uri === OWN)
    // The row is gated by its parent's old stamp on a load begun at 20.
    expect(
      hiddenInFeedPages([{fetchedAt: 30, feed: [carried!]}], DID, 20),
    ).toBe(1)
  })
})

describe('the gate on feed rows (4.1)', () => {
  it('hides another author’s private row from a page fetched before the load, never the reader’s own', () => {
    const pages = [
      {fetchedAt: 90, feed: [row(OTHER, 3), row(OWN, 2), publicRow('p1', 1)]},
      {fetchedAt: 110, feed: [row(privateUri('3kother33333', OTHER_DID), 0)]},
    ]
    expect(hiddenInFeedPages(pages, DID, 100)).toBe(1)
    expect(hiddenInFeedPages(pages, DID, undefined)).toBe(0)
    // A carried row is judged by its own stamp.
    const carried = row(OTHER, 4)
    ;(carried.post as {horizonFromCache?: number}).horizonFromCache = 80
    expect(
      hiddenInFeedPages([{fetchedAt: 120, feed: [carried]}], DID, 100),
    ).toBe(1)
  })

  it('gates selected slices, returning untouched pages as they are', () => {
    const slice = (uri: string) => ({items: [{post: {uri}}]})
    const kept = {fetchedAt: 150, slices: [slice(OTHER)]}
    const old = {fetchedAt: 50, slices: [slice(OTHER), slice(OWN)]}
    const gated = gateSlicedPages([kept, old], DID, 100)
    expect(gated.hidden).toBe(1)
    expect(gated.pages[0]).toBe(kept)
    expect(gated.pages[1].slices).toEqual([slice(OWN)])
  })

  it('stamps every private URI a page holds, quotes included', () => {
    const quoted = privateUri('3kquoted2222', OTHER_DID)
    const item = row(OWN, 1, {
      post: {
        ...row(OWN, 1).post,
        embed: {record: {uri: quoted}},
      } as unknown as FeedViewPost['post'],
    })
    expect(privateUrisIn([{feed: [item], api: {x: OTHER}}]).sort()).toEqual(
      [OWN, quoted].sort(),
    )
  })
})

describe('Following’s load gate and lift (6.5, 4.1)', () => {
  const KEY = ['post-feed', 'v2|following', {}, {horizonPrivate: DID}]

  function seed(fetchedAt: number) {
    qc.setQueryData(KEY, {
      pages: [{feed: [row(OTHER, 2)], fetchedAt}],
      pageParams: [undefined],
    })
  }

  function selected(fetchedAt: number) {
    return {
      pages: [{fetchedAt, slices: [{items: [{post: {uri: OTHER}}]}]}],
      pageParams: [undefined],
    }
  }

  it('a gated mount hides another author’s rows, refreshes from the top, and lifts at the top once confirmed', () => {
    seed(now - 10)
    unconfirm()
    const refreshToTop = jest.fn(() => Promise.resolve())
    const onHasNew = jest.fn()
    const hook = renderHook(
      () =>
        useFollowingBusy({
          enabled: true,
          queryKey: KEY,
          data: selected(now - 10),
          isScrolledDown: () => false,
          refreshToTop,
          onHasNew,
          Header: undefined,
        }),
      {wrapper},
    )
    expect(hook.result.current.hidden).toBe(1)
    expect(hook.result.current.data?.pages[0].slices).toEqual([])
    // The gated mount fetches from the top, though `STALE.INFINITY`.
    expect(refreshToTop).toHaveBeenCalledTimes(1)
    act(() => {
      now += 1_000
      confirm()
    })
    expect(refreshToTop).toHaveBeenCalledTimes(2)
    expect(onHasNew).not.toHaveBeenCalled()
  })

  it('scrolled down, the lift lights the affordance and resting at the top runs the refresh owed', () => {
    seed(now - 10)
    unconfirm()
    const refreshToTop = jest.fn(() => Promise.resolve())
    const onHasNew = jest.fn()
    const hook = renderHook(
      () =>
        useFollowingBusy({
          enabled: true,
          queryKey: KEY,
          data: selected(now - 10),
          isScrolledDown: () => true,
          refreshToTop,
          onHasNew,
          Header: undefined,
        }),
      {wrapper},
    )
    // Scrolled down at mount: no request, the affordance instead.
    expect(refreshToTop).not.toHaveBeenCalled()
    expect(onHasNew).toHaveBeenLastCalledWith(true)
    // A staged page withdrawn meanwhile leaves the affordance lit (item 7).
    act(() => {
      hook.result.current.onStagedWithdrawn()
    })
    expect(onHasNew).not.toHaveBeenCalledWith(false)
    act(() => {
      hook.result.current.onRestAtTop()
    })
    expect(refreshToTop).toHaveBeenCalledTimes(1)
    // Nothing owed, a withdrawn staged page puts it out.
    act(() => {
      hook.result.current.onStagedWithdrawn()
    })
    expect(onHasNew).toHaveBeenLastCalledWith(false)
    // Nothing more is owed.
    act(() => {
      hook.result.current.onRestAtTop()
    })
    expect(refreshToTop).toHaveBeenCalledTimes(1)
  })

  it('a mount while confirmed paints from cache and makes no request', () => {
    seed(now - 10)
    confirm()
    const refreshToTop = jest.fn(() => Promise.resolve())
    const hook = renderHook(
      () =>
        useFollowingBusy({
          enabled: true,
          queryKey: KEY,
          data: selected(now - 10),
          isScrolledDown: () => false,
          refreshToTop,
          onHasNew: undefined,
          Header: undefined,
        }),
      {wrapper},
    )
    expect(hook.result.current.hidden).toBe(0)
    expect(hook.result.current.data?.pages[0].slices).toHaveLength(1)
    expect(refreshToTop).not.toHaveBeenCalled()
  })

  it('shows the note in the header slot only while a row is hidden', () => {
    seed(now - 10)
    unconfirm()
    const Header = () => <></>
    const hook = renderHook(
      () =>
        useFollowingBusy({
          enabled: true,
          queryKey: KEY,
          data: selected(now - 10),
          isScrolledDown: () => true,
          refreshToTop: () => Promise.resolve(),
          onHasNew: undefined,
          Header,
        }),
      {wrapper},
    )
    const NoteHeader = hook.result.current.Header!
    const first = render(<NoteHeader />, {wrapper})
    expect(screen.queryByTestId('privateCatchingUpNote')).not.toBeNull()

    // Not when the gate hid nothing.
    act(() => {
      qc.setQueryData(KEY, {
        pages: [{feed: [row(OTHER, 2)], fetchedAt: now + 5_000}],
        pageParams: [undefined],
      })
    })
    hook.rerender({})
    first.unmount()
    const Again = hook.result.current.Header!
    render(<Again />, {wrapper})
    expect(screen.queryByTestId('privateCatchingUpNote')).toBeNull()
  })
})

describe('notifications (6.7)', () => {
  it('hides a group whose subject is another author’s private post from a page fetched before the load', () => {
    const page = {
      fetchedAt: 50,
      notifications: [
        {
          type: 'reply',
          post: {uri: OTHER},
          parent: {type: 'post', post: {uri: OWN}},
        },
        {type: 'like', post: {uri: OWN}},
      ],
    }
    const gated = gateNotificationPages([page] as never[], DID, 100)
    expect(gated.hidden).toBe(1)
    expect(
      (gated.pages[0] as typeof page).notifications.map(n => n.type),
    ).toEqual(['like'])
    // A page fetched since holds it again.
    expect(
      gateNotificationPages([{...page, fetchedAt: 150}] as never[], DID, 100)
        .hidden,
    ).toBe(0)
  })

  it('offers the Refresh pill while the lift’s mark is newer than the first page', () => {
    const base = {
      isActive: true,
      unread: undefined,
      top: {requestedAt: 100},
      isFetchingTop: false,
    }
    expect(isPrivateRefreshPillVisible(base)).toBe(false)
    expect(isPrivateRefreshPillVisible({...base, stale: 150})).toBe(true)
    expect(isPrivateRefreshPillVisible({...base, stale: 50})).toBe(false)
    expect(
      isPrivateRefreshPillVisible({...base, stale: 150, isFetchingTop: true}),
    ).toBe(false)
  })
})

describe('the actor lists (BR11-N6)', () => {
  type LikesPage = app.bsky.feed.getLikes.$OutputBody

  function useLikes(subject: string, fetch: () => Promise<LikesPage>) {
    const key = ['liked-by', subject]
    const query = useInfiniteQuery<
      LikesPage,
      Error,
      InfiniteData<LikesPage>,
      string[],
      string | undefined
    >({
      queryKey: key,
      queryFn: fetch,
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
      staleTime: Infinity,
    })
    return useBusyListQuery(query, {
      subjectUri: subject,
      queryKey: key,
      access: likesListAccess(subject),
    })
  }

  const like = {
    actor: {did: 'did:plc:liker', handle: 'liker.test'},
    createdAt: minute(0),
    indexedAt: minute(0),
  } as unknown as app.bsky.feed.getLikes.Like

  it('under another author’s private post shows no rows until a page fetched since', async () => {
    qc.setQueryData(['liked-by', OTHER], {
      pages: [{uri: OTHER, likes: [like], fetchedAt: now - 10}],
      pageParams: [undefined],
    })
    unconfirm()
    let resolve: (page: LikesPage) => void = () => {}
    const fetch = jest.fn(
      () =>
        new Promise<LikesPage>(r => {
          resolve = r
        }),
    )
    const hook = renderHook(() => useLikes(OTHER, fetch), {wrapper})
    // The gated mount refetches; meanwhile no row shows.
    expect(fetch).toHaveBeenCalled()
    expect(hook.result.current.data).toBeUndefined()
    expect(hook.result.current.horizonHidden).toBe(1)
    await act(async () => {
      now += 100
      resolve(stampListPage({uri: OTHER, likes: [like]} as never))
      await Promise.resolve()
    })
    expect(hook.result.current.data?.pages[0].likes).toHaveLength(1)
    expect(hook.result.current.horizonHidden).toBe(0)
  })

  it('a refresh that fails with every row hidden reads as the quiet error', async () => {
    qc.setQueryData(['liked-by', OTHER], {
      pages: [{uri: OTHER, likes: [like], fetchedAt: now - 10}],
      pageParams: [undefined],
    })
    unconfirm()
    const fetch = jest.fn(() => Promise.reject(new Error('down')))
    const hook = renderHook(() => useLikes(OTHER, fetch), {wrapper})
    await act(async () => {})
    expect(hook.result.current.isError).toBe(true)
    expect(hook.result.current.error).toBeInstanceOf(PrivateListBusyError)
  })

  it('under the reader’s own private post is not gated', () => {
    qc.setQueryData(['liked-by', OWN], {
      pages: [{uri: OWN, likes: [like], fetchedAt: now - 10}],
      pageParams: [undefined],
    })
    unconfirm()
    const hook = renderHook(
      () => useLikes(OWN, () => new Promise<LikesPage>(() => {})),
      {wrapper},
    )
    expect(hook.result.current.data?.pages[0].likes).toHaveLength(1)
    expect(hook.result.current.horizonHidden).toBe(0)
  })

  it('scrolled down at the lift, the refresh runs once the list is back at the top', async () => {
    qc.setQueryData(['liked-by', OTHER], {
      pages: [{uri: OTHER, likes: [like], fetchedAt: now - 10}],
      pageParams: [undefined],
    })
    unconfirm()
    const fetch = jest.fn(() => Promise.reject(new Error('down')))
    const hook = renderHook(() => useLikes(OTHER, fetch), {wrapper})
    await act(async () => {})
    const calls = fetch.mock.calls.length
    act(() => hook.result.current.horizonOnScrolledDownChange(true))
    await act(async () => {
      now += 1_000
      confirm()
      await Promise.resolve()
    })
    // Scrolled down: nothing yet.
    expect(fetch.mock.calls.length).toBe(calls)
    await act(async () => {
      hook.result.current.horizonOnScrolledDownChange(false)
      await Promise.resolve()
    })
    expect(fetch.mock.calls.length).toBe(calls + 1)
  })
})

describe('the 20 s note (10, T-12)', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('shows after 20 s of ill health on its surfaces, and clears 2 s after healthy', () => {
    jest.useFakeTimers()
    unconfirm()
    render(<CatchingUpNote hidden={0} illHealth />, {wrapper})
    expect(screen.queryByTestId('privateCatchingUpNote')).toBeNull()
    act(() => {
      now += 19_999
      jest.advanceTimersByTime(19_999)
    })
    expect(screen.queryByTestId('privateCatchingUpNote')).toBeNull()
    act(() => {
      now += 1
      jest.advanceTimersByTime(1)
    })
    expect(screen.queryByTestId('privateCatchingUpNote')).not.toBeNull()
    act(() => {
      confirm()
    })
    expect(screen.queryByTestId('privateCatchingUpNote')).not.toBeNull()
    act(() => {
      jest.advanceTimersByTime(2_000)
    })
    expect(screen.queryByTestId('privateCatchingUpNote')).toBeNull()
  })

  it('never on a surface without it, and never for a non-member', () => {
    jest.useFakeTimers()
    unconfirm()
    const plain = render(<CatchingUpNote hidden={0} />, {wrapper})
    act(() => {
      now += 30_000
      jest.advanceTimersByTime(30_000)
    })
    expect(screen.queryByTestId('privateCatchingUpNote')).toBeNull()
    plain.unmount()
    mockMembership = 'not-member'
    render(<CatchingUpNote hidden={0} illHealth />, {wrapper})
    expect(screen.queryByTestId('privateCatchingUpNote')).toBeNull()
  })
})
