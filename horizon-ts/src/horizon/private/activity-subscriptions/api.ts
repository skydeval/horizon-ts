/*
 * The requests of activity subscriptions for private posts (activity
 * subscriptions design 2.1 to 2.3; the prism handoff, section 2): Bluesky's
 * put, list and profile read on the account's AppView client, and prism's
 * private put and list on its prism client. Each takes the client it is
 * given, never the current account's, so a save finishes with the clients
 * captured at press (F-8).
 */

import {
  type Client,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'
import {type DatetimeString, type DidString} from '@atproto/syntax'

import {nearhorizon} from '#/horizon/lexicons'
import {
  type Flags,
  readFlags,
} from '#/horizon/private/activity-subscriptions/common'
import {app} from '#/lexicons'

/** Bluesky's put of the bell (the stock dialog's request). */
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

/** What Bluesky's profile of the subject says about the bell. */
export type BlueskyBell = {
  flags: Flags
  /** A block either way, or through a list. */
  blocked: boolean
  /** Whether `viewer.activitySubscription` was present. */
  present: boolean
}

/**
 * One `app.bsky.actor.getProfile` of the subject (not `getProfiles`),
 * reading `viewer.activitySubscription` as the stock dialog does: an absent
 * field is off.
 */
export async function readBlueskyBell(
  appview: Client,
  subject: string,
): Promise<BlueskyBell> {
  const profile = await appview.call(app.bsky.actor.getProfile, {
    actor: subject as DidString,
  })
  const viewer = profile.viewer
  return {
    flags: readFlags(viewer?.activitySubscription),
    present: !!viewer?.activitySubscription,
    blocked: !!(
      viewer?.blocking ||
      viewer?.blockedBy ||
      viewer?.blockingByList
    ),
  }
}

/** One page of Bluesky's list: each subject with its flags. */
export async function listBlueskySubscriptions(
  appview: Client,
  {limit, cursor}: {limit: number; cursor?: string},
): Promise<{
  subscriptions: {subject: string; flags: Flags}[]
  cursor?: string
}> {
  const res = await appview.call(
    app.bsky.notification.listActivitySubscriptions,
    {limit, cursor},
  )
  return {
    subscriptions: res.subscriptions.map(profile => ({
      subject: profile.did,
      flags: readFlags(profile.viewer?.activitySubscription),
    })),
    cursor: res.cursor,
  }
}

/**
 * prism's private put. `ifNotChangedSince` only from the reconcile.
 */
export async function putPrismSubscription(
  prism: Client,
  subject: string,
  flags: Flags,
  ifNotChangedSince?: string,
): Promise<void> {
  await prism.call(nearhorizon.privatePutActivitySubscription, {
    subject: subject as DidString,
    activitySubscription: {post: flags.post, reply: flags.reply},
    ...(ifNotChangedSince
      ? {ifNotChangedSince: ifNotChangedSince as DatetimeString}
      : {}),
  })
}

/** One prism row as listed. */
export type PrismRow = {subject: string; flags: Flags; updatedAt: string}

/** One page of prism's private list; `asOf` is the database's time. */
export async function listPrismSubscriptions(
  prism: Client,
  {limit, cursor}: {limit: number; cursor?: string},
): Promise<{asOf: string; rows: PrismRow[]; cursor?: string}> {
  const res = await prism.call(nearhorizon.privateListActivitySubscriptions, {
    limit,
    cursor,
  })
  return {
    asOf: res.asOf,
    rows: res.subscriptions.map(row => ({
      subject: row.subject,
      flags: readFlags(row.activitySubscription),
      updatedAt: row.updatedAt,
    })),
    cursor: res.cursor,
  }
}

/**
 * How a prism answer is handled:
 * - `invalid`: `InvalidRequest` (the subject is the member, or malformed);
 * - `not-enrolled`: `NotEnrolled`;
 * - `conflict`: `Conflict` (the reconcile's compare-and-set refused);
 * - `limit`: `LimitReached` (the cap of active rows);
 * - `transient`: anything else, `NotReady`, 5xx, 429 and network failures
 *   among them.
 */
export type PrismFailure =
  'invalid' | 'not-enrolled' | 'conflict' | 'limit' | 'transient'

export function classifyPrismError(error: unknown): PrismFailure {
  if (error instanceof XrpcResponseError) {
    switch (error.error) {
      case 'InvalidRequest':
        return 'invalid'
      case 'NotEnrolled':
        return 'not-enrolled'
      case 'Conflict':
        return 'conflict'
      case 'LimitReached':
        return 'limit'
    }
  }
  return 'transient'
}

/**
 * Whether a Bluesky request was answered (an error with a response), rather
 * than failing in transport (offline, DNS, a reset), where the put may
 * still have reached Bluesky.
 */
export function wasAnswered(error: unknown): boolean {
  return (
    error instanceof XrpcResponseError ||
    error instanceof XrpcInvalidResponseError
  )
}

/** A failure name for logs: the XRPC error, or the error class. */
export function failureName(error: unknown): string {
  if (error instanceof XrpcResponseError) return error.error
  return error instanceof Error ? error.name : typeof error
}
