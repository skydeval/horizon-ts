import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Device and session identifiers exist on this device, so their absence from
 * a request is the client's doing, not an empty store.
 */
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
const sent: {url: string; headers: Headers}[] = []
function mockRecord(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : undefined
  let url: string
  if (input instanceof Request) url = input.url
  else if (input instanceof URL) url = input.href
  else url = input
  sent.push({
    url,
    headers: new Headers(request ? request.headers : init?.headers),
  })
  return Promise.resolve(
    new Response(JSON.stringify({feed: []}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    }),
  )
}
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    mockRecord(input, init),
}))
jest.mock('#/state/session', () => ({
  useMaybePdsClient: () => null,
}))

import {createLexClient} from '#/lib/lexClient'
import {app} from '#/lexicons'
import {
  getPrismClient,
  getSignedOutPrismClient,
  PRISM_SERVICE,
  PRISM_URL,
} from '../prism'

beforeEach(() => {
  sent.length = 0
})

describe('prism clients', () => {
  it('the signed-out client sends no device, session or authorization header', async () => {
    await getSignedOutPrismClient().call(app.bsky.feed.getTimeline, {limit: 1})
    expect(sent).toHaveLength(1)
    expect(sent[0].url.startsWith(PRISM_URL)).toBe(true)
    expect(sent[0].headers.has('x-atproto-device-id')).toBe(false)
    expect(sent[0].headers.has('x-atproto-session-id')).toBe(false)
    expect(sent[0].headers.has('authorization')).toBe(false)
    expect(sent[0].headers.has('atproto-proxy')).toBe(false)
  })

  it('the device headers would be sent by a client that asked for them', async () => {
    // Guards the test above against passing for the wrong reason.
    const withHeaders = createLexClient(
      {service: PRISM_URL, fetch: mockRecord},
      {includeDeviceSessionHeaders: true},
    )
    await withHeaders.call(app.bsky.feed.getTimeline, {limit: 1})
    expect(sent[0].headers.get('x-atproto-device-id')).toBe('device-id-1')
  })

  it('the signed-in client proxies through the PDS agent to prism, cached per PDS client', async () => {
    const pdsClient = createLexClient(
      {service: 'https://pds.example', fetch: mockRecord},
      {appLabelers: null},
    )
    const prism = getPrismClient(pdsClient)
    expect(getPrismClient(pdsClient)).toBe(prism)
    await prism.call(app.bsky.feed.getTimeline, {limit: 1})
    expect(sent[0].url.startsWith('https://pds.example/')).toBe(true)
    expect(sent[0].headers.get('atproto-proxy')).toBe(PRISM_SERVICE)
    expect(PRISM_SERVICE).toBe('did:web:api.nearhorizon.app#bsky_appview')
  })
})
