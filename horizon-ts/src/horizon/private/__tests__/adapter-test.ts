import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {QueryClient} from '@tanstack/react-query'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {toFeedViewPosts} from '../adapt/feed-view'
import {toPostView} from '../adapt/post-view'
import {clearPrivateStores, getPrivatePostFacts} from '../store'
import {DID, OTHER_DID, privateUri, RECORD_CID} from './fixtures'
import {
  AUDIENCE_URI,
  fakeAppview,
  fakePrism,
  OTHER_CID,
  privateView,
} from './read-fixtures'

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
  resetPrismFeatures()
})

/** A view with fields prism serves beyond the base ones (no excess check). */
function served<T extends ReturnType<typeof privateView>>(view: T): T {
  return view
}

describe('toPostView', () => {
  it('adapts a prism view to a post view whose record is a valid post record', () => {
    const post = toPostView(privateView('3kaaa'))!
    expect(post.$type).toBe('app.bsky.feed.defs#postView')
    expect(post.uri).toBe(privateUri('3kaaa'))
    expect(post.record).toMatchObject({
      $type: 'app.bsky.feed.post',
      text: 'post 3kaaa',
    })
    expect(bsky.matches(app.bsky.feed.post, post.record)).toBe(true)
    expect(getPrivatePostFacts(post.uri)).toEqual({
      audienceUri: AUDIENCE_URI,
      isPending: false,
    })
  })

  it('maps counts only when all four are served, with countsServed (T3)', () => {
    const counts = {replyCount: 2, repostCount: 1, likeCount: 4, quoteCount: 0}
    const post = toPostView(served({...privateView('3kaaa'), ...counts}))!
    expect(post).toMatchObject(counts)
    expect(post.bookmarkCount).toBeUndefined()
    expect(getPrivatePostFacts(post.uri)).toEqual({
      audienceUri: AUDIENCE_URI,
      isPending: false,
      countsServed: true,
    })
  })

  it('maps no count, and writes no countsServed, when one is missing or malformed', () => {
    for (const extra of [
      {likeCount: 4, replyCount: 2},
      {replyCount: 2, repostCount: 1, likeCount: -1, quoteCount: 0},
      {replyCount: 2, repostCount: 1, likeCount: 1.5, quoteCount: 0},
      {replyCount: '2', repostCount: 1, likeCount: 1, quoteCount: 0},
    ]) {
      clearPrivateStores()
      const post = toPostView(served({...privateView('3kaaa'), ...extra}))!
      expect(post.likeCount).toBeUndefined()
      expect(post.repostCount).toBeUndefined()
      expect(post.replyCount).toBeUndefined()
      expect(post.quoteCount).toBeUndefined()
      expect(post.viewer).toEqual({})
      expect(getPrivatePostFacts(post.uri)).toEqual({
        audienceUri: AUDIENCE_URI,
        isPending: false,
      })
    }
  })

  it('copies each viewer field only with its type, ignoring others', () => {
    const post = toPostView(
      served({
        ...privateView('3kaaa'),
        viewer: {
          bookmarked: true,
          like: `at://${OTHER_DID}/app.bsky.feed.like/3klike`,
          repost: 'not-a-uri',
          threadMuted: 'yes',
          replyDisabled: false,
          embeddingDisabled: true,
          pinned: true,
          knownLikers: {count: 1, followers: []},
        },
      }),
    )!
    expect(post.viewer).toEqual({
      bookmarked: true,
      like: `at://${OTHER_DID}/app.bsky.feed.like/3klike`,
      replyDisabled: false,
      embeddingDisabled: true,
    })
  })

  it('sets embeddingDisabled false only while prism applies the gates', () => {
    publishCurrentClients({did: DID} as never)
    expect(toPostView(privateView('3kaaa'))!.viewer).toEqual({})
    answerPrismFeatures(DID, ['private', 'private.gates'])
    expect(toPostView(privateView('3kaaa'))!.viewer).toEqual({
      embeddingDisabled: false,
    })
  })

  it('copies a threadgate that matches the stock view, and drops one that does not', () => {
    const threadgate = {
      uri: `at://${DID}/app.bsky.feed.threadgate/3kaaa`,
      cid: RECORD_CID,
      record: {
        $type: 'app.bsky.feed.threadgate',
        post: privateUri('3kaaa'),
        createdAt: '2026-10-15T12:00:00.000Z',
        allow: [],
      },
      lists: [],
    }
    expect(
      toPostView(served({...privateView('3kaaa'), threadgate}))!.threadgate,
    ).toEqual(threadgate)
    expect(
      toPostView(served({...privateView('3kbbb'), threadgate: {uri: 7}}))!
        .threadgate,
    ).toBeUndefined()
  })

  it('writes the served audience to the facts, and ignores a malformed one', () => {
    const audience = {uri: AUDIENCE_URI, mode: 'followers', name: 'Friends'}
    const post = toPostView(served({...privateView('3kaaa'), audience}))!
    expect(getPrivatePostFacts(post.uri)?.servedAudience).toEqual(audience)
    const other = toPostView(
      served({
        ...privateView('3kbbb'),
        audience: {uri: privateUri('3kccc'), mode: 'list'},
      }),
    )!
    expect(getPrivatePostFacts(other.uri)?.servedAudience).toBeUndefined()
    const badMode = toPostView(
      served({
        ...privateView('3kddd'),
        audience: {uri: AUDIENCE_URI, mode: 3},
      }),
    )!
    expect(getPrivatePostFacts(badMode.uri)?.servedAudience).toBeUndefined()
  })

  it('a pending post gets no counts, viewer state or served audience', () => {
    const post = toPostView(
      served({
        ...privateView('3kaaa'),
        replyCount: 1,
        repostCount: 1,
        likeCount: 1,
        quoteCount: 1,
        viewer: {bookmarked: true},
        audience: {uri: AUDIENCE_URI},
      }),
      {isPending: true},
    )!
    expect(post.likeCount).toBeUndefined()
    expect(post.viewer).toEqual({})
    expect(getPrivatePostFacts(post.uri)).toEqual({
      audienceUri: AUDIENCE_URI,
      isPending: true,
    })
  })

  it('drops a view whose record is not a private post record', () => {
    const view = {...privateView('3kaaa'), record: {$type: 'other', text: 1}}
    expect(toPostView(view)).toBeUndefined()
  })

  it('marks the current account’s own pinned post', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['profile', DID], {
      did: DID,
      handle: 'author.test',
      pinnedPost: {uri: privateUri('3kpin'), cid: RECORD_CID},
    })
    publishCurrentClients({
      did: DID,
      handle: 'author.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: {} as never,
      queryClient,
    })
    expect(toPostView(privateView('3kpin'))!.viewer).toEqual({pinned: true})
    expect(toPostView(privateView('3kother'))!.viewer).toEqual({})
  })
})

