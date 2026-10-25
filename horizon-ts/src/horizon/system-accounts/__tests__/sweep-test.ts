import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The sweep (system accounts design 6.5, SA-8; 18 "Sweep, one test per row
 * of 6.5") and the sign-out seam (18 "Sign-out"). The device stores run on
 * an in-memory map; revocations are spies.
 */

jest.mock('#/horizon/system-accounts/device', () => {
  const values = new Map<string, string>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    readDevice: (key: string) => values.get(key),
    writeDevice: (key: string, value: string | undefined) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
      listeners.get(key)?.forEach(listener => listener())
    },
    subscribeDevice: (key: string, listener: () => void) => {
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => set.delete(listener)
    },
    clearForTests: () => values.clear(),
  }
})
const mockRevoke = jest.fn<(did: string) => Promise<void>>(() =>
  Promise.resolve(),
)
const mockEndPassword = jest.fn<(account: unknown) => Promise<void>>(() =>
  Promise.resolve(),
)
jest.mock('#/horizon/session/revoke', () => ({
  revokeOAuthGrant: (did: string) => mockRevoke(did),
  endPasswordSession: (account: unknown) => mockEndPassword(account),
  isRevokingOAuthGrant: () => false,
}))
jest.mock('#/state/persisted', () => ({get: () => ({accounts: []})}))
const mockAbandon = jest.fn()
jest.mock('#/horizon/system-accounts/abandon', () => ({
  abandonRegistrations: (which: unknown) => mockAbandon(which),
}))

import {type SessionAccount} from '#/state/session/types'
import {
  getList,
  getLists,
  resetListStoreForTests,
  setLoadStartedAtForTests,
} from '../list-store'
import {
  getEntries,
  getEntry,
  putEntry,
  resetSessionStoreForTests,
  type SystemEntry,
} from '../session-store'
import {signOutSystemAccounts} from '../sign-out'
import {
  GRACE_MS,
  planSweep,
  resetSweepForTests,
  runSweep,
  scheduleSweepTimer,
  type SweepSnapshot,
} from '../sweep'

const device = jest.requireMock<{clearForTests: () => void}>(
  '#/horizon/system-accounts/device',
)

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const X = 'did:plc:xxxxxxxxxxxxxxxxxxxxxxxx'
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'did:plc:cccccccccccccccccccccccc'

const NOW = 10_000_000
const LOAD = NOW - 60_000

function jwt(exp: number) {
  const body = btoa(JSON.stringify({exp})).replace(/=+$/, '')
  return `x.${body}.y`
}

/** A usable OAuth switcher account. */
function oauth(did: string, extra: Partial<SessionAccount> = {}) {
  return {
    service: 'https://pds.example/',
    did,
    handle: `${did.slice(8, 12)}.test`,
    isOauthSession: true,
    ...extra,
  } as unknown as SessionAccount
}

/** A usable password switcher account. */
function password(did: string) {
  return {
    service: 'https://pds.example/',
    did,
    handle: `${did.slice(8, 12)}.test`,
    refreshJwt: jwt(NOW / 1000 + 3600),
    accessJwt: jwt(NOW / 1000 + 60),
  } as unknown as SessionAccount
}

function signedOut(account: SessionAccount) {
  return {...account, oauthSignedOut: true} as SessionAccount
}

function list(dids: string[], extra: {diedAt?: number} = {}) {
  return {
    accounts: dids.map(did => ({did, addedAt: '2026-10-24T00:00:00Z'})),
    rev: '1',
    syncedAt: NOW,
    ...extra,
  }
}

function snapshot(
  entries: SystemEntry[],
  lists: Record<string, ReturnType<typeof list>>,
  accounts: SessionAccount[],
  now = NOW,
): SweepSnapshot {
  return {
    entries: Object.fromEntries(entries.map(e => [e.did, e])),
    lists,
    accounts,
    now,
    loadStartedAt: LOAD,
  }
}

const oauthEntry = (did: string, extra: Partial<SystemEntry> = {}) =>
  ({
    did,
    kind: 'oauth',
    service: 'https://pds.example/',
    ...extra,
  }) as SystemEntry

function seedLists(lists: Record<string, ReturnType<typeof list>>) {
  const {writeDevice} = jest.requireMock<{
    writeDevice: (key: string, value: string | undefined) => void
  }>('#/horizon/system-accounts/device')
  writeDevice('horizon:systemAccounts', JSON.stringify(lists))
}

