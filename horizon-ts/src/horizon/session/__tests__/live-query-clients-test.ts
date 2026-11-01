import {beforeEach, describe, expect, it, jest} from '@jest/globals'

import {
  forgetLiveQueryClient,
  MAX_LIVE_QUERY_CLIENTS,
  resetLiveQueryClients,
  takeLiveQueryClient,
} from '../live-query-clients'

const ALICE = 'did:plc:aliceaaaaaaaaaaaaaaaaaaa'
const BOB = 'did:plc:bobbbbbbbbbbbbbbbbbbbbbb'

let made = 0
function create() {
  made++
  return {id: made}
}

beforeEach(() => {
  resetLiveQueryClients()
  made = 0
})

describe('live query clients', () => {
  it('gives an account back the same client after a switch away', () => {
    const alice = takeLiveQueryClient(ALICE, create)
    const bob = takeLiveQueryClient(BOB, create)
    expect(takeLiveQueryClient(ALICE, create)).toBe(alice)
    expect(takeLiveQueryClient(BOB, create)).toBe(bob)
    expect(made).toBe(2)
  })

  it('never hands one account another account’s client', () => {
    const alice = takeLiveQueryClient(ALICE, create)
    expect(takeLiveQueryClient(BOB, create)).not.toBe(alice)
    expect(takeLiveQueryClient(undefined, create)).not.toBe(alice)
  })

  it('keeps the signed-out client apart from every account', () => {
    const out = takeLiveQueryClient(undefined, create)
    expect(takeLiveQueryClient(undefined, create)).toBe(out)
    expect(takeLiveQueryClient(ALICE, create)).not.toBe(out)
  })

  it('starts an account afresh once its client is forgotten', () => {
    const alice = takeLiveQueryClient(ALICE, create)
    forgetLiveQueryClient(ALICE)
    expect(takeLiveQueryClient(ALICE, create)).not.toBe(alice)
  })

  it('drops the least recently used account past the limit', () => {
    const dids = Array.from(
      {length: MAX_LIVE_QUERY_CLIENTS + 1},
      (_, i) => `did:plc:account${i}`,
    )
    const first = takeLiveQueryClient(dids[0], create)
    const second = takeLiveQueryClient(dids[1], create)
    // Using the first again makes the second the oldest
    takeLiveQueryClient(dids[0], create)
    for (const did of dids.slice(2)) takeLiveQueryClient(did, create)
    expect(takeLiveQueryClient(dids[0], create)).toBe(first)
    expect(takeLiveQueryClient(dids[1], create)).not.toBe(second)
  })
})

describe('clearing an account’s persisted cache', () => {
  it('forgets its live client too', async () => {
    jest.resetModules()
    jest.doMock('#/storage/archive/db', () => ({
      create: () => ({clear: () => Promise.resolve()}),
    }))
    const clients = await import('../live-query-clients')
    const storage = await import('#/lib/persisted-query-storage')
    const alice = clients.takeLiveQueryClient(ALICE, create)
    await storage.clearPersistedQueryStorage(ALICE)
    expect(clients.takeLiveQueryClient(ALICE, create)).not.toBe(alice)
  })
})
