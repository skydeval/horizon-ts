/*
 * Readable messages for a blob upload the server would not take: a rate
 * limit (429) or a gateway or load answer (502, 503, 504). The lex client's
 * own message for a non-XRPC body ("Upstream server responded with a 429
 * error") names no cause and no wait. Public and private posting both upload
 * through `com.atproto.repo.uploadBlob` (images, gallery items, video
 * captions, GIF and link-card thumbnails), so the composer asks here first.
 */

import {XrpcResponseError} from '@atproto/lex'
import {plural, t} from '@lingui/core/macro'

const UPLOAD_BLOB = 'com.atproto.repo.uploadBlob'

const BUSY_STATUSES = new Set([502, 503, 504])

/**
 * The wait a `Retry-After` value asks for, in milliseconds: a number of
 * seconds or an HTTP date. `undefined` when absent, unreadable or not in the
 * future.
 */
export function retryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined
  const wait = /^\s*\d+\s*$/.test(value)
    ? Number(value) * 1000
    : new Date(value).getTime() - now
  return Number.isFinite(wait) && wait > 0 ? wait : undefined
}

/**
 * The message for an upload the server refused for load, or `undefined` when
 * `error` is not one (the stock message stands). On web the `Retry-After`
 * header is readable only when the server exposes it to CORS; without it
 * the message says "later".
 */
export function uploadErrorMessage(
  error: unknown,
  now: number = Date.now(),
): string | undefined {
  if (
    !(error instanceof XrpcResponseError) ||
    // The error's method is the lex client's own uploadBlob schema.
    (error.method as {nsid?: string}).nsid !== UPLOAD_BLOB
  ) {
    return undefined
  }
  if (error.status === 429) {
    const wait = retryAfterMs(error.headers.get('retry-after'), now)
    if (wait === undefined) {
      return t`The server is limiting uploads right now. Try again later.`
    }
    if (wait < 60_000) {
      return t`The server is limiting uploads right now. Try again in a moment.`
    }
    return plural(Math.ceil(wait / 60_000), {
      one: 'The server is limiting uploads right now. Try again in # minute.',
      other:
        'The server is limiting uploads right now. Try again in # minutes.',
    })
  }
  if (BUSY_STATUSES.has(error.status)) {
    return t`The server couldn’t take the upload right now. Try again in a moment.`
  }
  return undefined
}
