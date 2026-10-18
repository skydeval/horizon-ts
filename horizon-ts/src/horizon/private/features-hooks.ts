/*
 * The feature store (`routing/features.ts`) as hooks for the session's
 * account. Kept out of `routing/features.ts` so that module imports no
 * session module.
 */

import {useSyncExternalStore} from 'react'

import {useSession} from '#/state/session'
import {
  type PrismFeature,
  servesFeature,
  servesFeatureForWrite,
  subscribePrismFeatures,
} from '#/horizon/routing/features'

/**
 * Whether prism serves `feature` for the session's account, kept current.
 * For rendering and reads (a persisted list counts).
 */
export function usePrismFeature(feature: PrismFeature): boolean {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  return useSyncExternalStore(subscribePrismFeatures, () =>
    did ? servesFeature(feature, did) : false,
  )
}

/**
 * Whether prism serves `feature` for the session's account as answered in
 * this run, kept current. For decisions that write (2H design 4.7).
 */
export function usePrismFeatureForWrite(feature: PrismFeature): boolean {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  return useSyncExternalStore(subscribePrismFeatures, () =>
    did ? servesFeatureForWrite(feature, did) : false,
  )
}
