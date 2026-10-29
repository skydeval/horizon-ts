/*
 * Web never checks ages: the state laws cover apps from app stores, not
 * websites (`README.md`).
 */

import {type StoredAgeCheck} from '#/horizon/age-checks/types'

export function askStore(_args: {
  prompt: boolean
  previous: StoredAgeCheck | undefined
}): Promise<StoredAgeCheck | undefined> {
  return Promise.resolve(undefined)
}
