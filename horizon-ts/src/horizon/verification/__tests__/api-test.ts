import {describe, expect, it, jest} from '@jest/globals'

jest.mock('#/state/session/network', () => ({networkAwareFetch: jest.fn()}))
jest.mock('#/horizon/routing/prism', () => ({
  PRISM_URL: 'https://prism.example',
}))

import {HeldBadgesLoader} from '../api'

function answer(subjects: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify({subjects}), {status: 200}),
  )
}

describe('held badges loader', () => {
  it('asks once for every account rendered in a tick', async () => {
    const urls: URL[] = []
    const fetchImpl = ((url: URL) => {
      urls.push(url)
      return answer([
        {
          did: 'did:plc:a',
          badges: [
            {id: 'dev', issuer: 'did:web:v', uri: 'at://1', isValid: true},
          ],
        },
      ])
    }) as unknown as typeof fetch
    const loader = new HeldBadgesLoader(fetchImpl)
    const [a, b, again] = await Promise.all([
      loader.load('did:plc:a'),
      loader.load('did:plc:b'),
      loader.load('did:plc:a'),
    ])
    expect(urls).toHaveLength(1)
    expect(urls[0].pathname).toBe(
      '/xrpc/app.nearhorizon.verification.getSubjectBadges',
    )
    expect(urls[0].searchParams.getAll('dids')).toEqual([
      'did:plc:a',
      'did:plc:b',
    ])
    expect(a.map(h => h.id)).toEqual(['dev'])
    expect(again).toEqual(a)
    expect(b).toEqual([])

    // Kept for a minute: no second call
    expect(loader.peek('did:plc:a')).toEqual(a)
    await loader.load('did:plc:b')
    expect(urls).toHaveLength(1)
  })

  it('splits more than 100 accounts across calls', async () => {
    const sizes: number[] = []
    const fetchImpl = ((url: URL) => {
      sizes.push(url.searchParams.getAll('dids').length)
      return answer([])
    }) as unknown as typeof fetch
    const loader = new HeldBadgesLoader(fetchImpl)
    await Promise.all(
      Array.from({length: 150}, (_, i) => loader.load(`did:plc:${i}`)),
    )
    expect(sizes).toEqual([100, 50])
  })

  it('shows nothing and backs off when prism can’t answer', async () => {
    let calls = 0
    let now = 0
    const fetchImpl = (() => {
      calls++
      return Promise.resolve(new Response('', {status: 501}))
    }) as unknown as typeof fetch
    const loader = new HeldBadgesLoader(fetchImpl, () => now)
    expect(await loader.load('did:plc:a')).toEqual([])
    now = 60_000
    expect(await loader.load('did:plc:a')).toEqual([])
    expect(calls).toBe(1)
    now = 6 * 60_000
    await loader.load('did:plc:a')
    expect(calls).toBe(2)
  })
})
