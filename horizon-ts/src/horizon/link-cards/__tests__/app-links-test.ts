import {describe, expect, it} from '@jest/globals'

import {getLinkMeta, LikelyType} from '#/lib/link-meta/link-meta'
import {
  convertBskyAppUrlIfNeeded,
  isBskyAppUrl,
  isBskyCustomFeedUrl,
  isBskyListUrl,
  isBskyPostUrl,
} from '#/lib/strings/url-helpers'

/*
 * A Horizon link is an app link, like bsky.app: a pasted post link quotes
 * the post (no link card), and feed and list links embed the same way.
 */

const POST = '/profile/alice.test/post/3kabcdefghij2'

describe('Horizon app links', () => {
  it('a Horizon post link is a post link', () => {
    expect(isBskyAppUrl(`https://nearhorizon.app${POST}`)).toBe(true)
    expect(isBskyPostUrl(`https://nearhorizon.app${POST}`)).toBe(true)
    expect(isBskyPostUrl(`https://bsky.app${POST}`)).toBe(true)
    expect(convertBskyAppUrlIfNeeded(`https://nearhorizon.app${POST}`)).toBe(
      POST,
    )
  })

  it('feeds and lists too', () => {
    expect(
      isBskyCustomFeedUrl(
        'https://nearhorizon.app/profile/alice.test/feed/cats',
      ),
    ).toBe(true)
    expect(
      isBskyListUrl('https://nearhorizon.app/profile/alice.test/lists/3kabc'),
    ).toBe(true)
  })

  it('a Horizon post link reads as the post, with no card fetch', async () => {
    const meta = await getLinkMeta(`https://nearhorizon.app${POST}`)
    expect(meta.likelyType).toBe(LikelyType.AtpData)
  })

  it('other hosts stay external', () => {
    expect(isBskyAppUrl(`https://nearhorizon.app.example.com${POST}`)).toBe(
      false,
    )
    expect(isBskyAppUrl(`https://example.com${POST}`)).toBe(false)
    expect(isBskyPostUrl(`http://nearhorizon.app${POST}`)).toBe(false)
    expect(isBskyPostUrl('https://nearhorizon.app/profile/alice.test')).toBe(
      false,
    )
  })
})
