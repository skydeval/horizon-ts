/*
 * How unread counts read on badges. No imports, so any badge can use it.
 */

/**
 * The highest unread count a badge shows exactly; above it the badge shows
 * "999+".
 */
export const UNREAD_BADGE_CAP = 999

/**
 * A badge's text for `count` unread: `''` for none, the number up to
 * {@link UNREAD_BADGE_CAP}, then "999+".
 */
export function formatUnreadCount(count: number): string {
  if (!(count > 0)) return ''
  if (count > UNREAD_BADGE_CAP) return `${UNREAD_BADGE_CAP}+`
  return String(Math.floor(count))
}

/**
 * The count a badge's text stands for; "999+" reads as one more than the cap,
 * so adding to it stays above the cap.
 */
export function parseUnreadCount(value: string): number {
  if (value === '') return 0
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return 0
  return value.endsWith('+') ? parsed + 1 : parsed
}
