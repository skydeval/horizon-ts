/*
 * Who gets Thread Lens, and when a screen uses it (Phase 4 design 3.2, 5.1;
 * TL-1, TL-3, TL-25).
 *
 * Served (3.2): never signed out. When the account's held feature list
 * (prism's answer, or the device's copy of it) holds any `threadLens*`
 * value, the list decides: `threadLens.signedIn` serves every signed-in
 * account, `threadLens` alone serves a ready member, any other mix serves
 * nobody. A list without such a value, or no list, serves everyone (rule 3:
 * a prism older than A1's build, deployed `"signed_in"`). A refusal in this
 * run (`NotEnrolled`, `NotReady`, `501`, recorded by `api.ts` for the key's
 * DID) takes it away for the run; a `NotReady` is lifted when the account's
 * membership next becomes `member`.
 *
 * Active (5.1): the switch on, signed in, the device value (or the
 * account's default) on, served, and the anchor not a private URI. A
 * private anchor is judged by its URI whatever `PRIVATE_READING` is (R1-N4).
 *
 * Lens-only (5.1): the switch on, signed in, a public anchor, and the anchor
 * in the account's gap registry or the route carrying the lens gap mark,
 * whether or not the lens is active. The registry read runs on every render,
 * a private anchor included, and the conditions gate its result (v7: R5-N3).
 *
 * Every render-time read goes through a subscription (TL-34): the feature
 * list, membership, the device value, the refusal record, the registry.
 */

import {useEffect, useSyncExternalStore} from 'react'

import {isPrivatePostUri} from '#/horizon/private/uri'
import {
  getPrismFeatures,
  subscribePrismFeatures,
} from '#/horizon/routing/features'
import {
  getMembership,
  type MembershipState,
  subscribeMembership,
  useMembership,
} from '#/horizon/routing/membership'
import {THREAD_LENS} from '#/horizon/switches'
import {
  getLensRefusal,
  liftLensNotReady,
  useLensRefused,
} from '#/horizon/thread-lens/api'
import {useThreadLensPreference} from '#/horizon/thread-lens/preference'
import {useLensGapRegistered} from '#/horizon/thread-lens/registry'

/**
 * What the account's feature list says about the lens (3.2): `all`
 * (`threadLens.signedIn`), `members` (`threadLens` alone), `none` (some
 * other `threadLens.*` value only) or `unlisted` (no such value, or no list).
 */
export type LensFeatureVerdict = 'all' | 'members' | 'none' | 'unlisted'

/** The feature list's verdict for `did`. A plain read. */
export function lensFeatureVerdict(
  did: string | undefined,
): LensFeatureVerdict {
  if (!did) return 'unlisted'
  const list = getPrismFeatures(did)
  if (!list) return 'unlisted'
  const values = list.filter(value => value.startsWith('threadLens'))
  if (values.length === 0) return 'unlisted'
  if (values.includes('threadLens.signedIn')) return 'all'
  if (values.includes('threadLens')) return 'members'
  return 'none'
}

function servedBy(
  verdict: LensFeatureVerdict,
  membership: MembershipState,
  refused: boolean,
): boolean {
  if (refused) return false
  if (verdict === 'members') return membership === 'member'
  return verdict !== 'none'
}

/** Whether prism serves the lens to `did` (3.2), for non-render callers. */
export function isLensServed(did: string | undefined): boolean {
  if (!THREAD_LENS || !did) return false
  return servedBy(
    lensFeatureVerdict(did),
    getMembership(did),
    getLensRefusal(did) !== undefined,
  )
}

/*
 * The `NotReady` lift (3.2): each DID a lens reader has seen keeps the
 * membership state it last had, and a change into `member` lifts its
 * `NotReady` refusal. A refusal that arrives while the held state already
 * reads `member` stays until the state leaves `member` and comes back, so a
 * stale `member` never turns into a loop of refused requests.
 */
const lastStates = new Map<string, MembershipState>()
let watching: (() => void) | undefined

function watchNotReady(did: string) {
  if (!lastStates.has(did)) lastStates.set(did, getMembership(did))
  if (watching) return
  watching = subscribeMembership(() => {
    for (const [watched, previous] of Array.from(lastStates)) {
      const now = getMembership(watched)
      lastStates.set(watched, now)
      if (previous !== 'member' && now === 'member') liftLensNotReady(watched)
    }
  })
}

/** Tests: forget the watched states and the membership subscription. */
export function resetLensAvailability() {
  watching?.()
  watching = undefined
  lastStates.clear()
}

/** Whether prism serves the lens to `did`, kept current (3.2, TL-34). */
export function useLensServed(did: string | undefined): boolean {
  // Every read runs on every render (rules of hooks).
  const verdict = useSyncExternalStore(subscribePrismFeatures, () =>
    lensFeatureVerdict(did),
  )
  const membership = useMembership(did)
  const refused = useLensRefused(did)
  useEffect(() => {
    if (THREAD_LENS && did) watchNotReady(did)
  }, [did])
  if (!THREAD_LENS || !did) return false
  return servedBy(verdict, membership, refused)
}

/** Why the lens is not active on a screen where it could be (11.3). */
export type LensInactiveReason = 'off' | 'not-served'

/**
 * Whether the lens is active for `did`'s screen on `anchor` (5.1), and when
 * it is not, whether it is off or not served. `did` is the session's
 * account (the caller reads the session; this module stays free of it).
 */
export function useThreadLensActive(
  did: string | undefined,
  anchor: string | undefined,
): {
  active: boolean
  reason?: LensInactiveReason
} {
  const on = useThreadLensPreference(did)
  const served = useLensServed(did)
  if (!THREAD_LENS || !did || !anchor || isPrivatePostUri(anchor)) {
    return {active: false}
  }
  if (!served) return {active: false, reason: 'not-served'}
  if (!on) return {active: false, reason: 'off'}
  return {active: true}
}

/**
 * Whether a screen on `anchor` is lens-only for `did` (5.1, TL-25, TL-33):
 * the registry holds the URI as given, or the route carries the mark. Never
 * for a private anchor. The registry read runs first, on every render.
 */
export function useIsLensOnlyAnchor(
  did: string | undefined,
  anchor: string | undefined,
  marked: boolean,
): boolean {
  const held = useLensGapRegistered(did, anchor)
  return (
    THREAD_LENS &&
    !!did &&
    !!anchor &&
    !isPrivatePostUri(anchor) &&
    (marked || held)
  )
}
