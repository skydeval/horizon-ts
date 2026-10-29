import {Client} from '@atproto/lex'
import {afterEach, describe, expect, it} from '@jest/globals'

import {isAppLabeler, isLabelerSubscribed} from '#/lib/moderation'
import {additionalModerationAuthoritiesFor} from '#/state/session/additional-moderation-authorities'
import {
  applyBskyModeration,
  BSKY_MODERATION_DID,
  bskyModerationApplied,
  refreshCountryLabelers,
} from '#/horizon/bsky-moderation/apply'
import {bskyModerationLock} from '#/horizon/bsky-moderation/lock'

/*
 * Turning Bluesky's moderation labeler off (skydeval, 2026-10-29): adults
 * can, minors can't; the country labelers stay.
 */

const GB = 'did:plc:gvkp7euswjjrctjmqwhhfzif'

describe('who may turn it off', () => {
  it('an adult by birthdate or by declared age', () => {
    const base = {declaredAdult: false, ageCheckLocks: false}
    expect(bskyModerationLock({...base, age: 18})).toBeNull()
    expect(bskyModerationLock({...base, age: undefined, declaredAdult: true}))
      .toBeNull()
  })

  it('not a minor, not an unknown age, not under the age check', () => {
    const base = {declaredAdult: false, ageCheckLocks: false}
    expect(bskyModerationLock({...base, age: 17})).toBe('underAge')
    // A saved birthdate wins over a declared-age flag
    expect(bskyModerationLock({...base, age: 16, declaredAdult: true})).toBe(
      'underAge',
    )
    expect(bskyModerationLock({...base, age: undefined})).toBe('noAge')
    expect(
      bskyModerationLock({age: 30, declaredAdult: true, ageCheckLocks: true}),
    ).toBe('ageCheck')
  })
})

describe('applying it', () => {
  const before = Client.appLabelers

  afterEach(() => {
    Client.configure({appLabelers: before})
  })

  it('takes only Bluesky’s labeler off, and puts it back first', () => {
    Client.configure({appLabelers: [BSKY_MODERATION_DID, GB]})
    expect(applyBskyModeration(true)).toBe(false)
    expect(applyBskyModeration(false)).toBe(true)
    expect(Client.appLabelers).toEqual([GB])
    expect(bskyModerationApplied()).toBe(false)
    expect(applyBskyModeration(false)).toBe(false)
    expect(applyBskyModeration(true)).toBe(true)
    expect(Client.appLabelers).toEqual([BSKY_MODERATION_DID, GB])
  })

  it('rebuilding the country labelers keeps Bluesky’s as it was', () => {
    Client.configure({appLabelers: [BSKY_MODERATION_DID, GB]})
    refreshCountryLabelers('US')
    expect(Client.appLabelers[0]).toBe(BSKY_MODERATION_DID)
    expect(Client.appLabelers).not.toContain(GB)
    Client.configure({appLabelers: [GB]})
    refreshCountryLabelers('US')
    expect(Client.appLabelers).not.toContain(BSKY_MODERATION_DID)
  })

  it('a US location gets no country labelers; unknown gets every one', () => {
    expect(additionalModerationAuthoritiesFor('US')).toEqual([])
    if (!__DEV__) {
      expect(additionalModerationAuthoritiesFor(undefined)).toContain(GB)
      expect(additionalModerationAuthoritiesFor('GB')).toEqual([GB])
    }
  })

  it('off, it is still the app’s own labeler, not subscribed', () => {
    Client.configure({appLabelers: [GB]})
    expect(isAppLabeler(BSKY_MODERATION_DID)).toBe(true)
    const opts = {prefs: {labelers: []}} as unknown as Parameters<
      typeof isLabelerSubscribed
    >[1]
    expect(isLabelerSubscribed(BSKY_MODERATION_DID, opts)).toBeFalsy()
    expect(isLabelerSubscribed(GB, opts)).toBe(true)
  })
})
