import {describe, expect, it} from '@jest/globals'

import {
  blocksApp,
  decideAgeCheck,
  locksAdultContent,
} from '#/horizon/age-checks/decide'
import {coveredRegion} from '#/horizon/age-checks/regions'
import {type StoredAgeCheck} from '#/horizon/age-checks/types'

/*
 * The app's age checks (skydeval, 2026-10-29, "Bluesky-like"): only in a
 * covered state from its start date; 18 and up open, 13 to 17 adult content
 * off, under 13 blocked, a parent's "declined" blocked.
 */

function shared(
  lowerBound: number | null,
  upperBound: number | null,
  parentApproval: StoredAgeCheck['parentApproval'] = null,
): StoredAgeCheck {
  return {
    checkedAt: '2026-10-29T00:00:00.000Z',
    status: 'SHARED',
    lowerBound,
    upperBound,
    parentApproval,
  }
}

function status(s: StoredAgeCheck['status']): StoredAgeCheck {
  return {...shared(null, null), status: s}
}

describe('where the checks apply', () => {
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`)

  it('Texas from the first release', () => {
    const tx = {countryCode: 'US', regionCode: 'TX'}
    expect(coveredRegion(tx, day('2026-10-29'))?.name).toBe('Texas')
  })

  it('Utah and Louisiana only from their start dates', () => {
    const ut = {countryCode: 'US', regionCode: 'UT'}
    const la = {countryCode: 'US', regionCode: 'LA'}
    expect(coveredRegion(ut, day('2026-12-30'))).toBeNull()
    expect(coveredRegion(ut, day('2026-12-31'))?.name).toBe('Utah')
    expect(coveredRegion(la, day('2027-06-30'))).toBeNull()
    expect(coveredRegion(la, day('2027-07-01'))?.name).toBe('Louisiana')
  })

  it('nowhere else, and not where the location is unknown', () => {
    const now = day('2027-08-01')
    expect(coveredRegion({countryCode: 'US', regionCode: 'CA'}, now)).toBeNull()
    expect(coveredRegion({countryCode: 'GB', regionCode: 'TX'}, now)).toBeNull()
    expect(coveredRegion({countryCode: 'US', regionCode: undefined}, now)).toBeNull()
    expect(coveredRegion(undefined, now)).toBeNull()
  })
})

describe('what the answer does', () => {
  it('adults and users no duty reaches are open', () => {
    expect(decideAgeCheck(shared(18, null))).toBe('open')
    expect(decideAgeCheck(status('NONE'))).toBe('open')
    expect(decideAgeCheck(status('UNAVAILABLE'))).toBe('open')
  })

  it('13 to 17: adult content off; a pending parent too', () => {
    expect(decideAgeCheck(shared(13, 15))).toBe('teen')
    expect(decideAgeCheck(shared(16, 17))).toBe('teen')
    expect(decideAgeCheck(shared(16, 17, 'PENDING'))).toBe('parentPending')
    expect(decideAgeCheck(shared(16, 17, 'APPROVED'))).toBe('teen')
  })

  it('under 13 and a declining parent block the app', () => {
    expect(decideAgeCheck(shared(0, 12))).toBe('under13')
    expect(decideAgeCheck(shared(13, 15, 'DECLINED'))).toBe('parentDeclined')
    expect(blocksApp('under13')).toBe(true)
    expect(blocksApp('parentDeclined')).toBe(true)
    expect(blocksApp('teen')).toBe(false)
  })

  it('no answer, not shared, unknown and verify keep adult content off', () => {
    expect(decideAgeCheck(undefined)).toBe('unshared')
    expect(decideAgeCheck(status('NOT_SHARED'))).toBe('unshared')
    expect(decideAgeCheck(shared(null, null))).toBe('unknown')
    expect(decideAgeCheck(status('VERIFICATION_REQUIRED'))).toBe('verify')
    for (const outcome of ['unshared', 'unknown', 'verify', 'teen'] as const) {
      expect(locksAdultContent(outcome)).toBe(true)
      expect(blocksApp(outcome)).toBe(false)
    }
    expect(locksAdultContent('open')).toBe(false)
  })
})
