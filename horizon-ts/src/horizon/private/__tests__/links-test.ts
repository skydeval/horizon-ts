import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => mockMembership,
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did && mockMembership === 'member',
}))

import {toBskyAppUrl, toShareUrl} from '#/lib/strings/url-helpers'
import {
  clearCurrentClients,
  PrivateClientUnavailableError,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  fetchPrivatePost,
  isPrivatePostLink,
  resolvePrivatePostLink,
} from '../links'
import {clearPrivateStores} from '../store'
import {
  hidesBlueskyShare,
  isPrivateRead,
  navigateToPost,
  postThreadRouteName,
} from '../uri'
import {DID, OTHER_DID, privateUri} from './fixtures'
import {fakeAppview, fakePrism, privateView} from './read-fixtures'

const PUBLIC_URI = `at://${DID}/app.bsky.feed.post/3kaaa`

function publish(posts = [privateView('3kaaa', {did: OTHER_DID})]) {
  const prism = fakePrism({posts})
  const appview = fakeAppview({handles: {'owner.test': OTHER_DID}})
  publishCurrentClients({
    did: DID,
    handle: 'me.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: appview.client,
  })
  return {prism, appview}
}

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
  mockMembership = 'member'
})

describe('thread routes', () => {
  it('names the private thread route for a private post only', () => {
    expect(postThreadRouteName(privateUri('3kaaa'))).toBe('PrivatePostThread')
    expect(postThreadRouteName(PUBLIC_URI)).toBe('PostThread')
    expect(postThreadRouteName(undefined)).toBe('PostThread')
  })

  it('navigates to the route the collection needs', () => {
    const navigate = jest.fn()
    navigateToPost({navigate} as never, privateUri('3kaaa'))
    navigateToPost({navigate} as never, PUBLIC_URI)
    expect(navigate.mock.calls).toEqual([
      ['PrivatePostThread', {name: DID, rkey: '3kaaa'}],
      ['PostThread', {name: DID, rkey: '3kaaa'}],
    ])
  })

  it('reads a private post through prism and leaves Bluesky’s share items off it', () => {
    expect(isPrivateRead(privateUri('3kaaa'))).toBe(true)
    expect(isPrivateRead(PUBLIC_URI)).toBe(false)
    expect(hidesBlueskyShare(privateUri('3kaaa'))).toBe(true)
    expect(hidesBlueskyShare(PUBLIC_URI)).toBe(false)
  })
})

describe('share links', () => {
  it('puts every path on nearhorizon.app, private posts included', () => {
    expect(toShareUrl('/profile/a.test/ppost/3kaaa')).toBe(
      'https://nearhorizon.app/profile/a.test/ppost/3kaaa',
    )
    expect(toShareUrl('/profile/a.test/ppost/3kaaa/liked-by')).toBe(
      'https://nearhorizon.app/profile/a.test/ppost/3kaaa/liked-by',
    )
    // 2026-10-27 (skydeval): public posts, profiles, feeds and lists too.
    expect(toShareUrl('/profile/a.test/post/3kaaa')).toBe(
      'https://nearhorizon.app/profile/a.test/post/3kaaa',
    )
    expect(toShareUrl('/profile/a.test')).toBe(
      'https://nearhorizon.app/profile/a.test',
    )
    expect(toShareUrl('/profile/a.test/feed/cats')).toBe(
      'https://nearhorizon.app/profile/a.test/feed/cats',
    )
  })

  it('leaves an absolute link alone, and keeps bsky.app for Bluesky services', () => {
    expect(toShareUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(toBskyAppUrl('/profile/a.test/post/3kaaa')).toBe(
      'https://bsky.app/profile/a.test/post/3kaaa',
    )
  })
})

describe('the post query for a private post', () => {
  it('reads it through prism, resolving a handle authority first', async () => {
    publish()
    const post = await fetchPrivatePost(
      fakeAppview({handles: {'owner.test': OTHER_DID}}).client,
      `at://owner.test/tools.kryphocron.feed.postPrivate/3kaaa`,
    )
    expect(post?.uri).toBe(privateUri('3kaaa', OTHER_DID))
    expect(post?.$type).toBe('app.bsky.feed.defs#postView')
  })

  it('answers not found on a miss', async () => {
    publish([])
    const post = await fetchPrivatePost(
      fakeAppview().client,
      privateUri('3kmissing', OTHER_DID),
    )
    expect(post).toBeUndefined()
  })

  it('makes no prism request for a non-member', async () => {
    const {prism} = publish()
    mockMembership = 'not-member'
    const post = await fetchPrivatePost(
      fakeAppview().client,
      privateUri('3kaaa', OTHER_DID),
    )
    expect(post).toBeUndefined()
    expect(prism.calls).toEqual([])
  })

  it('throws PrivateClientUnavailableError when signed out', async () => {
    await expect(
      fetchPrivatePost(fakeAppview().client, privateUri('3kaaa', OTHER_DID)),
    ).rejects.toBeInstanceOf(PrivateClientUnavailableError)
  })
})

describe('pasted ppost links', () => {
  it('recognises a ppost thread URL on the three hosts', () => {
    expect(
      isPrivatePostLink('https://nearhorizon.app/profile/a.test/ppost/3kaaa'),
    ).toBe(true)
    expect(
      isPrivatePostLink('https://bsky.app/profile/a.test/ppost/3kaaa'),
    ).toBe(true)
    expect(
      isPrivatePostLink('https://bsky.app/profile/a.test/post/3kaaa'),
    ).toBe(false)
  })

  it('resolve to a quote of the adapted post', async () => {
    const {appview} = publish()
    const res = await resolvePrivatePostLink(
      appview.client,
      'https://nearhorizon.app/profile/owner.test/ppost/3kaaa',
    )
    expect(res).toMatchObject({
      type: 'record',
      kind: 'post',
      record: {uri: privateUri('3kaaa', OTHER_DID)},
    })
  })

  it('throw on a miss, as an unresolvable post URL does', async () => {
    const {appview} = publish([])
    await expect(
      resolvePrivatePostLink(
        appview.client,
        `https://nearhorizon.app/profile/${OTHER_DID}/ppost/3kmissing`,
      ),
    ).rejects.toThrow('post not found')
  })
})
