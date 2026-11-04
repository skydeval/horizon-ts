/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Which accounts a Jetstream event may concern: the author of the post that
 * was replied to, quoted, liked or reposted, the root of a reply's thread,
 * anyone mentioned, and the account followed. Generous on purpose: a nudge
 * only tells the phone to check, and the AppView decides what is shown
 * (mutes, blocks, notification settings), so an extra nudge costs one quiet
 * check while a missed one loses a notification.
 */

type JetstreamEvent = {
  did?: unknown
  time_us?: unknown
  kind?: unknown
  commit?: {
    operation?: unknown
    collection?: unknown
    rkey?: unknown
    record?: unknown
  }
}

/**
 * One notification an event makes, for one account: what happened, who did
 * it, the record that did it and the post it concerns. All of it is public in
 * the event; the phone shows it at once, after its own mutes, blocks and
 * push settings, without waiting for the AppView to index it.
 */
export type Notice = {
  /** The account notified. */
  did: string
  /** As Bluesky's notification reasons. */
  reason: string
  /** The account that did it. */
  actor: string
  /** The record that did it (the like, the reply, the follow...). */
  uri: string
  /** The post it concerns: the liked or reposted post, or the parent. */
  subject?: string
  /** A reply's, mention's or quote's text, shortened. */
  text?: string
}

/** The most characters of post text a notice carries. */
export const NOTICE_TEXT_MAX = 300

const RKEY_RE = /^[a-zA-Z0-9._:~-]{1,512}$/

const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+(%3A[0-9]+)?)$/

function isDid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && DID_RE.test(value)
}

/** The repo DID of an at:// URI, or undefined. */
export function didOfUri(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('at://')) return undefined
  const end = uri.indexOf('/', 5)
  const did = uri.slice(5, end === -1 ? undefined : end)
  return isDid(did) ? did : undefined
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function subjectUri(record: Record<string, unknown>): unknown {
  return obj(record.subject)?.uri
}

/** The record a post's embed quotes, directly or beside media. */
function quotedUri(embed: Record<string, unknown> | undefined): unknown {
  if (!embed) return undefined
  const record = obj(embed.record)
  if (!record) return undefined
  // app.bsky.embed.record: {record: {uri}}; recordWithMedia: {record: {record: {uri}}}
  return record.uri ?? obj(record.record)?.uri
}

function mentionedDids(record: Record<string, unknown>): string[] {
  const out: string[] = []
  const facets = Array.isArray(record.facets) ? record.facets : []
  for (const facet of facets.slice(0, 100)) {
    const features = obj(facet)?.features
    if (!Array.isArray(features)) continue
    for (const feature of features.slice(0, 20)) {
      const f = obj(feature)
      if (f?.$type === 'app.bsky.richtext.facet#mention' && isDid(f.did)) {
        out.push(f.did)
      }
    }
  }
  return out
}

function shortText(record: Record<string, unknown>): string | undefined {
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (!text) return undefined
  const chars = [...text]
  return chars.length > NOTICE_TEXT_MAX ? `${chars.slice(0, NOTICE_TEXT_MAX - 1).join('')}…` : text
}

function isAtUri(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && didOfUri(value) !== undefined
}

/**
 * The notices an event makes, without its own author and one per account
 * (a reply beats a quote, which beats a mention). Only record creations
 * count.
 */
export function noticesOf(event: unknown): Notice[] {
  const e = obj(event) as JetstreamEvent | undefined
  if (!e || e.kind !== 'commit' || !isDid(e.did)) return []
  const actor = e.did
  const commit = obj(e.commit)
  if (!commit || commit.operation !== 'create') return []
  const record = obj(commit.record)
  const collection = commit.collection
  if (!record || typeof collection !== 'string' || typeof commit.rkey !== 'string') return []
  if (!RKEY_RE.test(commit.rkey)) return []
  const uri = `at://${actor}/${collection}/${commit.rkey}`

  const found: Notice[] = []
  const add = (did: unknown, reason: string, subject?: unknown, text?: string) => {
    if (!isDid(did) || did === actor || found.some(n => n.did === did)) return
    found.push({
      did,
      reason,
      actor,
      uri,
      ...(isAtUri(subject) ? {subject} : {}),
      ...(text ? {text} : {}),
    })
  }
  switch (collection) {
    case 'app.bsky.feed.like':
    case 'app.bsky.feed.repost': {
      const verb = collection === 'app.bsky.feed.like' ? 'like' : 'repost'
      const subject = subjectUri(record)
      add(didOfUri(subject), verb, subject)
      // Liked or reposted through someone's repost: they hear of it too
      const via = obj(record.via)?.uri
      add(didOfUri(via), `${verb}-via-repost`, via)
      break
    }
    case 'app.bsky.graph.follow':
      add(record.subject, 'follow')
      break
    case 'app.bsky.feed.post': {
      const text = shortText(record)
      const reply = obj(record.reply)
      if (reply) {
        const parent = obj(reply.parent)?.uri
        add(didOfUri(parent), 'reply', parent, text)
        add(didOfUri(obj(reply.root)?.uri), 'reply', parent, text)
      }
      const quoted = quotedUri(obj(record.embed))
      add(didOfUri(quoted), 'quote', quoted, text)
      for (const did of mentionedDids(record)) add(did, 'mention', uri, text)
      break
    }
  }
  return found
}

/** The accounts an event may concern, without its own author. */
export function targetsOf(event: unknown): string[] {
  return noticesOf(event).map(n => n.did)
}

/** The event's time cursor, or undefined. */
export function cursorOf(event: unknown): number | undefined {
  const t = obj(event)?.time_us
  return typeof t === 'number' && Number.isSafeInteger(t) && t > 0 ? t : undefined
}
