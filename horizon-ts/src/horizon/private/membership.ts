/*
 * Membership as the private features read it: the current account's
 * membership state is `member` (Phase 1's machine, `routing/membership.ts`)
 * and its prism serves the private read methods (the `private` feature
 * family, 2H design 4.5; a prism without the membership query serves them).
 * Reads start from a state persisted on the device; composing a private post
 * waits for prism's answer in this run (`useIsConfirmedMember`).
 */

import {type Client} from '@atproto/lex'

import {useSession} from '#/state/session'
import {
  usePrismFeature,
  usePrismFeatureForWrite,
} from '#/horizon/private/features-hooks'
import {
  getCurrentDid,
  isCurrentFor,
  useCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  isPrivateMember,
  useConfirmedMember,
  useMembership,
} from '#/horizon/routing/membership'
import {PRIVATE_READING} from '#/horizon/switches'

/**
 * Whether the current account is a member, kept current.
 */
export function useIsMember(): boolean {
  const {currentAccount} = useSession()
  // Both hooks run unconditionally (rules of hooks).
  const state = useMembership(currentAccount?.did)
  const served = usePrismFeature('private')
  return state === 'member' && served
}

/**
 * Whether the current account is a member as prism answered in this run, not
 * only as persisted on the device, kept current. For what writes on the
 * strength of membership.
 */
export function useIsConfirmedMember(): boolean {
  const {currentAccount} = useSession()
  const confirmed = useConfirmedMember(currentAccount?.did)
  const served = usePrismFeatureForWrite('private')
  return confirmed && served
}

/**
 * Whether the published account (see `current-clients.ts`) is a member, for
 * code outside React.
 */
export function isMember(): boolean {
  return isPrivateMember(getCurrentDid())
}

/**
 * Where a member's private feed items come from.
 */
export type PrivateFeedSource = {
  did: string
  prism: Client
  appview: Client
}

/**
 * The private feed source for the current account, or `undefined` unless
 * `PRIVATE_READING` is on, the current-clients record belongs to the
 * session's account, and that account is a member. So no feed is ever
 * fetched with another account's clients during the render after an account
 * change in which the record is stale; the publish re-renders the caller.
 */
export function usePrivateFeedSource(): PrivateFeedSource | undefined {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const membership = useMembership(did)
  const served = usePrismFeature('private')
  const record = useCurrentClients()
  if (!PRIVATE_READING || membership !== 'member' || !served) return undefined
  if (!isCurrentFor(record, did)) return undefined
  return {
    did: record.did,
    prism: record.prismClient,
    appview: record.appviewClient,
  }
}
