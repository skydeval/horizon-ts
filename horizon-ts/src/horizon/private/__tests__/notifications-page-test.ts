import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  isPrivateMember: (did?: string) => !!did,
  reportPrismError: () => {},
}))
jest.mock('#/state/queries/profile', () => ({precacheProfile: jest.fn()}))
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))

import {QueryClient} from '@tanstack/react-query'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  loadPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {countUnmuted} from '../activity-subscriptions/mute-filter'
import {
  fetchPrivateNotificationsPage,
  PRIVATE_ONLY_REASONS,
  reasonsForTab,
} from '../notifications/page'
import {
  composeUnreadCount,
  countPrivateOnlyUnread,
  markPrivateNotificationsSeen,
  PRIVATE_UNREAD_OWN_ROOT,
  PRIVATE_UNREAD_ROOT,
} from '../notifications/unread'
import {clearPrivateStores} from '../store'
import {DID, OTHER_DID, RECORD_CID, type Reply} from './fixtures'
import {at, fakeAppview, fakePrism, privateView} from './read-fixtures'

const LIKER = 'did:plc:likerccccccccccccccccccc'
const OWN = privateView('3kown22222222', {minutes: 0})
const REPLY = privateView('3kreply222222', {
  did: OTHER_DID,
  handle: 'other.test',
  minutes: 5,
  reply: {
    root: {uri: OWN.uri, cid: RECORD_CID},
    parent: {uri: OWN.uri, cid: RECORD_CID},
  },
})
const QUOTE_URI = `at://${LIKER}/app.bsky.feed.post/3kquote222222`
const SUBSCRIBED = privateView('3ksubscribed2', {
  did: OTHER_DID,
  handle: 'other.test',
  minutes: 6,
})

function author(did: string, handle: string) {
  return {did, handle}
}

const replyNotification = {
  uri: REPLY.uri,
  cid: RECORD_CID,
  author: author(OTHER_DID, 'other.test'),
  reason: 'reply',
  reasonSubject: OWN.uri,
  record: REPLY.record,
  isRead: false,
  indexedAt: at(5),
  labels: [],
}

const likeNotification = {
  uri: `at://${LIKER}/app.bsky.feed.like/3klike2222222`,
  cid: RECORD_CID,
  author: author(LIKER, 'liker.test'),
  reason: 'like',
  reasonSubject: OWN.uri,
  record: {
    $type: 'app.bsky.feed.like',
    subject: {uri: OWN.uri, cid: RECORD_CID},
    createdAt: at(4),
  },
  isRead: false,
  indexedAt: at(4),
  // Not an array: read as none.
  labels: null,
}

const quoteNotification = {
  uri: QUOTE_URI,
  cid: RECORD_CID,
  author: author(LIKER, 'liker.test'),
  reason: 'quote',
  reasonSubject: OWN.uri,
  record: {
    $type: 'app.bsky.feed.post',
    text: 'quoting',
    createdAt: at(3),
    embed: {
      $type: 'app.bsky.embed.record',
      record: {uri: OWN.uri, cid: RECORD_CID},
    },
  },
  isRead: true,
  indexedAt: at(3),
  labels: [],
}

let prismHandler: (nsid: string, params: URLSearchParams) => Reply | undefined

function setup() {
  const prism = fakePrism({
    posts: [OWN, REPLY, SUBSCRIBED],
    handler: (nsid, params) => prismHandler(nsid, params),
  })
  const appview = fakeAppview({
    profiles: [
      {did: LIKER, handle: 'liker.test', displayName: 'Public Liker'},
      {did: OTHER_DID, handle: 'other.test'},
    ],
    posts: [
      {
        uri: QUOTE_URI,
        cid: RECORD_CID,
        author: {did: LIKER, handle: 'liker.test'},
        record: quoteNotification.record,
        indexedAt: at(3),
      },
    ],
  })
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'author.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: appview.client,
  })
  return {
    prism,
    appview,
    source: {did: DID, prism: prism.client, appview: appview.client},
  }
}

function listing(notifications: unknown[], cursor?: string): Reply {
  return {status: 200, body: {notifications, ...(cursor ? {cursor} : {})}}
}

beforeEach(() => {
  clearPrivateStores()
  resetPrismFeatures()
  answerPrismFeatures(DID, ['private', 'private.notifications'])
  prismHandler = () => undefined
})

