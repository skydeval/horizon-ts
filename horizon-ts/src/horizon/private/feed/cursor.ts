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
