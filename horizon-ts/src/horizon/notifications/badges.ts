/*
 * The redesigned notifications' avatar badges (skydeval, 2026-10-26): a
 * quarter smaller than Bluesky's, so they sit quieter beside the avatar.
 * The icon keeps its share of the badge.
 */

import {CONVERSATION_BADGES} from '#/horizon/switches'

/** The badges' size against Bluesky's. */
export const NOTIFICATION_BADGE_SCALE = 0.75

/** A Bluesky badge measure at Horizon's scale, in whole pixels. */
export function badgeSize(stock: number): number {
  return Math.round(stock * NOTIFICATION_BADGE_SCALE)
}

/**
 * The badge a reply, quote or mention row shows: `icon` while
 * `CONVERSATION_BADGES` is on, none otherwise.
 */
export function conversationBadge<T>(
  icon: T,
  on: boolean = CONVERSATION_BADGES,
): T | undefined {
  return on ? icon : undefined
}
