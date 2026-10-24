/*
 * Where an account's private writes go (2K design 2). Two routes per account:
 *
 * - the **repo route**, from the PDS alone (PA-19, PA-4): `locus` when the
 *   account's PDS is a locus origin, or one that refused a raw kryphocron
 *   write in this run (PA-5); `stock` for any other PDS. It serves deletes and
 *   audience edits and deletes, and is known synchronously, so a delete never
 *   waits and never throws for lack of a route;
 * - the **posting route**, for new private writes (create, reply, thread,
 *   change of audience, audience create). It is computed, never stored
 *   (PA-1): `locus` on repo route `locus`; on repo route `stock`, `checking`
 *   until prism's membership answer may be acted on (PA-1a), then `encode`
 *   (the client encoder) for an account that may post privately on a prism
 *   listing `private.anyPds`, with `PRIVATE_POSTING_ANY_PDS` on and an
 *   encoder on this platform; else `none`.
 *
 * A write reads its routes once, at entry (PA-20), from the persisted session
 * account of `pdsClient.assertDid`, never from the published current clients
 * alone (they are set in a layout effect and cleared on sign-out). The hooks
 * read the published record. This module reads no session module.
 */

import {useSyncExternalStore} from 'react'
import {type Client, XrpcResponseError} from '@atproto/lex'

import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {encoderAvailable} from '#/horizon/private/encoder'
import {
  getCurrentClients,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  servesFeatureForWrite,
  subscribePrismFeatures,
} from '#/horizon/routing/features'
import {
  answerCurrent,
  getMembership,
  getPrivateIndexed,
  subscribeMembership,
} from '#/horizon/routing/membership'
import {PRIVATE_POSTING_ANY_PDS} from '#/horizon/switches'

/**
 * Which writer serves deletes and audience edits and deletes.
 */
export type RepoRoute = 'locus' | 'stock'

/**
 * Where an account's new private writes go.
 * - `checking`: repo route `stock`, the membership answer not yet current;
 *   Private is not offered yet.
 * - `locus`: locus's procedures, exactly as before 2K (D-0.10).
 * - `encode`: the client encoder, then stock repo writes (from 2K-3).
 * - `none`: repo route `stock`, answered, and not `encode`; the note of 8.1.
 */
export type PrivateWriteRoute = 'checking' | 'locus' | 'encode' | 'none'

/**
 * Why the posting route is `none`, when the note words it differently:
 * `no-encoder` when the only reason is that this platform cannot run the
 * encoder (D-0.13; a browser without WebAssembly or a CSRNG);
 * `other-account` for another signed-in account chosen in the composer's
 * "Posting as" control whose repo route is not `locus` (Phase 5 design 8.5,
 * P5R7-N2): its private posts are not offered from this account's session.
 */
export type PostingRouteReason = 'no-encoder' | 'other-account'

/**
 * An account's two routes, and what the `none` note's wording needs.
 * Snapshots are shared by value, so a hook's answer only changes when a
 * route does.
 */
export type WriteRoutes = {
  repoRoute: RepoRoute
  postingRoute: PrivateWriteRoute
  reason: PostingRouteReason | undefined
  /**
   * The probe answered `indexing` in this run (the note's wording, PA-3);
   * never `reindexing`, and never a private call's `NotReady`.
   */
  indexing: boolean
}

/**
 * The error names locus answers a raw write of `tools.kryphocron.*` with
 * (`aurora:error.rs:1214-1223`), always with status 400 (PA-5).
 */
const KRYPHOCRON_REFUSALS: readonly string[] = [
  'KryphocronRecordRequiresDedicatedEndpoint',
  'KryphocronRecordNotYetSupported',
]

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

function parseOrigins(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const origins = value
    .split(',')
    .map(item => originOf(item.trim()))
    .filter((origin): origin is string => !!origin)
  return origins.length > 0 ? origins : undefined
}

/**
 * The origins of locus deployments (the one `auth/signup-service.ts` names).
 * `EXPO_PUBLIC_LOCUS_PDS_ORIGINS` (comma-separated) replaces the list for
 * development; Expo inlines it only where it is read literally.
 */
export const LOCUS_PDS_ORIGINS: readonly string[] = parseOrigins(
  process.env.EXPO_PUBLIC_LOCUS_PDS_ORIGINS,
) ?? ['https://locus.nearhorizon.app']

/**
 * PDS origins that refused a raw kryphocron write in this run (PA-5). Not
 * stored on the device: the next run resolves again.
 */
const kryphocronHosts = new Set<string>()
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach(listener => listener())
}

/**
 * The repo route of a PDS URL, by its origin.
 */
export function repoRouteForUrl(url: string | undefined): RepoRoute {
  const origin = originOf(url)
  if (!origin) return 'stock'
  return LOCUS_PDS_ORIGINS.includes(origin) || kryphocronHosts.has(origin)
    ? 'locus'
    : 'stock'
}

/**
 * The PDS URL a signed-in account `did` writes to: its persisted session
 * account's `pdsUrl ?? service`, else the published current clients' when
 * they are for `did` (a test double, or an account removed mid-call).
 */
export function pdsUrlForDid(did: string | undefined): string | undefined {
  if (!did) return undefined
  const account = persisted
    .get('session')
    .accounts.find(item => item.did === did)
  if (account) return account.pdsUrl ?? account.service
  const current = getCurrentClients()
  return current?.did === did ? current.pdsUrl : undefined
}

/**
 * The repo route of the signed-in account `did`; `stock` when no URL is
 * known for it, which is safe: on a kryphocron host PA-5 matches the refusal
 * and flips the route.
 */
export function repoRouteForDid(did: string | undefined): RepoRoute {
  return repoRouteForUrl(pdsUrlForDid(did))
}

