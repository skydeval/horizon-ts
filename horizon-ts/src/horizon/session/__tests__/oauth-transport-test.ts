import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

const mockRestore =
  jest.fn<(did: string, refresh?: boolean) => Promise<unknown>>()
jest.mock('#/horizon/session/oauth-client', () => ({
  getOAuthClient: () => ({
    restore: (did: string, refresh?: boolean) => mockRestore(did, refresh),
  }),
}))
const mockLost = jest.fn<(did: string) => void>()
jest.mock('#/horizon/session/session-death', () => ({
  reportOAuthSessionLost: (did: string) => mockLost(did),
}))

import {
  createOAuthTransport,
  PROBE_WINDOW_MS,
  resetOAuthTransportProbes,
} from '../oauth-transport.web'

const DID = 'did:plc:transportaaaaaaaaaaaaaaa'

function xrpcResponse(status: number, error?: string) {
  return new Response(JSON.stringify(error ? {error, message: error} : {}), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

let now = 1_000_000
let responses: Response[] = []
let session: {
  fetchHandler: jest.Mock<
    (path: string, init?: RequestInit) => Promise<Response>
  >
  signOut: jest.Mock<() => Promise<void>>
}

function forcedRefreshes() {
  return mockRestore.mock.calls.filter(([, refresh]) => refresh === true).length
}

async function send(headers: Record<string, string> = {}) {
  const transport = createOAuthTransport(DID)
  return transport.fetchHandler('/xrpc/com.atproto.server.getSession', {
    headers,
  })
}

beforeEach(() => {
  now = 1_000_000
  jest.spyOn(Date, 'now').mockImplementation(() => now)
  resetOAuthTransportProbes()
  mockRestore.mockReset()
  mockLost.mockReset()
  responses = []
  session = {
    fetchHandler: jest.fn(() => {
      const next = responses.shift()
      if (!next) throw new Error('no response queued')
      return Promise.resolve(next)
    }),
    signOut: jest.fn(() => Promise.resolve()),
  }
  mockRestore.mockImplementation(() => Promise.resolve(session))
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('the OAuth transport 401 probe', () => {
  it('forces a refresh for a 401 without atproto-proxy, returning the response unchanged', async () => {
    responses.push(xrpcResponse(401, 'AuthenticationRequired'))
    const response = await send()
    expect(response.status).toBe(401)
    expect(forcedRefreshes()).toBe(1)
    expect(session.fetchHandler).toHaveBeenCalledTimes(1)
    expect(mockLost).not.toHaveBeenCalled()
  })

  it('does nothing for a 401 that carried atproto-proxy', async () => {
    responses.push(xrpcResponse(401, 'AuthenticationRequired'))
    await send({'atproto-proxy': 'did:web:api.example#bsky_appview'})
    expect(forcedRefreshes()).toBe(0)
    expect(mockLost).not.toHaveBeenCalled()
  })

  it('forces at most one refresh per DID per window', async () => {
    responses.push(
      xrpcResponse(401, 'SomethingElse'),
      xrpcResponse(401, 'SomethingElse'),
      xrpcResponse(401, 'SomethingElse'),
    )
    await send()
    now += 1_000
    await send()
    expect(forcedRefreshes()).toBe(1)
    now += PROBE_WINDOW_MS
    await send()
    expect(forcedRefreshes()).toBe(2)
    expect(mockLost).not.toHaveBeenCalled()
  })

  it.each(['AuthenticationRequired', 'InvalidToken', 'ExpiredToken'])(
    'a %s 401 after a successful forced refresh ends the session',
    async error => {
      responses.push(xrpcResponse(401, error), xrpcResponse(401, error))
      await send()
      now += 1_000
      await send()
      expect(session.signOut).toHaveBeenCalledTimes(1)
      expect(mockLost).toHaveBeenCalledWith(DID)
    },
  )

  it('a 403 or another 401 after a successful forced refresh ends nothing', async () => {
    responses.push(
      xrpcResponse(401, 'AuthenticationRequired'),
      xrpcResponse(403, 'InsufficientScope'),
      xrpcResponse(401, 'UpstreamFailure'),
    )
    await send()
    now += 1_000
    const forbidden = await send()
    expect(forbidden.status).toBe(403)
    now += 1_000
    await send()
    expect(session.signOut).not.toHaveBeenCalled()
    expect(mockLost).not.toHaveBeenCalled()
  })

  it('a token 401 outside the window forces a new refresh instead of ending', async () => {
    responses.push(
      xrpcResponse(401, 'AuthenticationRequired'),
      xrpcResponse(401, 'AuthenticationRequired'),
    )
    await send()
    now += PROBE_WINDOW_MS + 1
    await send()
    expect(session.signOut).not.toHaveBeenCalled()
    expect(mockLost).not.toHaveBeenCalled()
    expect(forcedRefreshes()).toBe(2)
  })

  it('a token 401 after a failed forced refresh ends nothing by itself', async () => {
    responses.push(
      xrpcResponse(401, 'AuthenticationRequired'),
      xrpcResponse(401, 'AuthenticationRequired'),
    )
    mockRestore.mockImplementation((_did, refresh) =>
      refresh === true
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(session),
    )
    await send()
    now += 1_000
    await send()
    expect(session.signOut).not.toHaveBeenCalled()
    expect(mockLost).not.toHaveBeenCalled()
  })

  it('a restore refused as an auth error reports the loss and rethrows', async () => {
    mockRestore.mockImplementation(() =>
      Promise.reject(new Error('The session was deleted by another process')),
    )
    await expect(send()).rejects.toThrow('deleted by another process')
    expect(mockLost).toHaveBeenCalledWith(DID)
    expect(session.fetchHandler).not.toHaveBeenCalled()
  })

  it('a restore that fails on the network is not a loss', async () => {
    mockRestore.mockImplementation(() =>
      Promise.reject(new Error('Failed to fetch')),
    )
    await expect(send()).rejects.toThrow('Failed to fetch')
    expect(mockLost).not.toHaveBeenCalled()
  })
})
