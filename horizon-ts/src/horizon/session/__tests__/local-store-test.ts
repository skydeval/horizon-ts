import {MMKV} from 'react-native-mmkv'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'

import {
  listLocalKeys,
  readLocal,
  subscribeLocal,
  subscribeLocalPrefix,
  writeLocal,
  writeLocalChecked,
} from '#/horizon/session/local-store'

/*
 * The native local store keeps Horizon's device keys in MMKV, so they survive
 * the app closing. Under Jest, MMKV runs in memory.
 */
describe('native local store', () => {
  beforeEach(() => {
    for (const key of listLocalKeys('')) writeLocal(key, undefined)
  })

  it('keeps values in MMKV, not only in memory', () => {
    const set = jest.spyOn(MMKV.prototype, 'set')
    writeLocal('horizon:test', 'kept')
    expect(set).toHaveBeenCalledWith('horizon:test', 'kept')
    expect(readLocal('horizon:test')).toBe('kept')
    set.mockRestore()
  })

  it('reads, overwrites and removes a key', () => {
    expect(readLocal('horizon:a')).toBeUndefined()
    writeLocal('horizon:a', 'one')
    writeLocal('horizon:a', 'two')
    expect(readLocal('horizon:a')).toBe('two')
    writeLocal('horizon:a', undefined)
    expect(readLocal('horizon:a')).toBeUndefined()
  })

  it('checked writes answer true and read back', () => {
    expect(writeLocalChecked('horizon:outbox:1', '{"x":1}')).toBe(true)
    expect(readLocal('horizon:outbox:1')).toBe('{"x":1}')
    expect(writeLocalChecked('horizon:outbox:1', undefined)).toBe(true)
    expect(readLocal('horizon:outbox:1')).toBeUndefined()
  })

  it('lists keys by prefix', () => {
    writeLocal('horizon:outbox:1', 'a')
    writeLocal('horizon:outbox:2', 'b')
    writeLocal('horizon:drafts:1', 'c')
    expect(listLocalKeys('horizon:outbox:').sort()).toEqual([
      'horizon:outbox:1',
      'horizon:outbox:2',
    ])
  })

  it('tells key and prefix listeners about changes until unsubscribed', () => {
    const onKey = jest.fn()
    const onPrefix = jest.fn()
    const offKey = subscribeLocal('horizon:outbox:1', onKey)
    const offPrefix = subscribeLocalPrefix('horizon:outbox:', onPrefix)
    writeLocal('horizon:outbox:1', 'a')
    writeLocalChecked('horizon:outbox:2', 'b')
    writeLocal('horizon:drafts:1', 'c')
    expect(onKey).toHaveBeenCalledTimes(1)
    expect(onPrefix.mock.calls).toEqual([
      ['horizon:outbox:1'],
      ['horizon:outbox:2'],
    ])
    offKey()
    offPrefix()
    writeLocal('horizon:outbox:1', 'z')
    expect(onKey).toHaveBeenCalledTimes(1)
    expect(onPrefix).toHaveBeenCalledTimes(2)
  })
})
