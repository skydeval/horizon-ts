/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The account a "check" message names, from the background task's payload
 * (`{data: {...}}`, the fields sometimes packed in `data.dataString`).
 */
export function checkedDid(data: unknown): string | undefined {
  const fields = fieldsOf(data)
  if (!fields || fields.kind !== 'check') return undefined
  return isDid(fields.did) ? fields.did : undefined
}

function fieldsOf(data: unknown): Record<string, unknown> | undefined {
  const d = (data as {data?: Record<string, unknown>} | undefined)?.data
  if (!d || typeof d !== 'object') return undefined
  if (typeof d.dataString !== 'string') return d
  try {
    return JSON.parse(d.dataString) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function isDid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('did:') &&
    value.length <= 2048
  )
}

function isAtUri(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('at://did:') &&
    value.length <= 8192
  )
}

/** The reasons an event wake may carry. */
const EVENT_REASONS = new Set([
  'like',
  'repost',
  'follow',
  'mention',
  'reply',
  'quote',
  'like-via-repost',
  'repost-via-repost',
])

/**
 * What happened, when a check also carries it: the push service sends the
 * public details of the event, so the app can show it without waiting for
 * the AppView. The record's author must be `actor`.
 */
export type PushEvent = {
  did: string
  reason: string
  actor: string
  uri: string
  subject?: string
  text?: string
}

/** The event a check carries, or `undefined` for a plain check. */
export function pushEventOf(data: unknown): PushEvent | undefined {
  const f = fieldsOf(data)
  if (!f || f.kind !== 'check') return undefined
  const {did, reason, actor, uri, subject, text} = f
  if (!isDid(did) || !isDid(actor) || !isAtUri(uri)) return undefined
  if (typeof reason !== 'string' || !EVENT_REASONS.has(reason)) return undefined
  if (!uri.startsWith(`at://${actor}/`)) return undefined
  return {
    did,
    reason,
    actor,
    uri,
    ...(isAtUri(subject) ? {subject} : {}),
    ...(typeof text === 'string' && text.trim()
      ? {text: text.slice(0, 1000)}
      : {}),
  }
}