describe('the private notifications page (2H design 10.2, T13)', () => {
  it('groups and hydrates replies, likes and public quotes', async () => {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.listNotifications'
        ? listing([
            replyNotification,
            likeNotification,
            quoteNotification,
            {reason: 'reply'},
          ])
        : undefined
    const {prism, appview, source} = setup()
    const page = await fetchPrivateNotificationsPage({
      source,
      tab: 'all',
      cursor: undefined,
      viewerDid: DID,
      requestedAt: 1,
    })
    expect(page.requestedAt).toBe(1)
    expect(page.notifications.map(n => n.type)).toEqual([
      'reply',
      'like',
      'quote',
    ])
    const [reply, like, quote] = page.notifications
    if (reply.type !== 'reply' || like.type !== 'like') throw new Error()
    expect(reply.post.uri).toBe(REPLY.uri)
    // The private reply's parent comes from its postPrivate record.
    expect(reply.parent.type === 'post' && reply.parent.post.uri).toBe(OWN.uri)
    expect(like.post.uri).toBe(OWN.uri)
    expect(like.actors[0].displayName).toBe('Public Liker')
    if (quote.type !== 'quote') throw new Error()
    expect(quote.post.uri).toBe(QUOTE_URI)

    const listCall = prism.calls.find(
      c => c.nsid === 'app.nearhorizon.private.listNotifications',
    )
    expect(listCall?.params.getAll('reasons')).toEqual([])
    const prismPosts = prism.calls
      .filter(c => c.nsid === 'app.nearhorizon.private.getPosts')
      .flatMap(c => c.params.getAll('uris'))
    expect(prismPosts.sort()).toEqual([OWN.uri, REPLY.uri].sort())
    const publicPosts = appview.calls
      .filter(c => c.nsid === 'app.bsky.feed.getPosts')
      .flatMap(c => c.params.getAll('uris'))
    expect(publicPosts).toEqual([QUOTE_URI])
  })

  it('asks replies, quotes and mentions for the Replies pill and follows empty pages', async () => {
    prismHandler = (nsid, params) => {
      if (nsid !== 'app.nearhorizon.private.listNotifications') return undefined
      return params.get('cursor')
        ? listing([replyNotification])
        : listing([], 'next')
    }
    const {prism, source} = setup()
    const page = await fetchPrivateNotificationsPage({
      source,
      tab: 'replies',
      cursor: undefined,
      viewerDid: DID,
      requestedAt: 1,
    })
    expect(page.notifications).toHaveLength(1)
    const calls = prism.calls.filter(
      c => c.nsid === 'app.nearhorizon.private.listNotifications',
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].params.getAll('reasons')).toEqual([
      'reply',
      'quote',
      'mention',
    ])
  })
})

describe('subscribed-post and the Activity pill (activity subscriptions T-16, T-17)', () => {
  const subscribedNotification = {
    uri: SUBSCRIBED.uri,
    cid: RECORD_CID,
    author: author(OTHER_DID, 'other.test'),
    reason: 'subscribed-post',
    record: SUBSCRIBED.record,
    isRead: false,
    indexedAt: at(6),
    labels: [],
  }

  it('asks the Activity pill for subscribed-post only', async () => {
    expect(reasonsForTab('activity')).toEqual(['subscribed-post'])
    expect(reasonsForTab('replies')).toEqual(['reply', 'quote', 'mention'])
    expect(reasonsForTab('all')).toBeUndefined()
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.listNotifications'
        ? listing([subscribedNotification])
        : undefined
    const {prism, source} = setup()
    await fetchPrivateNotificationsPage({
      source,
      tab: 'activity',
      cursor: undefined,
      viewerDid: DID,
      requestedAt: 1,
    })
    const listCall = prism.calls.find(
      c => c.nsid === 'app.nearhorizon.private.listNotifications',
    )
    expect(listCall?.params.getAll('reasons')).toEqual(['subscribed-post'])
  })

  it('a subscribed-post item with a private URI passes, groups as subscribedPost and is read through prism', async () => {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.listNotifications'
        ? listing([subscribedNotification])
        : undefined
    const {prism, appview, source} = setup()
    const page = await fetchPrivateNotificationsPage({
      source,
      tab: 'all',
      cursor: undefined,
      viewerDid: DID,
      requestedAt: 1,
    })
    expect(page.notifications.map(n => n.type)).toEqual(['subscribedPost'])
    const [group] = page.notifications
    if (group.type !== 'subscribedPost') throw new Error()
    // The stock activity row renders `items` (aggregate.tsx).
    expect(group.items[0].post.uri).toBe(SUBSCRIBED.uri)
    expect(group.items[0].actor.did).toBe(OTHER_DID)
    const prismPosts = prism.calls
      .filter(c => c.nsid === 'app.nearhorizon.private.getPosts')
      .flatMap(c => c.params.getAll('uris'))
    expect(prismPosts).toEqual([SUBSCRIBED.uri])
    expect(
      appview.calls.filter(c => c.nsid === 'app.bsky.feed.getPosts'),
    ).toEqual([])
  })
})

