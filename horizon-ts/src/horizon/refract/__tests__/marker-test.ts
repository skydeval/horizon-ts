import {describe, expect, it} from '@jest/globals'

import {
  RF_LABELER,
  rfAuthorFeedPage,
  rfPost,
  rfProfile,
} from '#/horizon/refract/fixtures'
import {
  fromRefract,
  readRestored,
  REFRACT_SOURCE,
  stampOf,
  stampView,
} from '#/horizon/refract/marker'
import {normalizeRestored} from '#/horizon/refract/normalize'

/*
 * 11.1 "marker" and "stamp" (refract client design 3).
 */

describe('readRestored', () => {
  const view = (restored: unknown, extra: object = {}) => ({
    did: 'did:plc:x',
    handle: 'x.test',
    restored,
    ...extra,
  })

  it('reads a marker with and without a labeler', () => {
    expect(
      readRestored(view({community: 'c', tier: 1, labeler: RF_LABELER})),
    ).toEqual({community: 'c', tier: 1, labeler: RF_LABELER})
    expect(readRestored(view({community: 'c', tier: 2}))).toEqual({
      community: 'c',
      tier: 2,
    })
  })

  it('drops a labeler that is not a DID and keeps the marker', () => {
    expect(
      readRestored(view({community: 'c', tier: 1, labeler: 'nope'})),
    ).toEqual({
      community: 'c',
      tier: 1,
    })
  })

  it('is absent for anything else', () => {
    for (const restored of [
      true,
      'restored',
      {tier: 1},
      {community: 5, tier: 1},
      {community: 'c', tier: 0},
      {community: 'c', tier: 3},
      {community: 'c', tier: '1'},
      ['c', 1],
    ]) {
      expect(readRestored(view(restored))).toBeUndefined()
    }
    expect(readRestored(undefined)).toBeUndefined()
  })

  it('ignores a marker on gap and not-found nodes', () => {
    const marker = {community: 'c', tier: 1}
    for (const $type of [
      'app.bsky.feed.defs#notFoundPost',
      'app.bsky.feed.defs#blockedPost',
      'app.bsky.embed.record#viewNotFound',
      'app.bsky.embed.record#viewBlocked',
    ]) {
      expect(readRestored({$type, restored: marker})).toBeUndefined()
    }
    expect(readRestored({notFound: true, restored: marker})).toBeUndefined()
  })
})

describe('the stamp', () => {
  it('stamps every view in an answer, stock reposts and their authors included', () => {
    const page = rfAuthorFeedPage() as {
      feed: {post: Record<string, unknown>; reason?: {by: object}}[]
    }
    normalizeRestored(page, 'visitor')
    for (const item of page.feed) {
      expect(stampOf(item.post)).toBe('visitor')
      expect(stampOf(item.post.author)).toBe('visitor')
    }
    expect(stampOf(page.feed[1].reason!.by)).toBe('visitor')
    expect(readRestored(page.feed[1].post)).toBeUndefined()
    expect(fromRefract(page.feed[1].post)).toBe(true)
  })

  it('survives a spread (mergeShadow) and JSON drops it', () => {
    const post = rfPost('rf1')
    stampView(post, 'member', false)
    const spread = {...post, likeCount: 2}
    expect(stampOf(spread)).toBe('member')
    const profile = rfProfile()
    stampView(profile, 'visitor', false)
    expect(stampOf({...profile, viewer: {}})).toBe('visitor')
    expect(stampOf(JSON.parse(JSON.stringify(post)))).toBeUndefined()
    expect(Object.getOwnPropertySymbols(post)).toContain(REFRACT_SOURCE)
  })
})
