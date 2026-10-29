import {describe, expect, it} from '@jest/globals'

import {geolocationResponse} from '#/horizon/geolocation/handler'

/*
 * Web's rough location from Cloudflare, in Bluesky's service's shape, so a
 * visitor in Georgia gets the US and no other country's labelers.
 */

async function body(cf: Parameters<typeof geolocationResponse>[0]) {
  const res = geolocationResponse(cf)
  return {json: await res.json(), cache: res.headers.get('cache-control')}
}

describe('Horizon’s geolocation endpoint', () => {
  it('country and region from Cloudflare, never cached', async () => {
    expect(await body({country: 'US', regionCode: 'GA'})).toEqual({
      json: {countryCode: 'US', regionCode: 'GA'},
      cache: 'private, no-store',
    })
  })

  it('unknown, Tor and missing are unknown', async () => {
    expect((await body({country: 'XX'})).json).toEqual({})
    expect((await body({country: 'T1', regionCode: 'GA'})).json).toEqual({})
    expect((await body(undefined)).json).toEqual({})
  })

  it('a strange region is dropped, the country kept', async () => {
    expect((await body({country: 'DE', regionCode: 'not a code'})).json).toEqual(
      {countryCode: 'DE'},
    )
  })
})