describe('the unread counts (2H design 10.5, T13)', () => {
  it('composes the badge', () => {
    expect(composeUnreadCount('', undefined)).toBe('')
    expect(composeUnreadCount('', 0)).toBe('')
    expect(composeUnreadCount('3', undefined)).toBe('3')
    expect(composeUnreadCount('3', 2)).toBe('5')
    expect(composeUnreadCount('', 4)).toBe('4')
    expect(composeUnreadCount('29', 1)).toBe('30+')
    expect(composeUnreadCount('30+', 0)).toBe('30+')
    expect(composeUnreadCount('x', 2)).toBe('2')
  })

  function unread(rkey: string, isRead = false, uri?: string) {
    return {
      ...replyNotification,
      uri: uri ?? privateView(rkey, {did: OTHER_DID}).uri,
      isRead,
    }
  }

  it('counts unread private-post notifications only and stops at a read one', async () => {
    prismHandler = (nsid, params) => {
      if (nsid !== 'app.nearhorizon.private.listNotifications') return undefined
      if (!params.get('cursor')) {
        return listing(
          [unread('3ka'), unread('3kb', false, QUOTE_URI), unread('3kc')],
          'p2',
        )
      }
      return listing([unread('3kd'), unread('3ke', true), unread('3kf')], 'p3')
    }
    const {prism, source} = setup()
    const items = await countPrivateOnlyUnread(source.prism)
    // Kept as their authors (activity subscriptions T-18).
    expect(items).toEqual([
      {author: OTHER_DID},
      {author: OTHER_DID},
      {author: OTHER_DID},
    ])
    const calls = prism.calls.filter(
      c => c.nsid === 'app.nearhorizon.private.listNotifications',
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].params.getAll('reasons')).toEqual([
      'reply',
      'quote',
      'mention',
    ])
  })

  it('asks for subscribed-post too with the feature (activity subscriptions T-18)', async () => {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.listNotifications'
        ? listing([unread('3ka')])
        : undefined
    const {prism, source} = setup()
    await countPrivateOnlyUnread(source.prism, {activity: true})
    const call = prism.calls.find(
      c => c.nsid === 'app.nearhorizon.private.listNotifications',
    )
    expect(call?.params.getAll('reasons')).toEqual(PRIVATE_ONLY_REASONS)
    expect(PRIVATE_ONLY_REASONS).toEqual([
      'reply',
      'quote',
      'mention',
      'subscribed-post',
    ])
  })

  it('stops at 30 and at three pages', async () => {
    prismHandler = (nsid, params) =>
      nsid === 'app.nearhorizon.private.listNotifications'
        ? listing(
            Array.from({length: 12}, (_, i) => unread(`3k${i}`)),
            `more${params.get('cursor') ?? ''}`,
          )
        : undefined
    const {source} = setup()
    // Without the feature the read stops at the cap, as before.
    expect(await countPrivateOnlyUnread(source.prism)).toHaveLength(30)
    // With it every unread item of three pages is kept, for the mute filter;
    // the cap of 30 is the count's (activity subscriptions T-18).
    const all = await countPrivateOnlyUnread(source.prism, {activity: true})
    expect(all).toHaveLength(36)
    expect(countUnmuted(all, new Set(), 30)).toBe(30)

    let pages = 0
    prismHandler = nsid => {
      if (nsid !== 'app.nearhorizon.private.listNotifications') return undefined
      pages++
      return listing([unread(`3kp${pages}`)], `c${pages}`)
    }
    expect(await countPrivateOnlyUnread(source.prism)).toHaveLength(3)
    expect(pages).toBe(3)
  })

  it('marks seen with this run\u{2019}s answer only, then clears both counts', async () => {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.updateSeen'
        ? {status: 200, body: {}}
        : undefined
    const {prism, source} = setup()
    const queryClient = new QueryClient()
    queryClient.setQueryData([PRIVATE_UNREAD_ROOT, DID], 4)
    queryClient.setQueryData([PRIVATE_UNREAD_OWN_ROOT, DID], 2)

    resetPrismFeatures()
    loadPrismFeatures(DID, ['private', 'private.notifications'])
    expect(
      await markPrivateNotificationsSeen(queryClient, {
        prism: source.prism,
        did: DID,
        requestedAt: Date.parse(at(9)),
      }),
    ).toBe(false)
    expect(prism.calls).toEqual([])

    answerPrismFeatures(DID, ['private', 'private.notifications'])
    expect(
      await markPrivateNotificationsSeen(queryClient, {
        prism: source.prism,
        did: DID,
        requestedAt: Date.parse(at(9)),
      }),
    ).toBe(true)
    expect(prism.calls[0].nsid).toBe('app.nearhorizon.private.updateSeen')
    expect(prism.calls[0].body).toEqual({seenAt: at(9)})
    expect(queryClient.getQueryData([PRIVATE_UNREAD_ROOT, DID])).toBe(0)
    expect(queryClient.getQueryData([PRIVATE_UNREAD_OWN_ROOT, DID])).toEqual(
      [],
    )
  })
})
