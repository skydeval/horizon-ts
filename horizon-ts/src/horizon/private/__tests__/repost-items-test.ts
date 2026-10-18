import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))

import {
  type AdaptInput,
  repostReasonOf,
  toFeedViewPosts,
} from '#/horizon/private/adapt/feed-view'
import {keepsPrivatePost} from '#/horizon/private/feed/author-merge'
import {
  decodeMergeCursor,
  encodeMergeCursor,
  initialMergeState,
} from '#/horizon/private/feed/cursor'
import {
  feedItemKey,
  insertPending,
  itemKey,
  mergeStep,
  privateKey,
} from '#/horizon/private/feed/merge-core'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {type app} from '#/lexicons'
import {type PendingPost} from '../store'
import {DID, OTHER_DID, privateUri, RECORD_CID} from './fixtures'
import {at, fakeAppview, fakePrism, privateView} from './read-fixtures'

const REPOSTER = 'did:plc:reposteraaaaaaaaaaaaaaaa'

function repostOf(
  rkey: string,
  {
    minutes,
    by = REPOSTER,
    uri = true,
  }: {minutes: number; by?: string; uri?: boolean},
) {
  return {
    ...privateView(rkey, {minutes: 0}),
    reason: {
      $type: 'app.bsky.feed.defs#reasonRepost',
      by: {did: by, handle: 'reposter.test'},
      ...(uri
        ? {uri: `at://${by}/app.bsky.feed.repost/3krepost${minutes}`}
        : {}),
      indexedAt: at(minutes),
    },
  }
}

/** A view with a reason that is not a repost. */
function withReason(view: ReturnType<typeof privateView>) {
  const out = {...view, reason: {$type: 'app.bsky.feed.defs#reasonPin'}}
  return out
}

/** Adapt as the merges do, without network: every input to a feed item. */
function fakeAdapt(inputs: AdaptInput[]) {
  return Promise.resolve(
    inputs.map(input => {
      const reason = repostReasonOf(input.view)
      const item: app.bsky.feed.defs.FeedViewPost = {
        post: {uri: input.view.uri, cid: RECORD_CID} as never,
      }
      if (reason)
        item.reason = {...reason, $type: 'app.bsky.feed.defs#reasonRepost'}
      return item
    }),
  )
}

async function mergeOnly(priv: AdaptInput[], exclude: string[] = []) {
  const state = initialMergeState()
  state.pub.done = true
  state.priv.buf = priv
  state.priv.done = true
  state.exclude = exclude
  const {feed} = await mergeStep(
    state,
    {refillPublic: async () => {}, refillPrivate: async () => {}},
    {adapt: fakeAdapt},
  )
  return feed
}

beforeEach(() => {
  resetPrismFeatures()
  clearCurrentClients()
})

