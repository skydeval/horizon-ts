/*
 * Drafts keep their posting account (Phase 5 design 8.2 Drafts, PA-10,
 * B-26). Bluesky's draft is stored under the account that opened the
 * composer and has no field for who it was written as, so Horizon keeps the
 * posting account's DID, handle and chosen member rkeys beside it, in a
 * device-local table per opening account, by draft id, as the visibility
 * table does (`private/composer/drafts.ts`).
 *
 * - **Captured when the save starts**, before its first await
 *   (`captureDraftPostingAs`), as the visibility is (P5R8-L1), and recorded
 *   once the draft id is known.
 * - **Restored before the draft's gates and audience apply**
 *   (`applyDraftPostingAs`), without the account-change reset: the draft's
 *   own reply settings and audience stand, and its members are held until
 *   that account's member list answers. An account not signed in here
 *   blocks Publish ("Written as @other..."). No entry: the current account,
 *   as a fresh compose starts.
 * - **Reply lists of another account are dropped on every restore**
 *   (`dropForeignListRules`, P5R3-L2, P5R4-L2), in the draft's record form,
 *   so removing the last rule leaves `[]`, "Nobody can reply", never anyone.
 */

import {AtUri} from '@atproto/syntax'

import {logger} from '#/logger'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {POSTING_AS} from '#/horizon/switches'
import {type app} from '#/lexicons'
import {
  getPostingState,
  type PostingDraftNote,
  updatePosting,
} from './compose-store'
import {restartAsCurrentAccount, restorePostingAccount} from './gates'

/** At most this many entries per opening account; oldest dropped first. */
export const MAX_POSTING_DRAFT_ENTRIES = 200

/** One draft's posting account. */
export type PostingDraftEntry = {
  id: string
  did: string
  handle?: string
  members: string[]
}

function tableKey(openingDid: string) {
  return `horizon:draft-posting-as:${openingDid}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A stored entry, or `undefined` for one this build cannot read (which then
 * restores as the current account).
 */
function parseEntry(value: unknown): PostingDraftEntry | undefined {
  if (!isObject(value)) return undefined
  if (typeof value.id !== 'string' || typeof value.did !== 'string') {
    return undefined
  }
  if (!value.did.startsWith('did:')) return undefined
  const members = Array.isArray(value.members)
    ? value.members.filter((rkey): rkey is string => typeof rkey === 'string')
    : []
  return {
    id: value.id,
    did: value.did,
    ...(typeof value.handle === 'string' ? {handle: value.handle} : {}),
    members,
  }
}

function readRaw(openingDid: string): unknown[] {
  const raw = readLocal(tableKey(openingDid))
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as unknown[]) : []
  } catch (e) {
    logger.warn('draft posting-as table unreadable; starting over', {
      message: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}

/** The opening account's table, parsed. */
export function readPostingDraftTable(openingDid: string): PostingDraftEntry[] {
  return readRaw(openingDid)
    .map(parseEntry)
    .filter((entry): entry is PostingDraftEntry => !!entry)
}

/** The posting account a draft save started with. */
export type CapturedPostingAs = {
  openingDid: string
  entry: Omit<PostingDraftEntry, 'id'>
}

/**
 * Called when a draft save starts, before its first await: the opening
 * account and the posting choice at that moment, or `undefined` when there
 * is none to keep.
 */
export function captureDraftPostingAs(): CapturedPostingAs | undefined {
  const openingDid = getCurrentDid()
  const s = getPostingState()
  if (!POSTING_AS || !openingDid || !s.active || !s.did) return undefined
  return {
    openingDid,
    entry: {
      did: s.did,
      ...(s.handle ? {handle: s.handle} : {}),
      // Held members are the draft's own, not yet confirmed: kept as they are.
      members: [...(s.heldMembers ?? s.members)],
    },
  }
}

/**
 * Called after every draft save, once its id is known: records the captured
 * posting account under that id, in the opening account's table. Every
 * other entry is written back as it was read.
 */
export function recordDraftPostingAs(
  draftId: string,
  captured: CapturedPostingAs | undefined,
) {
  if (!POSTING_AS || !captured) return
  const others = readRaw(captured.openingDid).filter(
    value => !(isObject(value) && value.id === draftId),
  )
  const kept = [...others, {id: draftId, ...captured.entry}].slice(
    -MAX_POSTING_DRAFT_ENTRIES,
  )
  writeLocal(tableKey(captured.openingDid), JSON.stringify(kept))
}

/**
 * Called when a draft is restored, before `restore_from_draft` and the
 * visibility restore: sets the posting account without the reset. Returns
 * the posting DID the draft's reply settings are checked against
 * (`undefined` with the switch off: nothing is dropped, as stock).
 */
export function applyDraftPostingAs(draftId: string): string | undefined {
  const openingDid = getCurrentDid()
  if (!POSTING_AS || !openingDid) return undefined
  const s = getPostingState()
  if (!s.active) return openingDid
  const entry = readPostingDraftTable(openingDid).find(e => e.id === draftId)
  if (!entry) {
    restartAsCurrentAccount()
    return openingDid
  }
  restorePostingAccount(entry.did, entry.members, entry.handle)
  return entry.did
}

type AllowRules = app.bsky.draft.defs.Draft['threadgateAllow']

/** The DID that owns a list URI, or `undefined` when it does not parse. */
function listOwner(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

/**
 * The draft's `threadgateAllow` (record form) without the list rules whose
 * list is not `postingDid`'s. `allow` undefined (anyone) has nothing to
 * drop; removing the last rule leaves `[]` (nobody). `note` says what the
 * composer shows.
 */
export function dropForeignListRules(
  postingDid: string | undefined,
  allow: AllowRules,
): {allow: AllowRules; note: PostingDraftNote | undefined} {
  if (!allow || !postingDid) return {allow, note: undefined}
  const kept = allow.filter(rule => {
    const isList =
      isObject(rule) && rule.$type === 'app.bsky.feed.threadgate#listRule'
    return !isList || listOwner((rule as {list?: unknown}).list) === postingDid
  })
  if (kept.length === allow.length) return {allow, note: undefined}
  return {
    allow: kept,
    note: kept.length === 0 ? 'foreign-lists-nobody' : 'foreign-lists',
  }
}

/**
 * {@link dropForeignListRules} as the composer's restore uses it: the rules
 * kept, with the note set on the posting record.
 */
export function restoredThreadgateAllow(
  postingDid: string | undefined,
  allow: AllowRules,
): AllowRules {
  const dropped = dropForeignListRules(postingDid, allow)
  if (getPostingState().active) updatePosting({draftNote: dropped.note})
  return dropped.allow
}
