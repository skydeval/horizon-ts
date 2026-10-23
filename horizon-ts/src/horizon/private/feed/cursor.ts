/*
 * The Following merge's composite cursor: `hz1.<base64url(JSON)>`, carrying
 * the whole merge state, including the items fetched and not yet emitted. It
 * never leaves the client: it is the page param the feed query stores and
 * hands back, and only the stock cursors inside it reach the servers.
 *
 * The JSON is the atproto data model's (`lexStringify`/`lexParse`), so blob
 * refs in a buffered pending post survive the round trip.
 */

import {lexParse, lexStringify} from '@atproto/lex'

import {type AdaptInput} from '#/horizon/private/adapt/feed-view'
import {type app} from '#/lexicons'

export const MERGE_CURSOR_PREFIX = 'hz1.'

/**
 * Everything one page of the merge needs to continue.
 */
export type MergeState = {
  /** Public Following items, in the public page's order. */
  pub: {
    buf: app.bsky.feed.defs.FeedViewPost[]
    cursor: string | null
    done: boolean
  }
  /** Private views (and pending posts), in prism's order. */
  priv: {
    buf: AdaptInput[]
    cursor: string | null
    done: boolean
    failed: boolean
  }
  /** The stock Discover continuation, once Following has run out. */
  tail: {
    feed: app.bsky.feed.defs.FeedViewPost[]
    cursor: string | undefined
  } | null
  /**
   * Private URIs never emitted from the private side (the profile merge's
   * pinned private post, which its wrapper shows once at the top). Empty for
   * Following.
   */
  exclude: string[]
  /**
   * The public side resumes from a page's `startCursor` (item 7 3.3 step 6,
   * FP3-N9): the AppView bounds that on sort time alone, so the public posts
   * at the boundary time are skipped, and the fill or settle below carries
   * them (`carry.ts`, `carryGapBoundary`).
   */
  resumesAtBoundary?: true
}

export function initialMergeState(): MergeState {
  return {
    pub: {buf: [], cursor: null, done: false},
    priv: {buf: [], cursor: null, done: false, failed: false},
    tail: null,
    exclude: [],
  }
}

export function isMergeCursor(cursor: string | undefined): cursor is string {
  return !!cursor && cursor.startsWith(MERGE_CURSOR_PREFIX)
}

/** `text`'s UTF-8 bytes as unpadded base64url. */
export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The text `toBase64Url` encoded. */
export function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function encodeMergeCursor(state: MergeState): string {
  return MERGE_CURSOR_PREFIX + toBase64Url(lexStringify(state as never))
}

/**
 * The state a merge cursor carries. Throws on a cursor this client did not
 * make.
 */
export function decodeMergeCursor(cursor: string): MergeState {
  if (!isMergeCursor(cursor)) throw new Error('Not a merge cursor')
  const state = lexParse(
    fromBase64Url(cursor.slice(MERGE_CURSOR_PREFIX.length)),
  ) as unknown as MergeState
  if (
    typeof state !== 'object' ||
    state === null ||
    !Array.isArray(state.pub?.buf) ||
    !Array.isArray(state.priv?.buf)
  ) {
    throw new Error('Malformed merge cursor')
  }
  // A cursor made before `exclude` existed excludes nothing.
  if (!Array.isArray(state.exclude)) state.exclude = []
  return state
}

/** Whether `cursor` is a merge cursor that carries `resumesAtBoundary`. */
export function resumesAtBoundary(cursor: string | undefined): boolean {
  if (!isMergeCursor(cursor)) return false
  try {
    return decodeMergeCursor(cursor).resumesAtBoundary === true
  } catch {
    return false
  }
}

/*
 * The private marker (item 7 3.1): a member's Following `startCursor` is
 * `hz1s.<base64url(JSON)>`, carrying the stock `startCursor` and what a later
 * `since` fetch needs to offer the private posts newer than the page. Feed APIs
 * are stateless, so it all rides in the `since` the view hands back. The view
 * compares it only as a string; only `feed/` helpers decode it.
 */

export const MERGE_START_PREFIX = 'hz1s.'

/** How far below the newest private key a `since` fetch re-reads (3.1). */
export const PRIVATE_LOOKBACK_MS = 10 * 60_000

/** The most keys a marker's `seen` keeps (3.1's size guard). */
export const PRIVATE_SEEN_MAX = 200

/**
 * How the private walk of the `since` fetch that wrote a marker went, for the
 * prepend's judgement of the staged page it replaces (`carry.ts`,
 * `judgeStaged`). Absent from first pages.
 */
export type MergeStartWalk = {
  /** `none`: failed, timed out or skipped (no answer). */
  outcome: 'answered' | 'degraded' | 'none'
  /** The answer's account and `seq`, for `noteMiss`. */
  did: string
  seq: number
  /** The lowest time the walk covered; absent when it covered all above `floor`. */
  low?: number
  /** Own URIs the answer listed in `unavailable[]`. */
  unavailable?: string[]
  /** The answer said `degraded: true`: its omissions are signalled (busy 4). */
  signalled?: true
}

export type MergeStart = {
  /** The stock `startCursor`. */
  pub: string
  /** The newest private key fetched, capped at fetch time. */
  priv: {time: number; uri: string}
  /** No private item at or below this time is offered. */
  floor: number
  /** Keys with their times, in key order (newest first), all above `floor`. */
  seen: [key: string, time: number][]
  /** A degraded answer or a carry kept `priv` and `floor`. */
  held?: true
  /** See {@link MergeStartWalk}. */
  walk?: MergeStartWalk
}

export function isMergeStart(cursor: string | undefined): cursor is string {
  return !!cursor && cursor.startsWith(MERGE_START_PREFIX)
}

/**
 * `start` with the size guard applied (3.1): `seen` trimmed above `floor` and
 * to its newest {@link PRIVATE_SEEN_MAX} keys, `floor` raised past the keys it
 * drops, so nothing dropped is ever offered again.
 */
export function guardMergeStart(start: MergeStart): MergeStart {
  const sorted = start.seen
    .filter(([, time]) => time > start.floor)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
  let floor = start.floor
  let seen = sorted
  if (sorted.length > PRIVATE_SEEN_MAX) {
    floor = Math.max(floor, sorted[PRIVATE_SEEN_MAX][1])
    seen = sorted.filter(([, time]) => time > floor)
  }
  return {...start, floor, seen}
}

export function encodeMergeStart(start: MergeStart): string {
  return (
    MERGE_START_PREFIX + toBase64Url(JSON.stringify(guardMergeStart(start)))
  )
}

/** The marker `cursor` carries, or `undefined` for any other string. */
export function decodeMergeStart(
  cursor: string | undefined,
): MergeStart | undefined {
  if (!isMergeStart(cursor)) return undefined
  try {
    const start = JSON.parse(
      fromBase64Url(cursor.slice(MERGE_START_PREFIX.length)),
    ) as MergeStart
    if (
      typeof start !== 'object' ||
      start === null ||
      typeof start.pub !== 'string' ||
      typeof start.floor !== 'number' ||
      typeof start.priv?.time !== 'number' ||
      !Array.isArray(start.seen)
    ) {
      return undefined
    }
    return start
  } catch {
    return undefined
  }
}

/** Whether a page's `startCursor` is a held marker (3.4's peek skip). */
export function isHeldMarker(startCursor: string | undefined): boolean {
  return decodeMergeStart(startCursor)?.held === true
}
