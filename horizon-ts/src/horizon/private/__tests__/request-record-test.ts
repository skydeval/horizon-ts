import {afterEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {logger} from '#/logger'
import {
  requestRecordCaughtUp,
  requestRecordQuietly,
} from '../api/request-record'
import {DID, fakeClient, privateUri, type Reply} from './fixtures'

/*
 * 2K design 6 (T-14, the helpers): a failed `requestRecord` is logged with
 * the error name and status only, never a server message, which can echo
 * what was sent.
 */
const SECRET = 'my private words'
const URI = privateUri('3kpost222222')

function failing(reply: Reply) {
  return fakeClient(DID, () => reply).client
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

function loggedValues(spy: {mock: {calls: unknown[][]}}): string {
  return JSON.stringify(spy.mock.calls)
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('the requestRecord helpers’ logs', () => {
  it('requestRecordQuietly logs the name and status, never the message', async () => {
    const warn = jest.spyOn(logger, 'warn')
    requestRecordQuietly(
      failing({
        status: 429,
        body: {error: 'RateLimitExceeded', message: SECRET},
      }),
      URI,
    )
    await settle()
    expect(warn).toHaveBeenCalledWith('requestRecord failed', {
      uri: URI,
      name: 'RateLimitExceeded',
      status: 429,
    })
    expect(loggedValues(warn)).not.toContain(SECRET)
  })

  it('requestRecordCaughtUp logs the same way and answers false', async () => {
    const warn = jest.spyOn(logger, 'warn')
    const caughtUp = await requestRecordCaughtUp(
      failing({
        status: 500,
        body: {error: 'InternalServerError', message: SECRET},
      }),
      URI,
    )
    expect(caughtUp).toBe(false)
    expect(warn).toHaveBeenCalledWith('requestRecord failed', {
      uri: URI,
      name: 'InternalServerError',
      status: 500,
    })
    expect(loggedValues(warn)).not.toContain(SECRET)
  })

  it('a network error is logged by its class', async () => {
    const warn = jest.spyOn(logger, 'warn')
    requestRecordQuietly(failing(new TypeError(SECRET)), URI)
    await settle()
    expect(loggedValues(warn)).not.toContain(SECRET)
    expect(warn).toHaveBeenCalledWith(
      'requestRecord failed',
      expect.objectContaining({uri: URI}),
    )
  })
})
