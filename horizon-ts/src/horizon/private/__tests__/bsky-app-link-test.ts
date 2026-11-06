import {describe, expect, it} from '@jest/globals'

import {makeProfileLink} from '#/lib/routes/links'
import {toBskyAppUrl, toShareUrl} from '#/lib/strings/url-helpers'
import {hidesBlueskyShare, postSegment} from '#/horizon/private/uri'

/*
 * "Copy bsky.app link to post": the same post on bsky.app, beside Horizon's
 * own link, and never for a kryphocron post (bsky.app has no page for it).
 */

const DID = 'did:plc:bsklinkaaaaaaaaaaaaaaaaa'
const author = {did: DID, handle: 'wren.example'}

describe('the bsky.app post link', () => {
  it('points at bsky.app while Horizon’s own link points at Horizon', () => {
    const uri = `at://${DID}/app.bsky.feed.post/3kbsky222222`
    const href = makeProfileLink(author, postSegment(uri), '3kbsky222222')
    expect(toBskyAppUrl(href)).toBe(
      'https://bsky.app/profile/wren.example/post/3kbsky222222',
    )
    expect(toShareUrl(href).startsWith('https://bsky.app')).toBe(false)
    expect(hidesBlueskyShare(uri)).toBe(false)
  })

  it('is never offered for a kryphocron post', () => {
    const uri = `at://${DID}/tools.kryphocron.feed.postPrivate/3kbsky222222`
    expect(hidesBlueskyShare(uri)).toBe(true)
  })
})
