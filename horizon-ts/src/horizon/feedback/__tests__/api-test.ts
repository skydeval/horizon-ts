import {XrpcResponseError} from '@atproto/lex'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Feedback calls: a report goes to the push service through the account's
 * PDS, with technical details only when asked; a rate limit and a missing
 * session each say so; the inbox drops odd rows and reads 403 as "not an
 * admin". The PDS client is a fake; no network call is made.
 */

const mockCall = jest.fn<(...args: unknown[]) => Promise<unknown>>()
let mockClient: {call: typeof mockCall} | null = {call: mockCall}
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentPdsClient: () => mockClient,
}))

import {
  FeedbackError,
  listFeedback,
  readReports,
  sendFeedback,
} from '#/horizon/feedback/api'
import {HORIZON_PUSH_SERVICE} from '#/horizon/push/config'

function xrpcError(status: number, error: string) {
  return Object.create(XrpcResponseError.prototype, {
    status: {value: status},
    error: {value: error},
  }) as XrpcResponseError
}

beforeEach(() => {
  mockCall.mockReset()
  mockClient = {call: mockCall}
})

describe('sendFeedback', () => {
  it('sends trimmed text and the details when the box is ticked', async () => {
    mockCall.mockResolvedValue({id: 1})
    await sendFeedback({kind: 'bug', text: '  broken  ', includeDetails: true})
    const [, body, options] = mockCall.mock.calls[0]
    expect(body).toEqual(
      expect.objectContaining({
        kind: 'bug',
        text: 'broken',
        details: expect.objectContaining({version: expect.any(String)}),
      }),
    )
    expect(options).toEqual({service: HORIZON_PUSH_SERVICE})
  })

  it('leaves the details out when the box is clear', async () => {
    mockCall.mockResolvedValue({id: 1})
    await sendFeedback({kind: 'idea', text: 'themes', includeDetails: false})
    expect(mockCall.mock.calls[0][1]).toEqual({kind: 'idea', text: 'themes'})
  })

  it('says why a report could not be sent', async () => {
    mockCall.mockRejectedValue(xrpcError(429, 'RateLimitExceeded'))
    await expect(
      sendFeedback({kind: 'bug', text: 'x', includeDetails: false}),
    ).rejects.toEqual(new FeedbackError('rate-limited'))

    mockCall.mockRejectedValue(new Error('offline'))
    await expect(
      sendFeedback({kind: 'bug', text: 'x', includeDetails: false}),
    ).rejects.toMatchObject({reason: 'failed'})

    mockClient = null
    await expect(
      sendFeedback({kind: 'bug', text: 'x', includeDetails: false}),
    ).rejects.toMatchObject({reason: 'signed-out'})
  })
})

describe('the inbox', () => {
  it('keeps well-formed reports and only string details', () => {
    expect(
      readReports([
        {
          id: 2,
          did: 'did:plc:a',
          kind: 'bug',
          text: 'broken',
          createdAt: '2026-11-08T00:00:00.000Z',
          done: false,
          details: {version: '0.1.20', odd: 3},
        },
        {id: 'x', did: 'did:plc:a', kind: 'bug', text: 'bad id'},
        {id: 3, did: 'did:plc:a', kind: 'rant', text: 'bad kind'},
        null,
      ]),
    ).toEqual([
      {
        id: 2,
        did: 'did:plc:a',
        kind: 'bug',
        text: 'broken',
        createdAt: '2026-11-08T00:00:00.000Z',
        done: false,
        details: {version: '0.1.20'},
      },
    ])
  })

  it('reads a 403 as not an admin', async () => {
    mockCall.mockRejectedValue(xrpcError(403, 'Forbidden'))
    await expect(listFeedback()).resolves.toBe('forbidden')
  })

  it('passes the cursor and filter along', async () => {
    mockCall.mockResolvedValue({items: [], cursor: '5'})
    await expect(listFeedback({cursor: '9', done: false})).resolves.toEqual({
      reports: [],
      cursor: '5',
    })
    expect(mockCall.mock.calls[0][1]).toEqual({
      limit: 50,
      cursor: '9',
      done: false,
    })
  })
})