describe('toFeedViewPosts', () => {
  it('prefers the public profile for the author and falls back to prism’s', async () => {
    const appview = fakeAppview({
      profiles: [
        {
          did: DID,
          handle: 'public.test',
          displayName: 'Public name',
          viewer: {muted: true},
        },
      ],
    })
    const prism = fakePrism()
    const items = await toFeedViewPosts(
      [
        {view: privateView('3kaaa')},
        {view: privateView('3kbbb', {did: OTHER_DID, handle: 'prism.test'})},
      ],
      {prism: prism.client, appview: appview.client},
    )
    expect(items).toHaveLength(2)
    expect(items[0].post.author).toMatchObject({
      did: DID,
      handle: 'public.test',
      displayName: 'Public name',
      viewer: {muted: true},
    })
    expect(items[1].post.author).toEqual({
      did: OTHER_DID,
      handle: 'prism.test',
    })
  })

  it('keeps prism’s author when the public profiles call fails', async () => {
    const appview = fakeAppview({failProfiles: true})
    const items = await toFeedViewPosts([{view: privateView('3kaaa')}], {
      prism: fakePrism().client,
      appview: appview.client,
    })
    expect(items[0].post.author).toEqual({did: DID, handle: 'author.test'})
  })

  it('hydrates a private reply’s parent and root through prism', async () => {
    const parent = privateView('3kparent', {cid: OTHER_CID})
    const reply = privateView('3kreply', {
      minutes: 1,
      reply: {
        root: {uri: parent.uri, cid: OTHER_CID},
        parent: {uri: parent.uri, cid: OTHER_CID},
      },
    })
    const prism = fakePrism({posts: [parent]})
    const [item] = await toFeedViewPosts([{view: reply}], {
      prism: prism.client,
      appview: fakeAppview().client,
    })
    expect(item.reply?.parent).toMatchObject({
      $type: 'app.bsky.feed.defs#postView',
      uri: parent.uri,
    })
    expect(item.reply?.root).toMatchObject({uri: parent.uri})
  })

  it('fills a reply ref without a cid from the hydrated parent', async () => {
    const parent = privateView('3kparent', {cid: OTHER_CID})
    const reply = privateView('3kreply', {
      minutes: 1,
      reply: {root: {uri: parent.uri}, parent: {uri: parent.uri}},
    })
    const prism = fakePrism({posts: [parent]})
    const [item] = await toFeedViewPosts([{view: reply}], {
      prism: prism.client,
      appview: fakeAppview().client,
    })
    const record = item.post.record as app.bsky.feed.post.Main
    expect(record.reply?.parent.cid).toBe(OTHER_CID)
    expect(record.reply?.root.cid).toBe(OTHER_CID)
    expect(bsky.matches(app.bsky.feed.post, record)).toBe(true)
  })

  it('drops a reply whose ref has no cid and whose parent is unavailable', async () => {
    const missing = privateUri('3kgone')
    const reply = privateView('3kreply', {
      reply: {root: {uri: missing}, parent: {uri: missing}},
    })
    const items = await toFeedViewPosts([{view: reply}], {
      prism: fakePrism().client,
      appview: fakeAppview().client,
    })
    expect(items).toEqual([])
  })

  it('makes a ref neither server returns a notFoundPost', async () => {
    const missingPrivate = privateUri('3kgone')
    const missingPublic =
      'at://did:plc:publicccccccccccccccccccc/app.bsky.feed.post/3kpub'
    const reply = privateView('3kreply', {
      reply: {
        root: {uri: missingPublic, cid: OTHER_CID},
        parent: {uri: missingPrivate, cid: OTHER_CID},
      },
    })
    const [item] = await toFeedViewPosts([{view: reply}], {
      prism: fakePrism().client,
      appview: fakeAppview().client,
    })
    expect(item.reply?.parent).toEqual({
      $type: 'app.bsky.feed.defs#notFoundPost',
      uri: missingPrivate,
      notFound: true,
    })
    expect(item.reply?.root).toEqual({
      $type: 'app.bsky.feed.defs#notFoundPost',
      uri: missingPublic,
      notFound: true,
    })
  })
})
