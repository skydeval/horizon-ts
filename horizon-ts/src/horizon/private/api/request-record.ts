import {type Client} from '@atproto/lex'
import {type AtUriString} from '@atproto/syntax'

import {logger} from '#/logger'
import {nearhorizon} from '#/horizon/lexicons'

/**
 * Ask prism to index one record of the caller's own repo now, after every
 * private create, private delete and audience create. Never throws: a
 * failure (prism's rate limit included) is logged and ignored, because the
 * firehose delivers the record anyway. Callers do not wait on it.
 */
export function requestRecordQuietly(prismClient: Client, uri: string): void {
  prismClient
    .call(nearhorizon.requestRecord, {uri: uri as AtUriString})
    .catch((error: unknown) => {
      logger.warn('requestRecord failed', {
        uri,
        message: error instanceof Error ? error.message : String(error),
      })
    })
}

/**
 * Ask prism to index one record of the caller's own repo now and whether it
 * caught up (`private.freshIndex`, 2H design 5.7): `true` only for an answer
 * with `caughtUp: true` before `deadlineMs`, after which every private read
 * sees the record's state. `false` on `false`, an absent field (an older
 * prism), an error or the deadline. Never throws; failures are logged as
 * `requestRecordQuietly` logs them.
 */
export async function requestRecordCaughtUp(
  prismClient: Client,
  uri: string,
  {deadlineMs = 3_000}: {deadlineMs?: number} = {},
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), deadlineMs)
  })
  const request = prismClient
    .call(nearhorizon.requestRecord, {uri: uri as AtUriString})
    .then(
      res => res.caughtUp === true,
      (error: unknown) => {
        logger.warn('requestRecord failed', {
          uri,
          message: error instanceof Error ? error.message : String(error),
        })
        return false
      },
    )
  try {
    return await Promise.race([request, deadline])
  } finally {
    clearTimeout(timer)
  }
}