describe('repost items in the merges (2H design 6, T9)', () => {
  it('a repost sorts by its indexedAt, with a total order against its post', () => {
    const post = {view: privateView('3kaaa', {minutes: 0})}
    const repost = {view: repostOf('3kaaa', {minutes: 5})}
    expect(privateKey(repost).time).toBe(Date.parse(at(5)))
    expect(itemKey(post)).toBe(privateUri('3kaaa'))
    expect(itemKey(repost)).toBe(
      `${privateUri('3kaaa')}|repost|at://${REPOSTER}/app.bsky.feed.repost/3krepost5`,
    )
    // Without a repost URI the reposter's DID names it.
    expect(itemKey({view: repostOf('3kaaa', {minutes: 5, uri: false})})).toBe(
      `${privateUri('3kaaa')}|repost|${REPOSTER}`,
    )
  })

  it('a post and its repost in one batch both come out, once each, in order', async () => {
    const feed = await mergeOnly([
      {view: repostOf('3kaaa', {minutes: 5})},
      {view: privateView('3kaaa', {minutes: 0})},
    ])
    expect(feed.map(feedItemKey)).toEqual([
      `${privateUri('3kaaa')}|repost|at://${REPOSTER}/app.bsky.feed.repost/3krepost5`,
      privateUri('3kaaa'),
    ])
  })

  it('two reposts of one post by two accounts both come out', async () => {
    const feed = await mergeOnly([
      {view: repostOf('3kaaa', {minutes: 6, by: OTHER_DID})},
      {view: repostOf('3kaaa', {minutes: 5})},
    ])
    expect(feed).toHaveLength(2)
    expect(new Set(feed.map(feedItemKey)).size).toBe(2)
  })

  it("the pinned exclusion drops only the post's own item", async () => {
    const feed = await mergeOnly(
      [
        {view: repostOf('3kpin', {minutes: 5})},
        {view: privateView('3kpin', {minutes: 0})},
      ],
      [privateUri('3kpin')],
    )
    expect(feed).toHaveLength(1)
    expect(feed[0].reason).toBeDefined()
  })

  it('pending insertion counts only own items', () => {
    const buf: AdaptInput[] = [{view: repostOf('3kaaa', {minutes: 5})}]
    const entry = {
      uri: privateUri('3kaaa'),
      cid: RECORD_CID,
      did: DID,
      record: privateView('3kaaa').record,
      audienceUri: '',
      postView: {author: {did: DID, handle: 'a.test'}} as never,
      feedItem: {} as never,
      createdAt: at(1),
      expiresAt: Date.now() + 60_000,
    } as unknown as PendingPost
    insertPending(buf, [entry])
    expect(buf).toHaveLength(2)
  })

  it('the Posts filter is applied on the client only without private.paging', () => {
    const reply = privateView('3kreply', {
      reply: {
        root: {uri: privateUri('3kroot', OTHER_DID), cid: RECORD_CID},
        parent: {uri: privateUri('3kroot', OTHER_DID), cid: RECORD_CID},
      },
    })
    expect(keepsPrivatePost('posts', DID, reply.record)).toBe(false)
    publishCurrentClients({did: DID} as never)
    answerPrismFeatures(DID, ['private', 'private.paging'])
    expect(keepsPrivatePost('posts', DID, reply.record)).toBe(true)
  })

  it('the merge cursor keeps the reason', () => {
    const state = initialMergeState()
    state.priv.buf = [{view: repostOf('3kaaa', {minutes: 5})}]
    const back = decodeMergeCursor(encodeMergeCursor(state))
    expect(repostReasonOf(back.priv.buf[0].view)?.indexedAt).toBe(at(5))
  })
})

describe('repost items from the adapter (T9)', () => {
  it('builds a repost item with the reposter merged from the one profile fetch', async () => {
    const appview = fakeAppview({
      profiles: [
        {did: DID, handle: 'public-author.test'},
        {did: REPOSTER, handle: 'public-reposter.test', displayName: 'R'},
      ],
    })
    const items = await toFeedViewPosts(
      [
        {view: repostOf('3kaaa', {minutes: 5})},
        {view: privateView('3kaaa', {minutes: 0})},
      ],
      {prism: fakePrism().client, appview: appview.client},
    )
    expect(items).toHaveLength(2)
    const reason = items[0].reason as app.bsky.feed.defs.ReasonRepost
    expect(reason.$type).toBe('app.bsky.feed.defs#reasonRepost')
    expect(reason.by.handle).toBe('public-reposter.test')
    expect(items[0].post.author.handle).toBe('public-author.test')
    expect(items[1].reason).toBeUndefined()
    expect(
      appview.calls.filter(call => call.nsid === 'app.bsky.actor.getProfiles'),
    ).toHaveLength(1)
  })

  it('drops a view whose reason is not a repost', async () => {
    const items = await toFeedViewPosts(
      [{view: withReason(privateView('3kaaa'))}, {view: privateView('3kbbb')}],
      {prism: fakePrism().client, appview: fakeAppview().client},
    )
    expect(items.map(item => item.post.uri)).toEqual([privateUri('3kbbb')])
  })
})
