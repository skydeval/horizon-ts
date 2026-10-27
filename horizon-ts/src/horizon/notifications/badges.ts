/*
 * The redesigned notifications' avatar badges (skydeval, 2026-10-26): a
 * quarter smaller than Bluesky's, so they sit quieter beside the avatar.
 * The icon keeps its share of the badge.
 */

/** The badges' size against Bluesky's. */
export const NOTIFICATION_BADGE_SCALE = 0.75

/** A Bluesky badge measure at Horizon's scale, in whole pixels. */
export function badgeSize(stock: number): number {
  return Math.round(stock * NOTIFICATION_BADGE_SCALE)
}
