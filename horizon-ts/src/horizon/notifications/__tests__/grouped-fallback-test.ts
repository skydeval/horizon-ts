import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

const mockResolvePrivateQuotes = jest.fn((_posts: Iterable<unknown>) =>
  Promise.resolve(),
)
jest.mock('#/horizon/private/quotes/resolve', () => ({
  resolvePrivateQuotes: (posts: Iterable<unknown>) =>
    mockResolvePrivateQuotes(posts),
}))
// The stock grouping's module precaches profiles, which loads the UI
jest.mock('#/state/queries/profile', () => ({precacheProfile: jest.fn()}))

import {type Client} from '@atproto/lex'

import {type LoadedGroupedNotificationsPage} from '#/state/queries/notifications/grouped'
import {hydratePage} from '#/state/queries/notifications/grouped/hydrate'
import {type GroupedNotificationsFeed} from '#/state/queries/notifications/grouped/types'
import {
  type Call,
  DID,
  fakeClient,
  privateUri,
  RECORD_CID,
  type Reply,
} from '#/horizon/private/__tests__/fixtures'
import {app} from '#/lexicons'
import {
  FALLBACK_COOLDOWN_MS,
  isFallbackError,
  LIST_PAGE_SIZE,
  resetGroupedFallback,
  withGroupedFallback,
} from '../grouped-fallback'

const ALICE = 'did:plc:aliceaaaaaaaaaaaaaaaaaaa'
const BOB = 'did:plc:bobbbbbbbbbbbbbbbbbbbbbb'
const CAROL = 'did:plc:carolccccccccccccccccccc'

const GROUPED = 'app.bsky.notification.getGroupedNotifications'
const LIST = 'app.bsky.notification.listNotifications'
const GET_POSTS = 'app.bsky.feed.getPosts'

function postUri(did: string, rkey: string) {
  return `at://${did}/app.bsky.feed.post/${rkey}`
}

function author(did: string, {following = false} = {}) {
  return {
    did,
    handle: `${did.slice(8, 13)}.test`,
    viewer: following ? {following: `at://${DID}/app.bsky.graph.follow/x`} : {},
  }
}

function at(minute: number) {
  return `2026-10-17T12:${String(minute).padStart(2, '0')}:00.000Z`
}

function like(
  by: string,
  subject: string,
  minute: number,
  {isRead = false} = {},
) {
  return {
    uri: `at://${by}/app.bsky.feed.like/l${minute}`,
    cid: RECORD_CID,
    author: author(by),
    reason: 'like',
    reasonSubject: subject,
    record: {
      $type: 'app.bsky.feed.like',
      subject: {uri: subject, cid: RECORD_CID},
      createdAt: at(minute),
    },
    isRead,
    indexedAt: at(minute),
  }
}

function reply(by: string, rkey: string, parent: string, minute: number) {
  return {
    uri: postUri(by, rkey),
    cid: RECORD_CID,
    author: author(by),
    reason: 'reply',
    reasonSubject: parent,
    record: {
      $type: 'app.bsky.feed.post',
      text: 'a reply',
      reply: {
        root: {uri: parent, cid: RECORD_CID},
        parent: {uri: parent, cid: RECORD_CID},
      },
      createdAt: at(minute),
    },
    isRead: false,
    indexedAt: at(minute),
  }
}

function follow(by: string, minute: number, {following = false} = {}) {
  return {
    uri: `at://${by}/app.bsky.graph.follow/f${minute}`,
    cid: RECORD_CID,
    author: author(by, {following}),
    reason: 'follow',
    record: {
      $type: 'app.bsky.graph.follow',
      subject: DID,
      createdAt: at(minute),
    },
    isRead: true,
    indexedAt: at(minute),
  }
}

function postView(uri: string) {
  const did = uri.split('/')[2]
  return {
    uri,
    cid: RECORD_CID,
    author: author(did),
    record: {$type: 'app.bsky.feed.post', text: uri, createdAt: at(0)},
    indexedAt: at(0),
  }
}

const MY_POST = postUri(DID, 'mine')
const MY_PRIVATE_POST = privateUri('secret')

type Notif = ReturnType<typeof like> | ReturnType<typeof reply>

/**
 * A fake AppView: `getGroupedNotifications` answers `grouped`,
 * `listNotifications` serves `pages` by cursor ('' for the top), and
 * `getPosts` answers every uri it is given.
 */
