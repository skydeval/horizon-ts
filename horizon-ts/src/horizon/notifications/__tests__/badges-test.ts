import {describe, expect, it} from '@jest/globals'

import {
  badgeSize,
  conversationBadge,
} from '#/horizon/notifications/badges'
import {CONVERSATION_BADGES, NEW_POST_BADGE} from '#/horizon/switches'

/*
 * 2026-10-27 (skydeval): reply, quote and mention rows lose their badge on
 * both notification tabs, as the new-post rows did on 2026-10-26.
 */

const ICON = () => null

describe('notification badges', () => {
  it('reply, quote and mention rows show no badge', () => {
    expect(CONVERSATION_BADGES).toBe(false)
    expect(conversationBadge(ICON)).toBeUndefined()
  })

  it('the switch brings Bluesky’s badge back', () => {
    expect(conversationBadge(ICON, true)).toBe(ICON)
  })

  it('new-post rows show none either', () => {
    expect(NEW_POST_BADGE).toBe(false)
  })

  it('badges are a quarter smaller than Bluesky’s', () => {
    expect(badgeSize(24)).toBe(18)
  })
})
