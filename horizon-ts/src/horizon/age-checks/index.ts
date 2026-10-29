/*
 * The app's age checks: only in the app, only in a covered state
 * (`regions.ts`), from the store's age signal (`play.ts`). See `README.md`.
 */

import {useEffect} from 'react'

import {IS_WEB} from '#/env'
import {useGeolocation} from '#/geolocation'
import {decideAgeCheck} from '#/horizon/age-checks/decide'
import {askStore} from '#/horizon/age-checks/play'
import {coveredRegion} from '#/horizon/age-checks/regions'
import {
  runAgeCheck,
  useAgeCheckBusy,
  useStoredAgeCheck,
} from '#/horizon/age-checks/store'
import {
  type AgeCheckOutcome,
  type CoveredRegion,
} from '#/horizon/age-checks/types'

export {blocksApp, locksAdultContent} from '#/horizon/age-checks/decide'
export type {AgeCheckOutcome, CoveredRegion} from '#/horizon/age-checks/types'

export type AgeCheck = {
  region: CoveredRegion
  outcome: AgeCheckOutcome
  /** True while the store is being asked. */
  checking: boolean
}

/** The age check where one applies (the app, in a covered state), or null. */
export function useAgeCheck(): AgeCheck | null {
  const geolocation = useGeolocation()
  const check = useStoredAgeCheck()
  const checking = useAgeCheckBusy()
  const region = IS_WEB ? null : coveredRegion(geolocation)
  if (!region) return null
  return {region, outcome: decideAgeCheck(check), checking}
}

/**
 * Asks the store again. `prompt` lets it show its age sharing screen (a
 * button the user pressed).
 */
export function checkAgeAgain({prompt}: {prompt: boolean}) {
  return runAgeCheck(previous => askStore({prompt, previous}))
}

/**
 * On launch in a covered state: the first time, the store's sharing screen;
 * after that, a quiet refresh of a range already shared (an age that moved
 * up, a parent's approval). Mounted once, by the age assurance provider.
 */
export function useAgeCheckOnLaunch(active: boolean) {
  useEffect(() => {
    if (!active) return
    void runAgeCheck(previous =>
      askStore({prompt: previous === undefined, previous}),
    )
  }, [active])
}
