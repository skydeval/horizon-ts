import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The two device stores (system accounts design 5.5, 6.1; 18 "List store",
 * "Entry fields"), on an in-memory map.
 */

jest.mock('#/horizon/system-accounts/device', () => {
  const values = new Map<string, string>()
  return {
    readDevice: (key: string) => values.get(key),
    writeDevice: (key: string, value: string | undefined) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
    subscribeDevice: () => () => {},
    clearForTests: () => values.clear(),
  }
})

import {
  addToList,
  applyListAnswer,
  clearListDied,
  compareRev,
  deleteLists,
  getList,
  getLists,
  hideRow,
  isRowHidden,
  listHolds,
  markListDied,
  resetListStoreForTests,
  setDisplayFields,
  unhideRow,
} from '../list-store'
import {
  entrySessionAccount,
  getEntries,
  getEntry,
  markNeedsSignIn,
  oauthEntryFrom,
  putEntry,
  resetSessionStoreForTests,
  SESSIONS_KEY,
} from '../session-store'

const device = jest.requireMock<{
  clearForTests: () => void
  readDevice: (key: string) => string | undefined
}>('#/horizon/system-accounts/device')

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'did:plc:cccccccccccccccccccccccc'

beforeEach(() => {
  device.clearForTests()
  resetListStoreForTests()
  resetSessionStoreForTests()
})

describe('the list cache (5.5)', () => {
  it('is read synchronously, and a prism answer replaces the DIDs, keeping display fields', () => {
    applyListAnswer(A, {accounts: [{did: B, addedAt: 't1'}], rev: '1'}, 5)
    setDisplayFields(B, {handle: 'lala.test', displayName: 'Lala'})
    const {applied, dropped} = applyListAnswer(
      A,
      {
        accounts: [
          {did: B, addedAt: 't1'},
          {did: C, addedAt: 't2'},
        ],
        rev: '2',
      },
      6,
    )
    expect(applied).toBe(true)
    expect(dropped).toEqual([])
    expect(getList(A)?.accounts).toEqual([
      {did: B, handle: 'lala.test', displayName: 'Lala', addedAt: 't1'},
      {did: C, addedAt: 't2'},
    ])
    expect(getList(A)?.syncedAt).toBe(6)
  })

  it('an answer with a lower rev than the cache’s is ignored (SAR2-N3)', () => {
    applyListAnswer(A, {accounts: [{did: B, addedAt: 't'}], rev: '5'})
    // The add's own answer counts at its rev.
    addToList(A, {did: C, addedAt: 't'}, '7')
    const stale = applyListAnswer(A, {
      accounts: [{did: B, addedAt: 't'}],
      rev: '6',
    })
    expect(stale.applied).toBe(false)
    expect(getList(A)?.accounts.map(a => a.did)).toEqual([B, C])
    expect(compareRev('10', '9')).toBeGreaterThan(0)
    expect(compareRev('3kabc', '3kabd')).toBeLessThan(0)
  })

  it('reports the DIDs a read dropped', () => {
    applyListAnswer(A, {accounts: [{did: B, addedAt: 't'}], rev: '1'})
    const {dropped} = applyListAnswer(A, {accounts: [], rev: '2'})
    expect(dropped).toEqual([B])
  })

  it('`diedAt` holds only within the page load in which the death was seen (SAR3-L5)', () => {
    applyListAnswer(A, {accounts: [{did: B, addedAt: 't'}], rev: '1'})
    markListDied(A, 100)
    expect(listHolds(getList(A)!, 50)).toBe(true)
    expect(listHolds(getList(A)!, 150)).toBe(false)
    clearListDied(A)
    expect(getList(A)?.diedAt).toBeUndefined()
    // A later answer keeps a mark that is there.
    markListDied(A, 100)
    applyListAnswer(A, {accounts: [], rev: '2'})
    expect(getList(A)?.diedAt).toBe(100)
  })

  it('signing out deletes the account’s list (SA-21)', () => {
    applyListAnswer(A, {accounts: [], rev: '1'})
    applyListAnswer(B, {accounts: [], rev: '1'})
    deleteLists([A])
    expect(Object.keys(getLists())).toEqual([B])
  })

  it('the remove overlay is not an edit of the list, and a read does not undo it (SAR2-N10)', () => {
    applyListAnswer(A, {accounts: [{did: B, addedAt: 't'}], rev: '1'})
    hideRow(A, B)
    applyListAnswer(A, {accounts: [{did: B, addedAt: 't'}], rev: '2'})
    expect(isRowHidden(A, B)).toBe(true)
    expect(getList(A)?.accounts.map(a => a.did)).toEqual([B])
    unhideRow(A, B)
    expect(isRowHidden(A, B)).toBe(false)
  })
})

describe('the session store (6.1)', () => {
  it('an OAuth entry keeps no email, active or status (SAR3-N6)', () => {
    putEntry(
      oauthEntryFrom(
        {issuer: 'https://auth.example', aud: 'https://pds.example'},
        {
          did: B,
          handle: 'lala.test',
          email: 'lala@example.com',
          emailConfirmed: true,
          emailAuthFactor: true,
          active: true,
          status: 'ok',
        },
      ),
    )
    const raw = device.readDevice(SESSIONS_KEY) ?? ''
    expect(raw).not.toContain('email')
    expect(raw).not.toContain('lala@example.com')
    expect(raw).not.toContain('active')
    expect(getEntry(B)).toEqual({
      did: B,
      handle: 'lala.test',
      service: 'https://auth.example/',
      pdsUrl: 'https://pds.example/',
      kind: 'oauth',
    })
    // The temporary client's account has the email fields empty.
    expect(entrySessionAccount(getEntry(B)!)).toEqual(
      expect.objectContaining({
        did: B,
        email: undefined,
        emailConfirmed: false,
        emailAuthFactor: false,
        isOauthSession: true,
      }),
    )
  })

  it('tokens are kept for a password entry only', () => {
    putEntry({did: B, kind: 'oauth', accessJwt: 'a', refreshJwt: 'r'})
    expect(getEntry(B)?.refreshJwt).toBeUndefined()
    putEntry({did: C, kind: 'password', accessJwt: 'a', refreshJwt: 'r'})
    expect(getEntry(C)?.refreshJwt).toBe('r')
  })

  it('"Sign in again" is a mark on the entry; a provisional entry references no session', () => {
    putEntry({did: B, addingSince: 1, addingFor: A, pendingUntil: 2})
    expect(entrySessionAccount(getEntry(B)!)).toBeUndefined()
    markNeedsSignIn(B)
    expect(getEntries()[B]?.needsSignIn).toBe(true)
  })
})
