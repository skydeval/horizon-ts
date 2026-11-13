import {afterEach, describe, expect, it} from '@jest/globals'

import {
  noteDroppedAccount,
  recentDroppedAccount,
  resetDroppedAccount,
} from '../dropped-account'

const DID = 'did:plc:dropped0000000000000001'

afterEach(() => resetDroppedAccount())

describe('quick reconnect', () => {
  it('remembers the account whose session just ended, briefly', () => {
    expect(recentDroppedAccount(1_000)).toBeUndefined()
    noteDroppedAccount(DID, 1_000)
    expect(recentDroppedAccount(1_000)).toBe(DID)
    expect(recentDroppedAccount(16_000)).toBe(DID)
    expect(recentDroppedAccount(16_001)).toBeUndefined()
  })

  it('keeps only the latest drop', () => {
    noteDroppedAccount('did:plc:first000000000000000001', 1_000)
    noteDroppedAccount(DID, 2_000)
    expect(recentDroppedAccount(2_000)).toBe(DID)
  })
})