beforeEach(() => {
  device.clearForTests()
  resetListStoreForTests()
  resetSessionStoreForTests()
  resetSweepForTests()
  setLoadStartedAtForTests(LOAD)
  mockRevoke.mockClear()
  mockEndPassword.mockClear()
  mockAbandon.mockClear()
  jest.spyOn(Date, 'now').mockImplementation(() => NOW)
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('the sweep, by the rows of 6.5', () => {
  it('A removes B, confirmed: B is revoked', () => {
    const plan = planSweep(
      snapshot([oauthEntry(B)], {[A]: list([])}, [oauth(A)]),
    )
    expect(plan.revoke.map(e => e.did)).toEqual([B])
  })

  it('another account’s cached list still has B: kept', () => {
    const plan = planSweep(
      snapshot([oauthEntry(B)], {[A]: list([]), [X]: list([B])}, [
        oauth(A),
        oauth(X),
      ]),
    )
    expect(plan.revoke).toEqual([])
    expect(plan.drop).toEqual([])
  })

  it('B a usable switcher account is never revoked: only its entry goes', () => {
    const plan = planSweep(
      snapshot([oauthEntry(B)], {[A]: list([])}, [oauth(A), oauth(B)]),
    )
    expect(plan.revoke).toEqual([])
    expect(plan.drop).toEqual([B])
  })

  it('an entry whose DID becomes a usable switcher account turns `switcher`, keeping a loss mark (SAR2-N14, SAR3-N7)', () => {
    const plan = planSweep(
      snapshot(
        [{did: B, kind: 'password', needsSignIn: true, refreshJwt: 'r'}],
        {[A]: list([B])},
        [oauth(A), password(B)],
      ),
    )
    expect(plan.rewrite).toEqual([
      expect.objectContaining({did: B, kind: 'switcher', needsSignIn: true}),
    ])
    expect(plan.rewrite[0].refreshJwt).toBeUndefined()
    // Its own password session is ended; the switcher's is untouched.
    expect(plan.retire.map(e => e.did)).toEqual([B])
    expect(plan.revoke).toEqual([])
  })

  it('B, a registered switcher account, signed out of the switcher: "Sign in again", kept', () => {
    const plan = planSweep(
      snapshot([{did: B, kind: 'switcher'}], {[A]: list([B])}, [
        oauth(A),
        signedOut(oauth(B)),
      ]),
    )
    expect(plan.revoke).toEqual([])
    expect(plan.rewrite).toEqual([
      expect.objectContaining({did: B, needsSignIn: true}),
    ])
  })

  it('A dies in this load: A still holds B; at the next load it holds nothing (SAR3-L5)', () => {
    const died = planSweep(
      snapshot([oauthEntry(B)], {[A]: list([B], {diedAt: NOW - 1000})}, [
        signedOut(oauth(A)),
      ]),
    )
    expect(died.revoke).toEqual([])
    const nextLoad = planSweep(
      snapshot([oauthEntry(B)], {[A]: list([B], {diedAt: LOAD - 1})}, [
        signedOut(oauth(A)),
      ]),
    )
    expect(nextLoad.revoke.map(e => e.did)).toEqual([B])
  })

  it('A dies, then signs in again in the same load: nothing revoked', () => {
    // The runtime clears `diedAt` on the sign-in; the list then holds plainly.
    const plan = planSweep(
      snapshot([oauthEntry(B)], {[A]: list([B])}, [oauth(A)]),
    )
    expect(plan.revoke).toEqual([])
  })

  it('a grace under 2 minutes is kept while `addingFor` is usable; over 2, or with `addingFor` signed out, it is swept (SAR2-L3)', () => {
    const entry = oauthEntry(B, {addingSince: NOW - 60_000, addingFor: A})
    expect(planSweep(snapshot([entry], {}, [oauth(A)])).revoke).toEqual([])
    expect(
      planSweep(snapshot([entry], {}, [oauth(A)], NOW + GRACE_MS)).revoke,
    ).toHaveLength(1)
    expect(
      planSweep(snapshot([entry], {}, [signedOut(oauth(A))])).revoke,
    ).toHaveLength(1)
  })

  it('a pending popup keeps its provisional entry for its whole life, in every tab (SA-26, SAR3-L4)', () => {
    const provisional: SystemEntry = {
      did: B,
      addingSince: NOW,
      addingFor: A,
      pendingUntil: NOW + 6 * 60_000,
    }
    // Another tab's sweep 3 minutes after the press keeps it.
    expect(
      planSweep(snapshot([provisional], {}, [oauth(A)], NOW + 3 * 60_000))
        .revoke,
    ).toEqual([])
    // After `pendingUntil` it is treated like any other entry.
    expect(
      planSweep(snapshot([provisional], {}, [oauth(A)], NOW + 7 * 60_000))
        .revoke,
    ).toHaveLength(1)
  })

  it('the result does not depend on the order of the account array', () => {
    const entries = [oauthEntry(B), oauthEntry(C)]
    const lists = {[A]: list([B]), [X]: list([])}
    const one = planSweep(snapshot(entries, lists, [oauth(A), oauth(X)]))
    const two = planSweep(snapshot(entries, lists, [oauth(X), oauth(A)]))
    expect(one).toEqual(two)
    expect(one.revoke.map(e => e.did)).toEqual([C])
  })

  it('a listed DID that is a usable switcher account gets a `switcher` entry at once (SAR1-N7)', () => {
    const plan = planSweep(snapshot([], {[A]: list([B])}, [oauth(A), oauth(B)]))
    expect(plan.create).toEqual([
      expect.objectContaining({did: B, kind: 'switcher'}),
    ])
  })

  it('A removes B after B was signed out with `logoutCurrentAccount` (kept, not usable): revoked', () => {
    const plan = planSweep(
      snapshot([oauthEntry(B)], {[A]: list([])}, [
        oauth(A),
        signedOut(oauth(B)),
      ]),
    )
    expect(plan.revoke.map(e => e.did)).toEqual([B])
  })
})

describe('applying the sweep', () => {
  it('revokes through the library (an offline revoke still deletes, SAR1-L1) and deletes the entry at once', async () => {
    mockRevoke.mockImplementationOnce(() =>
      Promise.reject(new Error('offline')),
    )
    putEntry(oauthEntry(B))
    seedLists({[A]: list([])})
    const done = runSweep([oauth(A)])
    expect(getEntry(B)).toBeUndefined()
    expect(mockRevoke).toHaveBeenCalledWith(B)
    await done
  })

  it('a password entry: tokens forgotten at once, the server session ended best effort', async () => {
    putEntry({
      did: B,
      kind: 'password',
      service: 'https://pds.example/',
      refreshJwt: 'r',
      accessJwt: 'a',
    })
    await runSweep([oauth(A)])
    expect(getEntry(B)).toBeUndefined()
    expect(mockEndPassword).toHaveBeenCalledWith(
      expect.objectContaining({did: B, refreshJwt: 'r'}),
    )
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('the grace timer sweeps with no other event (SAR2-L3)', async () => {
    jest.useFakeTimers({now: NOW})
    jest.spyOn(Date, 'now').mockImplementation(() => NOW)
    putEntry(oauthEntry(B, {addingSince: NOW, addingFor: A}))
    const accounts = [oauth(A)]
    await runSweep(accounts)
    expect(getEntry(B)).toBeDefined()
    jest.spyOn(Date, 'now').mockImplementation(() => NOW + GRACE_MS + 5)
    jest.advanceTimersByTime(GRACE_MS + 5)
    expect(getEntry(B)).toBeUndefined()
    expect(mockRevoke).toHaveBeenCalledWith(B)
  })

  it('timers are set from the stored entries, so any tab ends a grace it did not start', () => {
    jest.useFakeTimers({now: NOW})
    putEntry(oauthEntry(B, {addingSince: NOW, addingFor: A}))
    scheduleSweepTimer(NOW)
    expect(jest.getTimerCount()).toBe(1)
  })
})

describe('the sign-out seam (6.5, SA-21)', () => {
  it('logoutCurrentAccount of A: its list and the grace it started are gone before any await; what only A held is revoked', () => {
    seedLists({[A]: list([B]), [X]: list([])})
    putEntry(oauthEntry(B))
    putEntry(oauthEntry(C, {addingSince: NOW, addingFor: A}))
    const after = [signedOut(oauth(A)), oauth(X)]
    void signOutSystemAccounts([oauth(A)], after)
    // Synchronously, before the first await (SAR1-L7, SAR2-L3).
    expect(getList(A)).toBeUndefined()
    expect(getList(X)).toBeDefined()
    expect(getEntry(B)).toBeUndefined()
    expect(getEntry(C)).toBeUndefined()
    expect(mockRevoke).toHaveBeenCalledWith(B)
    expect(mockRevoke).toHaveBeenCalledWith(C)
    expect(mockAbandon).toHaveBeenCalledTimes(1)
  })

  it('logoutCurrentAccount of B (registered by a usable A): B is marked "Sign in again"', () => {
    seedLists({[A]: list([B])})
    putEntry({did: B, kind: 'switcher'})
    void signOutSystemAccounts([oauth(B)], [oauth(A), signedOut(oauth(B))])
    expect(getEntry(B)).toEqual(
      expect.objectContaining({did: B, needsSignIn: true}),
    )
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('logoutEveryAccount with A registering a switcher B: both stores end empty', async () => {
    seedLists({[A]: list([B])})
    putEntry({did: B, kind: 'switcher'})
    putEntry(oauthEntry(C, {pendingUntil: NOW + 60_000, addingFor: A}))
    const {revocations, afterStock} = signOutSystemAccounts(
      [oauth(A), oauth(B)],
      [signedOut(oauth(A)), signedOut(oauth(B))],
    )
    await revocations
    await afterStock()
    expect(getLists()).toEqual({})
    expect(getEntries()).toEqual({})
    expect(mockRevoke).toHaveBeenCalledWith(B)
    expect(mockRevoke).toHaveBeenCalledWith(C)
  })

  it('logoutEveryAccount within the grace and during a pending popup leaves both stores empty', async () => {
    putEntry(
      oauthEntry(B, {
        addingSince: NOW,
        addingFor: A,
        pendingUntil: NOW + 6 * 60_000,
      }),
    )
    const {revocations} = signOutSystemAccounts(
      [oauth(A)],
      [signedOut(oauth(A))],
    )
    await revocations
    expect(getEntries()).toEqual({})
  })
})
