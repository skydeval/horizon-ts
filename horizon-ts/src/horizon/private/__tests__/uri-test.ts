import {describe, expect, it} from '@jest/globals'

import {
  isAudienceUri,
  isPrivatePostPath,
  isPrivatePostUri,
  isPrivatePostUrl,
  postSegment,
  privatePostPath,
  privateShareUrl,
} from '../uri'

const DID = 'did:plc:uriaaaaaaaaaaaaaaaaaaaaa'
const PRIVATE = `at://${DID}/tools.kryphocron.feed.postPrivate/3kabc123xyz22`
const PUBLIC = `at://${DID}/app.bsky.feed.post/3kabc123xyz22`

describe('isPrivatePostUri', () => {
  it('is true for a private post', () => {
    expect(isPrivatePostUri(PRIVATE)).toBe(true)
  })

  it('is false for a public post, malformed and absent URIs', () => {
    expect(isPrivatePostUri(PUBLIC)).toBe(false)
    expect(isPrivatePostUri('tools.kryphocron.feed.postPrivate')).toBe(false)
    expect(isPrivatePostUri('at://')).toBe(false)
    expect(
      isPrivatePostUri(`at://${DID}/tools.kryphocron.feed.postPrivate`),
    ).toBe(false)
    expect(isPrivatePostUri('')).toBe(false)
    expect(isPrivatePostUri(undefined)).toBe(false)
  })
})

describe('isAudienceUri', () => {
  it('needs a DID authority, the audience collection and an rkey', () => {
    expect(
      isAudienceUri(`at://${DID}/tools.kryphocron.policy.audience/3kaud`),
    ).toBe(true)
    expect(
      isAudienceUri('at://alice.test/tools.kryphocron.policy.audience/3kaud'),
    ).toBe(false)
    expect(isAudienceUri(`at://${DID}/app.bsky.graph.list/3kaud`)).toBe(false)
    expect(isAudienceUri(`at://${DID}/tools.kryphocron.policy.audience`)).toBe(
      false,
    )
  })
})

describe('postSegment', () => {
  it('is ppost for a private post and post otherwise', () => {
    expect(postSegment(PRIVATE)).toBe('ppost')
    expect(postSegment(PUBLIC)).toBe('post')
    expect(postSegment(undefined)).toBe('post')
  })

  it('a public and a private post with the same rkey get different paths', () => {
    const rkey = '3kabc123xyz22'
    expect(`/profile/alice.test/${postSegment(PRIVATE)}/${rkey}`).not.toBe(
      `/profile/alice.test/${postSegment(PUBLIC)}/${rkey}`,
    )
  })
})

describe('isPrivatePostPath', () => {
  it('matches the thread path and its three sub-routes', () => {
    expect(isPrivatePostPath('/profile/alice.test/ppost/3kabc')).toBe(true)
    expect(isPrivatePostPath('/profile/alice.test/ppost/3kabc/liked-by')).toBe(
      true,
    )
    expect(
      isPrivatePostPath('/profile/alice.test/ppost/3kabc/reposted-by'),
    ).toBe(true)
    expect(isPrivatePostPath('/profile/alice.test/ppost/3kabc/quotes')).toBe(
      true,
    )
  })

  it('does not match public or other paths', () => {
    expect(isPrivatePostPath('/profile/alice.test/post/3kabc')).toBe(false)
    expect(isPrivatePostPath('/profile/alice.test/ppost/3kabc/other')).toBe(
      false,
    )
    expect(isPrivatePostPath('/profile/alice.test')).toBe(false)
  })
})

describe('isPrivatePostUrl', () => {
  it('accepts nearhorizon.app, bsky.app and the page’s own host', () => {
    expect(
      isPrivatePostUrl('https://nearhorizon.app/profile/alice.test/ppost/3k'),
    ).toBe(true)
    expect(
      isPrivatePostUrl('https://bsky.app/profile/alice.test/ppost/3k'),
    ).toBe(true)
    const host = (globalThis as {window?: {location?: {host?: string}}}).window
      ?.location?.host
    if (host) {
      expect(
        isPrivatePostUrl(`http://${host}/profile/alice.test/ppost/3k`),
      ).toBe(true)
    }
  })

  it('rejects other hosts, sub-routes, public posts and garbage', () => {
    expect(
      isPrivatePostUrl('https://example.com/profile/alice.test/ppost/3k'),
    ).toBe(false)
    expect(
      isPrivatePostUrl(
        'https://nearhorizon.app/profile/alice.test/ppost/3k/liked-by',
      ),
    ).toBe(false)
    expect(
      isPrivatePostUrl('https://nearhorizon.app/profile/alice.test/post/3k'),
    ).toBe(false)
    expect(isPrivatePostUrl('not a url')).toBe(false)
  })
})

describe('paths and share links', () => {
  it('builds the ppost path and shares it on nearhorizon.app', () => {
    const path = privatePostPath('alice.test', '3kabc')
    expect(path).toBe('/profile/alice.test/ppost/3kabc')
    expect(privateShareUrl(path)).toBe(
      'https://nearhorizon.app/profile/alice.test/ppost/3kabc',
    )
  })
})
