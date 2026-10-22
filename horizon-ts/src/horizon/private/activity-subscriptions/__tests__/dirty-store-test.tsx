import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * T-9: the dirty store (activity subscriptions design 2.2) on native (its
 * own MMKV instance) and web (`localStorage`, other tabs through the
 * `storage` event), and account removal through `OutboxAccountWatcher`.
 */

/** MMKV instances by id; the values outlive any module instance. */
const mockMmkv = new Map<string, Map<string, string>>()
const mockMmkvIds: string[] = []
jest.mock('react-native-mmkv', () => ({
  MMKV: class {
    mockValues: Map<string, string>
    mockListeners = new Set<(mockKey: string) => void>()
    constructor(mockOptions: {id: string}) {
      mockMmkvIds.push(mockOptions.id)
      let mockFound = mockMmkv.get(mockOptions.id)
      if (!mockFound) {
        mockFound = new Map()
        mockMmkv.set(mockOptions.id, mockFound)
      }
      this.mockValues = mockFound
    }
    getString(mockKey: string) {
      return this.mockValues.get(mockKey)
    }
    set(mockKey: string, mockValue: string) {
      this.mockValues.set(mockKey, mockValue)
      this.mockListeners.forEach(mockListener => mockListener(mockKey))
    }
    delete(mockKey: string) {
      this.mockValues.delete(mockKey)
      this.mockListeners.forEach(mockListener => mockListener(mockKey))
    }
    getAllKeys() {
      return Array.from(this.mockValues.keys())
    }
    addOnValueChangedListener(mockListener: (mockKey: string) => void) {
      this.mockListeners.add(mockListener)
      return {remove: () => this.mockListeners.delete(mockListener)}
    }
  },
}))

let mockAccounts: {did: string}[] = []
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: mockAccounts}),
}))
const mockForget = jest.fn()
jest.mock('#/horizon/private/outbox', () => ({
  forgetRemovedAccount: (did: string) => mockForget(did),
}))
jest.mock('#/horizon/private/outbox/record', () => ({
  outboxRecordDids: () => [],
}))

/*
 * A browser's `localStorage` and `storage` event for the web build, set up
 * before the web store first subscribes.
 */
const fakeLocal = new Map<string, string>()
const storageListeners: ((event: {key: string | null}) => void)[] = []
const win = ((globalThis as unknown as {window?: Record<string, unknown>}).window ??=
  {})
win.localStorage = {
  get length() {
    return fakeLocal.size
  },
  key: (i: number) => Array.from(fakeLocal.keys())[i] ?? null,
  getItem: (key: string) => fakeLocal.get(key) ?? null,
  setItem: (key: string, value: string) => fakeLocal.set(key, value),
  removeItem: (key: string) => fakeLocal.delete(key),
}
const originalAdd = win.addEventListener as
  | ((type: string, listener: unknown) => void)
  | undefined
win.addEventListener = (type: string, listener: unknown) => {
  if (type === 'storage') {
    storageListeners.push(listener as (event: {key: string | null}) => void)
  } else {
    originalAdd?.(type, listener)
  }
}

import {render} from '@testing-library/react-native'

import {OutboxAccountWatcher} from '#/horizon/private/outbox/OutboxAccountWatcher'
import {dirtyKey, newToken, reconciledKey} from '../common'
import * as native from '../dirty-store'
import * as web from '../dirty-store.web'

const A = 'did:plc:accountaaaaaaaaaaaaaaaaaa'
const B = 'did:plc:accountbbbbbbbbbbbbbbbbbbb'
const S1 = 'did:plc:subjectccccccccccccccccc'
const S2 = 'did:web:subject.example'

beforeEach(() => {
  for (const values of mockMmkv.values()) values.clear()
  fakeLocal.clear()
  mockForget.mockClear()
})

describe('T-9: the native dirty store', () => {
  it('uses its own MMKV instance, which also holds reconciled:<did>', () => {
    native.writeToken(A, S1, 'tok')
    native.writeReconciled(A, 1234)
    expect(mockMmkvIds).toContain('horizon_activity_subs')
    const values = mockMmkv.get('horizon_activity_subs')
    expect(values?.get(dirtyKey(A, S1))).toBe('tok')
    expect(values?.get(reconciledKey(A))).toBe('1234')
    expect(native.readReconciled(A)).toBe(1234)
  })

  it('survives a new module instance', () => {
    native.writeToken(A, S1, 'kept')
    native.writeToken(A, S2, 'also')
    jest.isolateModules(() => {
      const fresh = require('../dirty-store') as typeof native
      expect(fresh.readToken(A, S1)).toBe('kept')
      expect(fresh.listSubjects(A).sort()).toEqual([S1, S2].sort())
    })
  })

  it('lists accounts under both prefixes and clears one', () => {
    native.writeToken(A, S1, 'tok')
    native.writeReconciled(B, 1)
    expect(native.listDids().sort()).toEqual([A, B].sort())
    native.clearDid(B)
    expect(native.listDids()).toEqual([A])
    native.clearDid(A)
    expect(native.listDids()).toEqual([])
    expect(native.readToken(A, S1)).toBeUndefined()
  })

  it('tells its listeners of a change', () => {
    const heard: string[] = []
    const unsubscribe = native.subscribeDirty((did, subject) =>
      heard.push(`${did} ${subject}`),
    )
    native.writeToken(A, S1, 'tok')
    native.writeReconciled(A, 1)
    unsubscribe()
    native.removeToken(A, S1)
    expect(heard).toEqual([`${A} ${S1}`])
  })
})

describe('T-9: the web dirty store', () => {
  it('uses localStorage and follows other tabs', () => {
    web.writeToken(A, S1, 'tok')
    expect(fakeLocal.get(dirtyKey(A, S1))).toBe('tok')
    const heard: string[] = []
    const unsubscribe = web.subscribeDirty((did, subject) =>
      heard.push(`${did} ${subject}`),
    )
    // Another tab writes a key.
    fakeLocal.set(dirtyKey(A, S2), 'other-tab')
    storageListeners.forEach(listener => listener({key: dirtyKey(A, S2)}))
    unsubscribe()
    expect(heard).toEqual([`${A} ${S2}`])
    expect(web.readToken(A, S2)).toBe('other-tab')
  })

  it('finds an account with only its reconciled record, and clears it', () => {
    web.writeToken(A, S1, 'tok')
    web.writeReconciled(B, 5)
    expect(web.listDids().sort()).toEqual([A, B].sort())
    web.clearDid(A)
    expect(web.listDids()).toEqual([B])
    expect(web.readReconciled(B)).toBe(5)
  })
})

describe('T-9: values and account removal', () => {
  it('holds an opaque token: no flags and no times', () => {
    const token = newToken()
    expect(token).toMatch(/^[0-9a-z]{28}$/)
    expect(token).not.toBe(newToken())
  })

  it('OutboxAccountWatcher clears a removed account’s keys and record, with no outbox records', () => {
    native.writeToken(A, S1, 'kept')
    native.writeToken(B, S1, 'gone')
    native.writeReconciled(B, 1)
    mockAccounts = [{did: A}]
    render(<OutboxAccountWatcher />)
    expect(native.listDids()).toEqual([A])
    expect(native.readToken(A, S1)).toBe('kept')
    expect(native.readReconciled(B)).toBeUndefined()
  })

  it('also finds an account that holds only its record', () => {
    native.writeReconciled(B, 1)
    mockAccounts = [{did: A}]
    render(<OutboxAccountWatcher />)
    expect(native.listDids()).toEqual([])
  })
})
