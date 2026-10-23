/*
 * The account copy's storage-choice fields (appearance storage choice
 * design, section 4; build step AP-B1): parsed leniently, a value with none
 * of them reads as unresolved, and they round-trip.
 */

import {describe, expect, it} from '@jest/globals'

import {
  type AccountCopy,
  defaultDeviceValue,
  emptyAccountCopy,
  parseDeviceValue,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {DEFAULT_APPEARANCE} from '#/horizon/appearance/model'

function parseCopy(copy: Record<string, unknown>): AccountCopy {
  return parseDeviceValue(
    JSON.stringify({v: 1, accounts: {'did:plc:a': copy}}),
  ).accounts['did:plc:a']
}

describe('storage choice fields (AP-B1)', () => {
  it('a copy with none of them reads as unresolved', () => {
    const copy = parseCopy({
      record: {backdrop: 'pride.bi'},
      raw: {backdrop: 'pride.bi'},
      cid: 'bafy',
      syncedAt: 5,
    })
    expect(copy).toMatchObject({
      store: null,
      storeKnown: false,
      rev: null,
      recordDue: false,
      cleanup: null,
      noteDue: false,
      noted: false,
      memberDevice: false,
      removalNoted: false,
      removalLine: false,
      tooLarge: false,
      tooLargeLine: false,
    })
    // The size block is durable: it survives a relaunch.
    expect(parseCopy({tooLarge: true, tooLargeLine: true})).toMatchObject({
      tooLarge: true,
      tooLargeLine: true,
    })
  })

  it('parses each field leniently', () => {
    const copy = parseCopy({
      record: null,
      store: 'private',
      storeKnown: true,
      rev: 'rev-1',
      recordDue: true,
      cleanup: {cid: 'bafyc'},
      noteDue: true,
      noted: true,
      memberDevice: true,
      removalNoted: true,
      removalLine: true,
      pending: {
        fields: ['backdrop'],
        appearance: {backdrop: 'pride.ace'},
        seq: 3,
        store: 'public',
        auto: true,
      },
    })
    expect(copy).toMatchObject({
      store: 'private',
      storeKnown: true,
      rev: 'rev-1',
      recordDue: true,
      cleanup: {cid: 'bafyc'},
      noteDue: true,
      noted: true,
      memberDevice: true,
      removalNoted: true,
      removalLine: true,
    })
    expect(copy.pending).toMatchObject({seq: 3, store: 'public', auto: true})
    const odd = parseCopy({
      store: 'somewhere',
      storeKnown: true,
      rev: 7,
      recordDue: 'yes',
      cleanup: {cid: ''},
      memberDevice: 1,
      pending: {
        fields: [],
        appearance: {},
        seq: 1,
        store: 'cloud',
        auto: true,
      },
    })
    expect(odd.store).toBeNull()
    // Known only with a store.
    expect(odd.storeKnown).toBe(false)
    expect(odd.rev).toBeNull()
    expect(odd.recordDue).toBe(false)
    expect(odd.cleanup).toBeNull()
    expect(odd.memberDevice).toBe(false)
    // `auto` only with a store.
    expect(odd.pending).toEqual({
      fields: [],
      appearance: expect.anything(),
      seq: 1,
    })
    // `''` is a rev: a read that found no row.
    expect(parseCopy({rev: ''}).rev).toBe('')
  })

  it('round trips', () => {
    const copy: AccountCopy = {
      ...emptyAccountCopy(),
      record: DEFAULT_APPEARANCE,
      raw: {version: 1},
      syncedAt: 9,
      pending: {
        fields: ['custom'],
        appearance: DEFAULT_APPEARANCE,
        seq: 4,
        store: 'device',
        auto: true,
      },
      store: 'public',
      storeKnown: true,
      rev: '',
      recordDue: true,
      cleanup: {cid: 'bafyc'},
      noteDue: true,
      noted: true,
      memberDevice: true,
      removalNoted: true,
      removalLine: true,
      tooLarge: true,
      tooLargeLine: true,
    }
    const value = {...defaultDeviceValue(), accounts: {'did:plc:a': copy}}
    expect(parseDeviceValue(serializeDeviceValue(value))).toEqual(value)
  })
})
