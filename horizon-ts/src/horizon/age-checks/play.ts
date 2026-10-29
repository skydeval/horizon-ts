/*
 * Asking the phone's store for the user's age range (`expo-age-range`):
 * Google Play Age Signals on Android, Apple's Declared Age Range on iOS 26.
 */

import * as AgeRange from 'expo-age-range'

import {logger} from '#/logger'
import {DEVICE_SIGNALS_SUPPORTED} from '#/ageAssurance/const'
import {IS_ANDROID} from '#/env'
import {type StoredAgeCheck} from '#/horizon/age-checks/types'

const THRESHOLDS = {threshold1: 13, threshold2: 16, threshold3: 18}

function fromResponse(
  status: StoredAgeCheck['status'],
  res: AgeRange.AgeRangeResponse | undefined,
): StoredAgeCheck {
  return {
    checkedAt: new Date().toISOString(),
    status,
    lowerBound: res?.lowerBound ?? null,
    upperBound: res?.upperBound ?? null,
    parentApproval: res?.significantChangeStatus ?? null,
  }
}

/**
 * Asks the store. `prompt` lets Play show its age sharing screen (the
 * first check, or the user pressing a button); without it Play is only
 * asked again for a range it already shares. Never throws: a failed call
 * is `UNAVAILABLE`.
 */
export async function askStore({
  prompt,
  previous,
}: {
  prompt: boolean
  previous: StoredAgeCheck | undefined
}): Promise<StoredAgeCheck | undefined> {
  if (!DEVICE_SIGNALS_SUPPORTED) return fromResponse('UNAVAILABLE', undefined)
  try {
    if (!IS_ANDROID) {
      // iOS shows its own sharing prompt as part of the request.
      if (!prompt) return previous
      return fromResponse(
        'SHARED',
        await AgeRange.requestAgeRangeAsync(THRESHOLDS),
      )
    }
    if (!prompt && previous?.status !== 'SHARED') return previous
    const status = prompt
      ? await AgeRange.requestAgeSignalsAccessAsync()
      : 'SHARED'
    if (status === null) return fromResponse('NONE', undefined)
    if (status !== 'SHARED') return fromResponse(status, undefined)
    const res = await AgeRange.requestAgeRangeAsync(THRESHOLDS)
    // Sharing withdrawn since the last check: every field comes back null.
    if (!prompt && res.lowerBound === null && res.ageRangeSource == null) {
      return fromResponse('NOT_SHARED', undefined)
    }
    return fromResponse('SHARED', res)
  } catch (err) {
    logger.warn('age check: the store could not be asked', {
      safeMessage: (err as Error)?.message,
    })
    return fromResponse('UNAVAILABLE', undefined)
  }
}
