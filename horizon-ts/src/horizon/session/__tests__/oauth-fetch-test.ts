import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

import {bufferedFetch} from '#/horizon/session/oauth-fetch'

// whatwg-fetch has no types; it is React Native's Response
const WhatwgResponse: typeof Response = (
  require('whatwg-fetch') as {Response: typeof Response}
).Response

/*
 * The app's OAuth client sends through `bufferedFetch`, so the library's
 * DPoP nonce check gets a plain React Native response (no stream body) and
 * its retry runs (bluesky-social/atproto#5627).
 */
describe('bufferedFetch', () => {
  const realFetch = globalThis.fetch
  const realResponse = globalThis.Response

  beforeEach(() => {
    // React Native's global Response is whatwg-fetch's
    globalThis.Response = WhatwgResponse
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    globalThis.Response = realResponse
  })

  function serverAnswers(status: number, json: unknown, headers = {}) {
    // A streaming response, as Expo's fetch returns
    const answer = jest.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new realResponse(JSON.stringify(json), {
          status,
          headers: {'content-type': 'application/json', ...headers},
        }),
      ),
    )
    globalThis.fetch = answer
  }

  it("gives the library a body it can peek at, with the server's nonce", async () => {
    serverAnswers(
      400,
      {error: 'use_dpop_nonce', error_description: 'nonce required'},
      {'DPoP-Nonce': 'abc123'},
    )
    const response = await bufferedFetch('https://pds.example/oauth/par', {
      method: 'POST',
      body: 'x=1',
    })
    expect(response).toBeInstanceOf(WhatwgResponse)
    // No stream body: the library's peekJson takes its plain path
    expect((response as {body?: unknown}).body).toBeUndefined()
    expect(response.status).toBe(400)
    expect(response.headers.get('DPoP-Nonce')).toBe('abc123')
    // peekJson's plain path for a response with no stream body
    expect(await response.clone().json()).toEqual({
      error: 'use_dpop_nonce',
      error_description: 'nonce required',
    })
    // Peeking leaves the body for the caller
    expect(await response.json()).toEqual({
      error: 'use_dpop_nonce',
      error_description: 'nonce required',
    })
  })

  it('keeps UTF-8 text whole: emoji, accents and other scripts', async () => {
    const profile = {displayName: 'Boobs✨ 🌸 é ñ 日本 👩🏽‍💻'}
    serverAnswers(200, profile)
    const response = await bufferedFetch('https://pds.example/xrpc/x')
    expect(await response.json()).toEqual(profile)
  })

  it('passes a response that is not JSON or text through untouched', async () => {
    const image = new realResponse(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: {'content-type': 'image/jpeg'},
    })
    globalThis.fetch = jest.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(image),
    )
    expect(await bufferedFetch('https://pds.example/blob')).toBe(image)
  })

  it('passes the request through unchanged', async () => {
    serverAnswers(200, {ok: true})
    const init = {method: 'POST', body: 'a=b'}
    const response = await bufferedFetch('https://pds.example/x', init)
    expect(globalThis.fetch).toHaveBeenCalledWith('https://pds.example/x', init)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ok: true})
  })
})
