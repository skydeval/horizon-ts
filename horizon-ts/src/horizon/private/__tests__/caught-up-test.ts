import {afterEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {requestRecordCaughtUp} from '../api/request-record'
import {DID, fakeClient, privateUri, type Reply} from './fixtures'

const POST = privateUri('3kpost222222')

function prismAnswering(reply: Reply) {
  return fakeClient(DID, () => reply).client
}

afterEach(() => {
  jest.useRealTimers()
})

describe('requestRecordCaughtUp (2H design 5.7, T8)', () => {
  it('is true only for caughtUp: true', async () => {
    expect(
      await requestRecordCaughtUp(
        prismAnswering({
          status: 200,
          body: {status: 'indexed', caughtUp: true},
        }),
        POST,
      ),
    ).toBe(true)
  })

  it('is false for false, an absent field, and an error', async () => {
    for (const reply of [
      {status: 200, body: {status: 'indexed', caughtUp: false}},
      {status: 200, body: {status: 'indexed'}},
      {status: 400, body: {error: 'InvalidRequest'}},
    ]) {
      expect(await requestRecordCaughtUp(prismAnswering(reply), POST)).toBe(
        false,
      )
    }
  })

  it('is false after the deadline, and never throws', async () => {
    const hanging = {
      call: () => new Promise(() => {}),
    } as unknown as Parameters<typeof requestRecordCaughtUp>[0]
    jest.useFakeTimers()
    const result = requestRecordCaughtUp(hanging, POST, {deadlineMs: 3_000})
    await jest.advanceTimersByTimeAsync(3_000)
    expect(await result).toBe(false)
  })
})
