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
    record?: unknown
  }
}

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

/**
 * The accounts an event may concern, without its own author. Only record
 * creations count.
 */
export function targetsOf(event: unknown): string[] {
  const e = obj(event) as JetstreamEvent | undefined
  if (!e || e.kind !== 'commit' || !isDid(e.did)) return []
  const commit = obj(e.commit)
  if (!commit || commit.operation !== 'create') return []
  const record = obj(commit.record)
  if (!record) return []

  const found: unknown[] = []
  switch (commit.collection) {
    case 'app.bsky.feed.like':
    case 'app.bsky.feed.repost':
      found.push(didOfUri(subjectUri(record)))
      break
    case 'app.bsky.graph.follow':
      found.push(record.subject)
      break
    case 'app.bsky.feed.post': {
      const reply = obj(record.reply)
      if (reply) {
        found.push(didOfUri(obj(reply.parent)?.uri))
        found.push(didOfUri(obj(reply.root)?.uri))
      }
      found.push(didOfUri(quotedUri(obj(record.embed))))
      found.push(...mentionedDids(record))
      break
    }
  }

  const targets = new Set<string>()
  for (const did of found) {
    if (isDid(did) && did !== e.did) targets.add(did)
  }
  return [...targets]
}

/** The event's time cursor, or undefined. */
export function cursorOf(event: unknown): number | undefined {
  const t = obj(event)?.time_us
  return typeof t === 'number' && Number.isSafeInteger(t) && t > 0 ? t : undefined
}