function fakeAppview({
  grouped,
  pages,
}: {
  grouped: (call: Call) => Reply
  pages: Record<string, {notifications: unknown[]; cursor?: string}>
}) {
  return fakeClient(DID, call => {
    if (call.nsid === GROUPED) return grouped(call)
    if (call.nsid === LIST) {
      const page = pages[call.params.get('cursor') ?? '']
      if (!page) return {status: 400, body: {error: 'InvalidRequest'}}
      return {
        status: 200,
        body: {...page, seenAt: at(30)},
      }
    }
    if (call.nsid === GET_POSTS) {
      return {
        status: 200,
        body: {posts: call.params.getAll('uris').map(postView)},
      }
    }
    return {status: 501, body: {error: 'MethodNotImplemented'}}
  })
}

function groupedPage(client: Client, feed: GroupedNotificationsFeed) {
  return async (
    cursor: string | undefined,
    requestedAt = 1,
    now?: () => number,
  ): Promise<LoadedGroupedNotificationsPage> =>
    withGroupedFallback(
      {client, feed, cursor, viewerDid: DID, requestedAt, now},
      async () => {
        const res = await client.call(
          app.bsky.notification.getGroupedNotifications,
          {feed, limit: 30, cursor},
        )
        return {...hydratePage(res, {viewerDid: DID}), requestedAt}
      },
    )
}

const internalError: Reply = {
  status: 500,
  body: {error: 'InternalServerError', message: 'Internal Server Error'},
}

/** A page with a like of a private post, which breaks the grouped request. */
const livePage: Notif[] = [
  like(ALICE, MY_PRIVATE_POST, 20),
  like(ALICE, MY_POST, 19),
  like(BOB, MY_POST, 18, {isRead: true}),
  reply(CAROL, 'r1', MY_POST, 17),
]

beforeEach(() => {
  resetGroupedFallback()
  mockResolvePrivateQuotes.mockClear()
})

describe('isFallbackError', () => {
  it('takes 5xx and network failures, not 4xx', async () => {
    const statuses = [500, 502, 503, 400, 401, 403, 404]
    const results: Record<number, boolean> = {}
    for (const status of statuses) {
      const {client} = fakeClient(DID, () => ({
        status,
        body: {error: 'Something'},
      }))
      const error = await client
        .call(app.bsky.notification.getGroupedNotifications, {})
        .catch((e: unknown) => e)
      results[status] = isFallbackError(error)
    }
    expect(results).toEqual({
      500: true,
      502: true,
      503: true,
      400: false,
      401: false,
      403: false,
      404: false,
    })

    const {client: offline} = fakeClient(
      DID,
      () => new TypeError('Failed to fetch'),
    )
    const networkError = await offline
      .call(app.bsky.notification.getGroupedNotifications, {})
      .catch((e: unknown) => e)
    expect(isFallbackError(networkError)).toBe(true)

    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const {client: aborted} = fakeClient(DID, () => abort)
    const abortError = await aborted
      .call(app.bsky.notification.getGroupedNotifications, {})
      .catch((e: unknown) => e)
    expect(isFallbackError(abortError)).toBe(false)
  })

  it('takes a 500 whose body is not XRPC JSON', async () => {
    const {createLexClient} = await import('#/lib/lexClient')
    const client = createLexClient(
      {
        did: DID,
        fetchHandler: () =>
          Promise.resolve(
            new Response('Internal Server Error', {
              status: 500,
              headers: {'content-type': 'text/plain'},
            }),
          ),
      },
      {appLabelers: null},
    )
    const error = await client
      .call(app.bsky.notification.getGroupedNotifications, {})
      .catch((e: unknown) => e)
    expect(isFallbackError(error)).toBe(true)
  })
})

