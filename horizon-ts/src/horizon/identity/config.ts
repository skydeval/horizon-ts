/*
 * The identity data layer's fixed values (Phase 5 design 4.4, 4.5, PP-23,
 * section 10). No state, no imports.
 */

/**
 * Development only, committed empty (P5R2-N1, Q16): the DIDs whose records
 * are read from their own PDS when prism's S-2 does not answer them. Only
 * skydeval's own DIDs ever go in it, locally and uncommitted, never another
 * person's (the Refract test account included). A test holds the committed
 * value empty.
 */
export const IDENTITY_PDS_FALLBACK_DIDS: readonly string[] = []

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** The S-2 batcher's window: asks within it go in one call (4.5). */
export const BATCH_WINDOW_MS = 50

/** prism's caps per `getRecords` call (15.1). */
export const MAX_CALL_DIDS = 50
export const MAX_CALL_MEMBERS = 100

/** Every read's timeout (4.5). */
export const READ_TIMEOUT_MS = 3 * SECOND

/** `listMembers` and own `listRecords` pages: size and count (4.5). */
export const MEMBER_PAGE_LIMIT = 100
export const MEMBER_PAGES_MAX = 10

/** The negative entry after an error, or at an episode's cap (4.5). */
export const NEGATIVE_MS = 60 * SECOND

/** The profile's and hover card's fresh-read floor (4.5, P5R4-L3). */
export const FRESH_READ_FLOOR_MS = 30 * SECOND

/**
 * Signed in (with a token): an unknown is asked again 5, 10, 20 and 40 s
 * after each answer, then every 60 s, with no ask sent more than 5 minutes
 * after the episode's first unknown (PP-23).
 */
export const SIGNED_IN_DELAYS_MS = [
  5 * SECOND,
  10 * SECOND,
  20 * SECOND,
  40 * SECOND,
  60 * SECOND,
] as const
export const SIGNED_IN_CAP_MS = 5 * MINUTE

/**
 * Signed out (no token): once 30 s after the answer, then every 5 minutes,
 * with no ask sent more than 15 minutes after the episode's first unknown
 * (skydeval, 2026-10-24).
 */
export const SIGNED_OUT_DELAYS_MS = [30 * SECOND, 5 * MINUTE] as const
export const SIGNED_OUT_CAP_MS = 15 * MINUTE

/** A 429's wait without a readable header, and the cap on any wait. */
export const RATE_LIMIT_DEFAULT_MS = 30 * SECOND
export const RATE_LIMIT_MAX_MS = 10 * MINUTE

/**
 * After prism refuses a fresh token (a second 401), S-2 reads that reader's
 * calls without auth for this long (P5R5-N4).
 */
export const NO_AUTH_WINDOW_MS = 10 * MINUTE

/** Stale times, by entry (4.5). */
export const STALE_MS = {
  pronouns: 5 * MINUTE,
  system: 5 * MINUTE,
  member: 5 * MINUTE,
  members: 5 * MINUTE,
  front: 2 * MINUTE,
} as const

/** gcTime, at least the persisted window (4.5, P5R1-N4). */
export const GC_MS = {
  pronouns: 24 * HOUR,
  system: 24 * HOUR,
  member: 24 * HOUR,
  members: 24 * HOUR,
  front: 5 * MINUTE,
} as const

/**
 * How long a cached answer keeps showing behind failing reads, from its
 * `dataUpdatedAt` (P5R2-Q2): 1 h for members and pronouns, 24 h for the
 * system record. The member list follows the members; the front, which is
 * not persisted, its own gcTime.
 */
export const FAILURE_CAP_MS = {
  pronouns: HOUR,
  system: 24 * HOUR,
  member: HOUR,
  members: HOUR,
  front: 5 * MINUTE,
} as const
