import {beforeAll, describe, expect, it} from '@jest/globals'
import {i18n} from '@lingui/core'

import {createLexClient} from '#/lib/lexClient'
import {com} from '#/lexicons'
import {retryAfterMs, uploadErrorMessage} from '../messages'

const NOW = Date.parse('2026-10-18T12:00:00.000Z')

beforeAll(() => {
  i18n.loadAndActivate({locale: 'en', messages: {}})
})

/**
 * A client whose every call is answered with a plain-text `status`, as
 * aurora answers a rate-limited upload (17 bytes, no XRPC body).
 */
function answering(status: number, headers: Record<string, string> = {}) {
  return createLexClient(
    {
      did: 'did:plc:alice',
      fetchHandler: () =>
        Promise.resolve(
          new Response('Too Many Requests', {
            status,
            headers: {'content-type': 'text/plain', ...headers},
          }),
        ),
    },
    {appLabelers: null},
  )
}

async function uploadError(
  status: number,
  headers: Record<string, string> = {},
): Promise<unknown> {
  return answering(status, headers)
    .uploadBlob(new Uint8Array([1, 2, 3]), {encoding: 'image/png'})
    .then(
      () => undefined,
      (e: unknown) => e,
    )
}

describe('uploadErrorMessage', () => {
  it('a 429 with Retry-After in seconds names the minutes, rounded up', async () => {
    expect(
      uploadErrorMessage(await uploadError(429, {'retry-after': '61'})),
    ).toBe('The server is limiting uploads right now. Try again in 2 minutes.')
    expect(
      uploadErrorMessage(await uploadError(429, {'retry-after': '60'})),
    ).toBe('The server is limiting uploads right now. Try again in 1 minute.')
    expect(
      uploadErrorMessage(await uploadError(429, {'retry-after': '600'})),
    ).toBe('The server is limiting uploads right now. Try again in 10 minutes.')
  })

  it('a 429 asking for under a minute says "in a moment"', async () => {
    expect(
      uploadErrorMessage(await uploadError(429, {'retry-after': '30'})),
    ).toBe('The server is limiting uploads right now. Try again in a moment.')
  })

  it('a 429 with an HTTP-date Retry-After counts from now', async () => {
    const error = await uploadError(429, {
      'retry-after': new Date(NOW + 5 * 60_000).toUTCString(),
    })
    expect(uploadErrorMessage(error, NOW)).toBe(
      'The server is limiting uploads right now. Try again in 5 minutes.',
    )
  })

  it('a 429 without a readable Retry-After says "later"', async () => {
    const later = 'The server is limiting uploads right now. Try again later.'
    expect(uploadErrorMessage(await uploadError(429))).toBe(later)
    expect(
      uploadErrorMessage(await uploadError(429, {'retry-after': 'soon'})),
    ).toBe(later)
    expect(
      uploadErrorMessage(await uploadError(429, {'retry-after': '0'})),
    ).toBe(later)
  })

  it('a 502, 503 or 504 on upload says the server could not take it', async () => {
    for (const status of [502, 503, 504]) {
      expect(uploadErrorMessage(await uploadError(status))).toBe(
        'The server couldn’t take the upload right now. Try again in a moment.',
      )
    }
  })

  it('leaves other upload errors and every other call to the stock message', async () => {
    expect(uploadErrorMessage(await uploadError(400))).toBeUndefined()
    expect(uploadErrorMessage(await uploadError(500))).toBeUndefined()
    const notUpload = await answering(429)
      .call(com.atproto.repo.getRecord, {
        repo: 'did:plc:alice',
        collection: 'app.bsky.feed.post',
        rkey: 'abc',
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(notUpload).toBeDefined()
    expect(uploadErrorMessage(notUpload)).toBeUndefined()
    expect(uploadErrorMessage(new Error('x'))).toBeUndefined()
    expect(uploadErrorMessage(undefined)).toBeUndefined()
  })
})

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates, and nothing else', () => {
    expect(retryAfterMs('90', NOW)).toBe(90_000)
    expect(retryAfterMs(new Date(NOW + 1000).toUTCString(), NOW)).toBe(1000)
    expect(
      retryAfterMs(new Date(NOW - 1000).toUTCString(), NOW),
    ).toBeUndefined()
    expect(retryAfterMs('', NOW)).toBeUndefined()
    expect(retryAfterMs(null, NOW)).toBeUndefined()
    expect(retryAfterMs('later', NOW)).toBeUndefined()
  })
})
