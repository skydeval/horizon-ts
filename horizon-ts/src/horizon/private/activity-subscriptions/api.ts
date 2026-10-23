/*
 * The requests of activity subscriptions (activity subscriptions design 2.2
 * and 2.3; the prism handoff, section 2): Bluesky's put and profile read on
 * the account's AppView client, for the public pair, and prism's private put
 * and list on its prism client, for the private pair. Each takes the client
 * it is given, never the current account's, so a save finishes with the
 * clients captured at press (F7-7).
 */

import {
  type Client,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'

import {nearhorizon} from '#/horizon/lexicons'
import {
  type Flags,
  readFlags,
} from '#/horizon/private/activity-subscriptions/common'
import {
  reportedPrismCall,
  reportedPrismWrite,
} from '#/horizon/private/api/reads'
import {leadErrorOf} from '#/horizon/private/api/transient'
import {app} from '#/lexicons'

/** Bluesky's put of the public pair (the stock dialog's request). */
export async function putBlueskySubscription(
  appview: Client,
  subject: string,
  flags: Flags,
): Promise<void> {
  await appview.call(app.bsky.notification.putActivitySubscription, {
    subject: subject as DidString,
    activitySubscription: {post: flags.post, reply: flags.reply},
  })
}

/** What Bluesky's profile of the subject says about the public pair. */
export type BlueskyBell = {flags: Flags}

/**
 * One `app.bsky.actor.getProfile` of the subject (not `getProfiles`),
 * reading `viewer.activitySubscription` as the stock dialog does: an absent
 * field is off. The public pair's truth read.
 */
export async function readBlueskyBell(
  appview: Client,
  subject: string,
): Promise<BlueskyBell> {
  const profile = await appview.call(app.bsky.actor.getProfile, {
    actor: subject as DidString,
  })
  return {flags: readFlags(profile.viewer?.activitySubscription)}
}

/**
 * prism's private put. A write (prism busy design 2.2, FU-3): it goes at
 * once, and its outcome is reported to health and membership for the
 * client's own account. Resolves with the flags prism accepted (absent is
 * off).
 */
export async function putPrismSubscription(
  prism: Client,
  subject: string,
  flags: Flags,
): Promise<Flags> {
  const output = await reportedPrismWrite(
    nearhorizon.privatePutActivitySubscription,
    {
      did: prism.did,
      send: () =>
        prism.call(nearhorizon.privatePutActivitySubscription, {
          subject: subject as DidString,
          activitySubscription: {post: flags.post, reply: flags.reply},
        }),
    },
  )
  return readFlags(output.activitySubscription)
}

/** One prism row as listed. */
export type PrismRow = {subject: string; flags: Flags}

/**
 * One page of prism's private list. A read (prism busy design 2, FU-3):
 * through the throttle, with the call deadline.
 *
 * `shared` (default `true`) lets the page join an earlier identical call
 * while the account is throttled. `false` leaves `params` out of the read
 * the wrapper is given (they are still sent), so the single-flight join never
 * hands it a lead's body: as a waiter it is sent on its own after the lead
 * ends, and as the lead no waiter takes its answer (design 2.2). prism's
 * truth read passes `false`.
 */
export async function listPrismSubscriptions(
  prism: Client,
  {limit, cursor}: {limit: number; cursor?: string},
  {shared = true}: {shared?: boolean} = {},
): Promise<{rows: PrismRow[]; cursor?: string}> {
  const params = {limit, cursor}
  const {body: res} = await reportedPrismCall(
    nearhorizon.privateListActivitySubscriptions,
    {
      did: prism.did,
      ...(shared ? {params} : {}),
      send: signal =>
        prism.call(nearhorizon.privateListActivitySubscriptions, params, {
          signal,
        }),
    },
  )
  return {
    rows: res.subscriptions.map(row => ({
      subject: row.subject,
      flags: readFlags(row.activitySubscription),
    })),
    cursor: res.cursor,
  }
}

/**
 * How a prism refusal is worded (design 2.3, the toasts):
 * - `limit`: `LimitReached` (the cap of rows), the one refusal the member can
 *   act on;
 * - `other`: anything else.
 *
 * A waiter's error (`PrivateWaiterError`, when a list read waited behind the
 * account's lead call) is read through its `cause`, the lead's, as the
 * shared classifier reads it.
 */
export type PrismFailure = 'limit' | 'other'

export function classifyPrismError(error: unknown): PrismFailure {
  const lead = leadErrorOf(error)
  if (lead instanceof XrpcResponseError && lead.error === 'LimitReached') {
    return 'limit'
  }
  return 'other'
}

/**
 * Whether a request to either store was answered (an error with a
 * response), rather than failing in transport (offline, DNS, a reset), where
 * the put may still have reached the store.
 */
export function wasAnswered(error: unknown): boolean {
  return (
    error instanceof XrpcResponseError ||
    error instanceof XrpcInvalidResponseError
  )
}

/**
 * A failure name for logs: the XRPC error, or the error class; a waiter's,
 * its lead's.
 */
export function failureName(error: unknown): string {
  const lead = leadErrorOf(error)
  if (lead instanceof XrpcResponseError) return lead.error
  return lead instanceof Error ? lead.name : typeof lead
}