/**
 * The DID a PDS client writes as, or `undefined` for a client without a
 * session.
 */
export function clientDid(pdsClient: Client): string | undefined {
  try {
    return pdsClient.assertDid
  } catch {
    return undefined
  }
}

type PostingAnswer = Omit<WriteRoutes, 'repoRoute'>

const CHECKING: PostingAnswer = {
  postingRoute: 'checking',
  reason: undefined,
  indexing: false,
}

/**
 * The posting route of `did` on `repoRoute` (2.1). On repo route `stock` it
 * is `checking` until the membership facet is answered (PA-1a), and, for an
 * account that may post privately, the features facet too. Then `encode` when
 * that account's answer lists `private.anyPds`, `PRIVATE_POSTING_ANY_PDS` is
 * on and this platform can run the encoder (`none` with `no-encoder` when
 * only the encoder is missing); else `none`.
 *
 * Who may post privately: status `member` always, narrowed by
 * `permissions.privateIndexed` when the answer carries it. prism also sends
 * `privateIndexed: true` while an account is `indexing`, so it never grants
 * posting on its own. `encoderAvailable()` is a capability test; a failed
 * load of the encoder never moves the route.
 *
 * While prism re-indexes a member (prism busy design 2.3), the probe's
 * `reindexing` is an answered `member` with a member's permissions, so the
 * route is `encode` at once, and a private call's `NotReady` or `Reindexing`
 * answers nothing (BR-1): neither ever sends the route back to `checking` or
 * to the `indexing` note. Only the probe's own `indexing` does.
 */
export function resolvePostingRoute(
  did: string | undefined,
  repoRoute: RepoRoute,
): PostingAnswer {
  if (repoRoute === 'locus') {
    return {postingRoute: 'locus', reason: undefined, indexing: false}
  }
  if (!did) return CHECKING
  const answer = answerCurrent(did)
  if (!answer.membership) return CHECKING
  const state = getMembership(did)
  const indexing = state === 'indexing'
  const mayPost = state === 'member' && getPrivateIndexed(did) !== false
  if (mayPost && !answer.features) return CHECKING
  if (
    mayPost &&
    PRIVATE_POSTING_ANY_PDS &&
    servesFeatureForWrite('private.anyPds', did)
  ) {
    return encoderAvailable()
      ? {postingRoute: 'encode', reason: undefined, indexing}
      : {postingRoute: 'none', reason: 'no-encoder', indexing}
  }
  return {postingRoute: 'none', reason: undefined, indexing}
}

const snapshots = new Map<string, WriteRoutes>()

function snapshot(routes: WriteRoutes): WriteRoutes {
  const key = `${routes.repoRoute}|${routes.postingRoute}|${routes.reason ?? ''}|${routes.indexing}`
  const held = snapshots.get(key)
  if (held) return held
  snapshots.set(key, routes)
  return routes
}

function routesFor(did: string | undefined, url: string | undefined) {
  const repoRoute = repoRouteForUrl(url)
  return snapshot({repoRoute, ...resolvePostingRoute(did, repoRoute)})
}

/**
 * The routes of the signed-in account `did`, for a write at its entry
 * (PA-20). Pass `pdsClient.assertDid` (or {@link clientDid}).
 */
export function getWriteRoute(did: string | undefined): WriteRoutes {
  return routesFor(did, pdsUrlForDid(did))
}

/**
 * Called on every change that can move a route: membership, features, the
 * published clients, and a PA-5 match. Returns the unsubscribe function.
 */
export function subscribeWriteRoutes(listener: () => void) {
  listeners.add(listener)
  const unsubscribes = [
    subscribeMembership(listener),
    subscribePrismFeatures(listener),
    subscribeCurrentClients(listener),
  ]
  return () => {
    listeners.delete(listener)
    unsubscribes.forEach(unsubscribe => unsubscribe())
  }
}

/**
 * The current account's routes, as {@link useWriteRoute} reads them, for a
 * subscription that combines them with another store.
 */
export function currentRoutes(): WriteRoutes {
  const current = getCurrentClients()
  return routesFor(current?.did, current?.pdsUrl)
}

/**
 * Routes for an account that cannot post privately from this session: posting
 * route `none` for `reason`, on its repo route. Shared by value.
 */
export function noPostingRoutes(
  repoRoute: RepoRoute,
  reason: PostingRouteReason,
): WriteRoutes {
  return snapshot({repoRoute, postingRoute: 'none', reason, indexing: false})
}

/**
 * The current account's routes, kept current. The composer passes them to
 * its blockers as an argument (PA-26), so the blockers never read a store.
 */
export function useWriteRoute(): WriteRoutes {
  return useSyncExternalStore(subscribeWriteRoutes, currentRoutes)
}

/**
 * Whether `error` is locus's refusal of a raw `tools.kryphocron.*` write
 * (PA-5): status 400 with one of its two error names. No stock PDS sends
 * them.
 */
export function isKryphocronRefusal(error: unknown): boolean {
  return (
    error instanceof XrpcResponseError &&
    error.status === 400 &&
    KRYPHOCRON_REFUSALS.includes(error.error)
  )
}

/**
 * Record `did`'s PDS as a kryphocron host for the rest of the run (PA-5), so
 * its repo route, and so its posting route, become `locus`.
 */
export function markKryphocronHost(did: string | undefined) {
  const origin = originOf(pdsUrlForDid(did))
  if (!origin || kryphocronHosts.has(origin)) return
  kryphocronHosts.add(origin)
  logger.info('write-route: kryphocron host', {origin})
  notify()
}

/**
 * Forget the PA-5 marks (tests, and a relaunch in tests).
 */
export function resetWriteRoutes() {
  kryphocronHosts.clear()
  notify()
}