describe('withGroupedFallback', () => {
  it('reads the page from listNotifications when the grouped request 500s', async () => {
    const {client, calls} = fakeAppview({
      grouped: () => internalError,
      pages: {'': {notifications: livePage, cursor: 'next1'}},
    })
    const page = await groupedPage(client, 'all')(undefined, 42)

    expect(calls.map(c => c.nsid)).toEqual([GROUPED, LIST, GET_POSTS])
    const list = calls[1]
    expect(list.params.get('limit')).toBe(String(LIST_PAGE_SIZE))
    expect(list.params.getAll('reasons')).toEqual([])
    // Only app.bsky.feed.post subjects are read; the private one is not.
    const read = calls[2].params.getAll('uris')
    expect(read).toContain(MY_POST)
    expect(read).toContain(postUri(CAROL, 'r1'))
    expect(read).not.toContain(MY_PRIVATE_POST)

    // The like of the private post has no subject and is dropped.
    expect(page.notifications.map(n => n.type)).toEqual(['like', 'reply'])
    const [likes, replied] = page.notifications
    if (likes.type !== 'like' || replied.type !== 'reply') throw new Error()
    expect(likes.post.uri).toBe(MY_POST)
    expect(likes.actors.map(a => a.did)).toEqual([ALICE, BOB])
    expect(likes.count).toBe(2)
    // Unread while any of the group is
    expect(likes.isRead).toBe(false)
    expect(likes.indexedAt).toBe(at(19))
    expect(replied.post.uri).toBe(postUri(CAROL, 'r1'))
    expect(replied.parent).toEqual({
      type: 'post',
      post: expect.objectContaining({uri: MY_POST}),
    })

    expect(page.seenAt).toBe(at(30))
    expect(page.requestedAt).toBe(42)
    // The newest notification counts, the dropped one included, as in hydratePage.
    expect(page.newestAt).toBe(Date.parse(at(20)))
    expect(page.cursor).toBe('horizon-list:next1')

    expect(mockResolvePrivateQuotes).toHaveBeenCalledTimes(1)
    const quoted = [...mockResolvePrivateQuotes.mock.calls[0][0]] as {
      uri: string
    }[]
    expect(quoted.map(p => p.uri).sort()).toEqual(
      [MY_POST, postUri(CAROL, 'r1')].sort(),
    )
  })

  it('reads the page from listNotifications on a network failure', async () => {
    const {client, calls} = fakeAppview({
      grouped: () => new TypeError('Failed to fetch'),
      pages: {'': {notifications: livePage}},
    })
    const page = await groupedPage(client, 'all')(undefined)
    expect(calls.map(c => c.nsid)).toEqual([GROUPED, LIST, GET_POSTS])
    expect(page.notifications).toHaveLength(2)
    expect(page.cursor).toBeUndefined()
  })

  it('does not fall back on a 401', async () => {
    const {client, calls} = fakeAppview({
      grouped: () => ({status: 401, body: {error: 'AuthenticationRequired'}}),
      pages: {'': {notifications: livePage}},
    })
    await expect(groupedPage(client, 'all')(undefined)).rejects.toMatchObject({
      error: 'AuthenticationRequired',
    })
    expect(calls.map(c => c.nsid)).toEqual([GROUPED])
  })

  it('does not fall back on a 400', async () => {
    const {client, calls} = fakeAppview({
      grouped: () => ({status: 400, body: {error: 'InvalidRequest'}}),
      pages: {'': {notifications: livePage}},
    })
    await expect(groupedPage(client, 'all')(undefined)).rejects.toThrow()
    expect(calls.map(c => c.nsid)).toEqual([GROUPED])
  })

  it('uses the grouped page when it answers', async () => {
    const {client, calls} = fakeAppview({
      grouped: () => ({status: 200, body: {groups: [], cursor: 'g1'}}),
      pages: {'': {notifications: livePage}},
    })
    const page = await groupedPage(client, 'all')(undefined)
    expect(calls.map(c => c.nsid)).toEqual([GROUPED])
    expect(page.cursor).toBe('g1')
  })

  it('stays on the fallback for the rest of the list', async () => {
    const {client, calls} = fakeAppview({
      grouped: () => internalError,
      pages: {
        '': {notifications: [like(ALICE, MY_POST, 20)], cursor: 'c1'},
        c1: {notifications: [like(BOB, MY_POST, 10)], cursor: 'c2'},
        c2: {notifications: [reply(CAROL, 'r2', MY_POST, 5)]},
      },
    })
    const fetchPage = groupedPage(client, 'all')
    const first = await fetchPage(undefined)
    calls.length = 0
    const second = await fetchPage(first.cursor)
    expect(calls.map(c => c.nsid)).toEqual([LIST, GET_POSTS])
    expect(calls[0].params.get('cursor')).toBe('c1')
    expect(second.cursor).toBe('horizon-list:c2')
    calls.length = 0
    const third = await fetchPage(second.cursor)
    expect(calls.map(c => c.nsid)).toEqual([LIST, GET_POSTS])
    expect(third.cursor).toBeUndefined()
    expect(third.notifications.map(n => n.type)).toEqual(['reply'])
  })

  it('skips the grouped request for a while after it failed', async () => {
    let clock = 1_000_000
    const now = () => clock
    let groupedFails = true
    const {client, calls} = fakeAppview({
      grouped: () =>
        groupedFails ? internalError : {status: 200, body: {groups: []}},
      pages: {'': {notifications: livePage}},
    })
    const fetchPage = groupedPage(client, 'all')
    await fetchPage(undefined, 1, now)
    calls.length = 0

    // A refresh within the cooldown goes straight to the fallback.
    clock += FALLBACK_COOLDOWN_MS - 1
    groupedFails = false
    await fetchPage(undefined, 1, now)
    expect(calls.map(c => c.nsid)).toEqual([LIST, GET_POSTS])
    calls.length = 0

    // Other feeds are not held back.
    await groupedPage(client, 'followers')(undefined, 1, now)
    expect(calls.map(c => c.nsid)).toEqual([GROUPED])
    calls.length = 0

    // After it, the grouped request is tried again.
    clock += 1
    await fetchPage(undefined, 1, now)
    expect(calls.map(c => c.nsid)).toEqual([GROUPED])
  })

  it('picks up after the grouped list when a later grouped page fails', async () => {
    const groupedFirst = {
      status: 200,
      body: {
        cursor: 'g1',
        groups: [
          {
            $type: `${GROUPED}#group`,
            id: 'g-like',
            count: 1,
            isRead: false,
            indexedAt: at(15),
            kind: {
              $type: `${GROUPED}#likeGroup`,
              post: MY_POST,
              items: [{actor: ALICE}],
            },
          },
        ],
        relatedViews: [
          {...postView(MY_POST), $type: 'app.bsky.feed.defs#postView'},
          {...author(ALICE), $type: 'app.bsky.actor.defs#profileViewBasic'},
        ],
      },
    }
    const {client, calls} = fakeAppview({
      grouped: call =>
        call.params.get('cursor') === 'g1' ? internalError : groupedFirst,
      pages: {
        '': {
          notifications: [like(ALICE, MY_POST, 20), like(ALICE, MY_POST, 15)],
          cursor: 'c1',
        },
        c1: {
          notifications: [
            like(BOB, MY_POST, 15),
            reply(CAROL, 'r3', MY_POST, 9),
          ],
          cursor: 'c2',
        },
      },
    })
    const fetchPage = groupedPage(client, 'all')
    const first = await fetchPage(undefined)
    expect(first.cursor).toBe('g1')
    calls.length = 0

    const second = await fetchPage(first.cursor)
    expect(calls.map(c => c.nsid)).toEqual([GROUPED, LIST, LIST, GET_POSTS])
    // Only what is older than the grouped list's oldest row
    expect(second.notifications.map(n => n.type)).toEqual(['reply'])
    expect(second.cursor).toBe('horizon-list:c2')
  })

  it('maps each pill to its reasons and filters', async () => {
    const {client, calls} = fakeAppview({
      grouped: () => internalError,
      pages: {
        '': {
          notifications: [
            follow(ALICE, 20, {following: true}),
            follow(BOB, 19),
            reply(CAROL, 'r4', MY_POST, 18),
          ],
        },
      },
    })
    const reasonsFor = async (feed: GroupedNotificationsFeed) => {
      calls.length = 0
      const page = await groupedPage(client, feed)(undefined)
      return {
        reasons: calls.find(c => c.nsid === LIST)?.params.getAll('reasons'),
        types: page.notifications.map(n => n.type),
      }
    }
    expect(await reasonsFor('followers')).toEqual({
      reasons: ['follow'],
      // The fake serves every reason; the client filter still applies.
      types: ['followBack', 'follow'],
    })
    expect(await reasonsFor('conversations')).toEqual({
      reasons: ['reply', 'quote', 'mention'],
      types: ['reply'],
    })
    expect(await reasonsFor('activity')).toEqual({
      reasons: ['subscribed-post'],
      types: [],
    })
    // Every reason, from authors the viewer follows
    expect(await reasonsFor('people-i-follow')).toEqual({
      reasons: [],
      types: ['followBack'],
    })
  })
})
