import {type Geolocation} from '#/geolocation/types'
import {type CoveredRegion} from '#/horizon/age-checks/types'

/*
 * The states whose app store laws apply, each from its start date
 * (`docs/internal/branding/native-app.md`, "Age checks"). Adding a state is
 * a line here. Recheck Texas before each release: its challenge is pending.
 */
export const COVERED_REGIONS: readonly CoveredRegion[] = [
  {
    regionCode: 'TX',
    name: 'Texas',
    law: 'SB 2420, App Store Accountability Act',
    from: '2026-01-01',
  },
  {
    regionCode: 'UT',
    name: 'Utah',
    law: 'App Store Accountability Act, as amended by HB 498',
    from: '2026-12-31',
  },
  {
    regionCode: 'LA',
    name: 'Louisiana',
    law: 'App Store Accountability Act, re-enacted by HB 977',
    from: '2027-07-01',
  },
]

/**
 * The covered state the device is in on `now`, or null: outside the US,
 * in a state with no law in force, or where the location is unknown.
 */
export function coveredRegion(
  geolocation: Pick<Geolocation, 'countryCode' | 'regionCode'> | undefined,
  now: Date = new Date(),
  regions: readonly CoveredRegion[] = COVERED_REGIONS,
): CoveredRegion | null {
  if (geolocation?.countryCode !== 'US' || !geolocation.regionCode) return null
  const today = now.toISOString().slice(0, 10)
  return (
    regions.find(
      r => r.regionCode === geolocation.regionCode && today >= r.from,
    ) ?? null
  )
}
