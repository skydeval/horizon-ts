import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import * as AgeRange from 'expo-age-range'

import {askStore} from '#/horizon/age-checks/play'
import {
  getAgeCheck,
  resetAgeCheckStoreForTests,
  runAgeCheck,
} from '#/horizon/age-checks/store'
import {type StoredAgeCheck} from '#/horizon/age-checks/types'

jest.mock('#/env', () => ({
  __esModule: true,
  IS_ANDROID: true,
  IS_IOS: false,
  IS_WEB: false,
  IS_NATIVE: true,
}))
jest.mock('#/ageAssurance/const', () => ({
  DEVICE_SIGNALS_SUPPORTED: true,
}))
jest.mock('expo-age-range', () => ({
  requestAgeSignalsAccessAsync: jest.fn(),
  requestAgeRangeAsync: jest.fn(),
}))
jest.mock('#/storage', () => {
  const values = new Map<string, unknown>()
  return {
    device: {
      get: ([key]: [string]) => values.get(key),
      set: ([key]: [string], value: unknown) => values.set(key, value),
    },
  }
})

const access = AgeRange.requestAgeSignalsAccessAsync as jest.MockedFunction<
  typeof AgeRange.requestAgeSignalsAccessAsync
>
const range = AgeRange.requestAgeRangeAsync as jest.MockedFunction<
  typeof AgeRange.requestAgeRangeAsync
>

const TEEN: AgeRange.AgeRangeResponse = {
  lowerBound: 16,
  upperBound: 17,
  ageRangeSource: 'TIER_B',
  significantChangeStatus: 'PENDING',
}

const SHARED_TEEN: StoredAgeCheck = {
  checkedAt: '2026-10-29T00:00:00.000Z',
  status: 'SHARED',
  lowerBound: 16,
  upperBound: 17,
  parentApproval: null,
}

describe('asking Google Play', () => {
  beforeEach(() => {
    access.mockReset()
    range.mockReset()
    resetAgeCheckStoreForTests()
  })

  it('the first check shows the sharing screen, then reads the range', async () => {
    access.mockResolvedValue('SHARED')
    range.mockResolvedValue(TEEN)
    const res = await askStore({prompt: true, previous: undefined})
    expect(access).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({
      status: 'SHARED',
      lowerBound: 16,
      upperBound: 17,
      parentApproval: 'PENDING',
    })
  })

  it('a quiet refresh never shows the sharing screen', async () => {
    range.mockResolvedValue({...TEEN, lowerBound: 18, upperBound: null})
    const res = await askStore({prompt: false, previous: SHARED_TEEN})
    expect(access).not.toHaveBeenCalled()
    expect(res?.lowerBound).toBe(18)
  })

  it('no quiet refresh unless a range was shared', async () => {
    const declined = {...SHARED_TEEN, status: 'NOT_SHARED' as const}
    expect(await askStore({prompt: false, previous: declined})).toBe(declined)
    expect(access).not.toHaveBeenCalled()
    expect(range).not.toHaveBeenCalled()
  })

  it('sharing withdrawn since: not shared', async () => {
    range.mockResolvedValue({lowerBound: null, upperBound: null})
    const res = await askStore({prompt: false, previous: SHARED_TEEN})
    expect(res?.status).toBe('NOT_SHARED')
  })

  it('declined, verify, no status, and a failed call', async () => {
    access.mockResolvedValueOnce('NOT_SHARED')
    expect((await askStore({prompt: true, previous: undefined}))?.status).toBe(
      'NOT_SHARED',
    )
    access.mockResolvedValueOnce('VERIFICATION_REQUIRED')
    expect((await askStore({prompt: true, previous: undefined}))?.status).toBe(
      'VERIFICATION_REQUIRED',
    )
    access.mockResolvedValueOnce(null)
    expect((await askStore({prompt: true, previous: undefined}))?.status).toBe(
      'NONE',
    )
    access.mockRejectedValueOnce(new Error('not installed from Play'))
    expect((await askStore({prompt: true, previous: undefined}))?.status).toBe(
      'UNAVAILABLE',
    )
    expect(range).not.toHaveBeenCalled()
  })

  it('one request at a time, and the answer is kept', async () => {
    let finish: (v: StoredAgeCheck) => void = () => {}
    const ask = jest.fn(
      () =>
        new Promise<StoredAgeCheck | undefined>(resolve => {
          finish = resolve
        }),
    )
    const a = runAgeCheck(ask)
    const b = runAgeCheck(ask)
    expect(ask).toHaveBeenCalledTimes(1)
    finish(SHARED_TEEN)
    await Promise.all([a, b])
    expect(getAgeCheck()).toEqual(SHARED_TEEN)
  })
})
