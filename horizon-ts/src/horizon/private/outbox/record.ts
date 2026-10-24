/*
 * The outbox's recovery record (2K design PA-28, the outbox entry): one
 * device key per entry, `horizon-outbox:<did>:<id>`, with enough to tell
 * whether the compose was posted and, if it was not, to keep its text in
 * Unsent. Never the encoded bytes, never media bytes.
 */

import {isValidRecordKey} from '@atproto/syntax'

import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {type Gif} from '#/features/gifPicker/types'
import {MAX_FRONTERS} from '#/horizon/identity/fronters'
import {type DraftPostSpoilers} from '#/horizon/media-spoilers/drafts'
import {type ComposeAudience} from '#/horizon/private/composer/state'
import {
  listLocalKeys,
  readLocal,
  writeLocalChecked,
} from '#/horizon/session/local-store'
import {type app} from '#/lexicons'
import {outboxRecordKey, outboxRecordPrefix} from './running'
import {isOutboxFailure, type OutboxFailure} from './texts'

/**
 * Where an entry stands. `queued` and `sending` are decidable (step 5);
 * `failed` is in Unsent; `undecided` waits for reads.
 */
export type OutboxState = 'queued' | 'sending' | 'failed' | 'undecided'

/**
 * The reply ref the composer opened with, without `moderation` (K9-N4).
 */
export type StoredReplyRef = {
  uri: string
  cid: string
  text: string
  author: app.bsky.actor.defs.ProfileViewBasic
  langs?: string[]
  embed?: app.bsky.feed.defs.PostView['embed']
}

/**
 * One post of the record, by position. No bytes: media are counts.
 */
export type OutboxRecordPost = {
  text: string
  /** The composer's facets as typed, for Edit. */
  facets?: unknown[]
  labels: string[]
  /** The quote and link URLs and the whole `Gif` (K9-N3). */
  refs: {quote?: string; link?: string; gif?: {gif: Gif; alt: string}}
  media: {images: number; video: boolean}
  spoilers: DraftPostSpoilers
}

export type OutboxRecord = {
  v: 1
  id: string
  did: string
  pressedAt: number
  rkeys: string[]
  state: OutboxState
  failure?: OutboxFailure
  /** The URIs known on the PDS, a prefix of the compose's in order. */
  present?: string[]
  /** Start of the latest PDS write that may still be in doubt (K9-L1). */
  lastWriteAt?: number
  lastWriteKind?: 'create' | 'delete'
  /** Set once Delete what was posted or Discard has begun (K10-L1). */
  deleting?: 'posted' | 'discard'
  /** Set with `undecided` after an unanswered write. */
  settleAfter?: number
  /**
   * A PDS write of this compose was made and answered before it failed:
   * Edit reads first (K11-L3). Kept apart from `lastWriteAt`, which only an
   * unanswered write leaves set.
   */
  madeWrite?: true
  langs?: string[]
  posts: OutboxRecordPost[]
  visibility: 'public' | 'private'
  audience: ComposeAudience
  locked: boolean
  /**
   * The member rkeys every post names as its fronters (Phase 5 8.3, B-11),
   * so a Retry or an Edit after a reload keeps them. Absent: none.
   */
  fronters?: string[]
  /** The post the compose replies to (its URI, kept apart from the ref). */
  replyToUri?: string
  replyTo?: StoredReplyRef
  gates: {
    threadgate: ThreadgateAllowUISetting[]
    postgate: app.bsky.feed.postgate.Main
  }
  sourceDraft?: {draftId: string; localRefs: string[]}
  /** The id of the entry an Edit replaced. */
  replaces?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STATES: readonly OutboxState[] = [
  'queued',
  'sending',
  'failed',
  'undecided',
]

/**
 * A stored record, checked enough to be acted on; `undefined` for anything
 * else (a malformed or foreign value is left alone).
 */
export function parseOutboxRecord(raw: string | undefined) {
  if (!raw) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isObject(value) || value.v !== 1) return undefined
  if (typeof value.id !== 'string' || typeof value.did !== 'string') {
    return undefined
  }
  if (!Array.isArray(value.rkeys) || !Array.isArray(value.posts)) {
    return undefined
  }
  if (!STATES.includes(value.state as OutboxState)) return undefined
  if (value.failure !== undefined && !isOutboxFailure(value.failure)) {
    return undefined
  }
  if (!isObject(value.gates) || !isObject(value.audience)) return undefined
  return value as unknown as OutboxRecord
}

export function readOutboxRecord(did: string, id: string) {
  return parseOutboxRecord(readLocal(outboxRecordKey(did, id)))
}

/**
 * Every record of `did`. A record an Edit replaced is left out while the
 * record that replaced it exists (the replacement's commit point).
 */
export function listOutboxRecords(did: string): OutboxRecord[] {
  const records = listLocalKeys(outboxRecordPrefix(did))
    .map(key => parseOutboxRecord(readLocal(key)))
    .filter((record): record is OutboxRecord => !!record && record.did === did)
  const replaced = new Set(
    records.map(record => record.replaces).filter(id => !!id),
  )
  return records
    .filter(record => !replaced.has(record.id))
    .sort((a, b) => a.pressedAt - b.pressedAt)
}

/**
 * The DIDs that have outbox records on this device.
 */
export function outboxRecordDids(): string[] {
  const dids = new Set<string>()
  for (const key of listLocalKeys('horizon-outbox:')) {
    const rest = key.slice('horizon-outbox:'.length)
    const at = rest.lastIndexOf(':')
    if (at > 0) dids.add(rest.slice(0, at))
  }
  return Array.from(dids)
}

/**
 * Write a record, checked (write, read back): `false` when it was not saved.
 */
export function saveOutboxRecord(record: OutboxRecord): boolean {
  return writeLocalChecked(
    outboxRecordKey(record.did, record.id),
    JSON.stringify(record),
  )
}

/**
 * Remove a record: `false` when the removal could not be confirmed.
 */
export function removeOutboxRecord(did: string, id: string): boolean {
  return writeLocalChecked(outboxRecordKey(did, id), undefined)
}

/**
 * The record's fronters: valid member rkeys only (at most 20), so a
 * malformed stored value writes none rather than a bad key.
 */
export function recordFronters(record: OutboxRecord): string[] {
  const value = record.fronters
  if (!Array.isArray(value)) return []
  const rkeys = value.filter(
    (rkey): rkey is string =>
      typeof rkey === 'string' && isValidRecordKey(rkey),
  )
  return [...new Set(rkeys)].slice(0, MAX_FRONTERS)
}

/**
 * The URI of each post of the record, in order.
 */
export function recordUris(record: {did: string; rkeys: readonly string[]}) {
  return record.rkeys.map(
    rkey => `at://${record.did}/tools.kryphocron.feed.postPrivate/${rkey}`,
  )
}

/**
 * Whether the record lists any media.
 */
export function recordHasMedia(
  record: OutboxRecord,
  postIndexes?: readonly number[],
): boolean {
  return record.posts.some(
    (post, index) =>
      (!postIndexes || postIndexes.includes(index)) &&
      (post.media.images > 0 || post.media.video),
  )
}

/**
 * Whether a media spoiler flag was set on any post.
 */
export function recordHasMediaFlags(record: OutboxRecord): boolean {
  return record.posts.some(
    post => post.spoilers.images.length > 0 || post.spoilers.video,
  )
}

/**
 * Whether `present` is posts 1 to k of the record (PA-28 step 4).
 */
export function presentIsPrefix(record: OutboxRecord): boolean {
  const uris = recordUris(record)
  const present = record.present ?? []
  return present.every((uri, index) => uris[index] === uri)
}
