import {beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: jest.fn(),
  getSessionId: jest.fn(),
}))

import {getDeviceId, getSessionId} from '#/analytics/identifiers'
import {app} from '#/lexicons'
import {createLexClient} from './lexClient'

const fetchHandler = jest.fn(
  (_path: `/${string}`, _init: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({did: 'did:plc:alice', handle: 'alice.test'}),
        {headers: {'content-type': 'application/json'}},
      ),
    ),
)

function requestHeaders(call: number): Headers {
  return new Headers(fetchHandler.mock.calls[call][1].headers)
}

describe('createLexClient', () => {
  beforeEach(() => {
    fetchHandler.mockClear()
    jest.mocked(getDeviceId).mockReturnValue('device-123')
    jest.mocked(getSessionId).mockReturnValue('session-123')
  })

  // HORIZON: the analytics ids are never sent, even when a caller asks
  it('never sends the device or session identifier, even when asked', async () => {
    const client = createLexClient(
      {fetchHandler},
      {includeDeviceSessionHeaders: true},
    )

    await client.call(app.bsky.actor.getProfile, {actor: 'alice.test'})

    expect(requestHeaders(0).get('x-atproto-device-id')).toBeNull()
    expect(requestHeaders(0).get('x-atproto-session-id')).toBeNull()
  })

  it('omits identifiers by default', async () => {
    const client = createLexClient({fetchHandler})

    await client.call(app.bsky.actor.getProfile, {actor: 'alice.test'})

    expect(requestHeaders(0).get('x-atproto-device-id')).toBeNull()
    expect(requestHeaders(0).get('x-atproto-session-id')).toBeNull()
  })
})
