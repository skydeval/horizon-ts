/*
 * Feedback to Horizon: reports go to Horizon's own push service, sent
 * through the account's PDS like push registration, so the service knows who
 * sent them. Only accounts on the service's admin list can read them.
 * Technical details are included only when the sender ticks the box: the
 * app version, platform and system; never post text.
 */

import {Platform} from 'react-native'
import {XrpcResponseError} from '@atproto/lex'

import {APP_VERSION, IS_WEB} from '#/env'
import {nearhorizon} from '#/horizon/lexicons'
import {HORIZON_PUSH_SERVICE} from '#/horizon/push/config'
import {getCurrentPdsClient} from '#/horizon/routing/current-clients'

export type FeedbackKind = 'bug' | 'idea' | 'other'

/** The longest message the service takes, in characters. */
export const FEEDBACK_TEXT_MAX = 5000

/** Why a report couldn't be sent. */
export class FeedbackError extends Error {
  constructor(readonly reason: 'signed-out' | 'rate-limited' | 'failed') {
    super(`feedback ${reason}`)
    this.name = 'FeedbackError'
  }
}

/** The technical details a sender may include. */
export function feedbackDetails(): Record<string, string> {
  const details: Record<string, string> = {
    version: APP_VERSION,
    platform: Platform.OS,
    system: String(Platform.Version ?? ''),
  }
  if (IS_WEB && typeof navigator !== 'undefined') {
    details.browser = navigator.userAgent.slice(0, 300)
  }
  return details
}

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof XrpcResponseError &&
    (error.status === 429 ||
      (error as {error?: unknown}).error === 'RateLimitExceeded')
  )
}

/** Send one report as the signed-in account. */
export async function sendFeedback({
  kind,
  text,
  includeDetails,
}: {
  kind: FeedbackKind
  text: string
  includeDetails: boolean
}): Promise<void> {
  const client = getCurrentPdsClient()
  if (!client) throw new FeedbackError('signed-out')
  try {
    await client.call(
      nearhorizon.feedbackSubmit,
      {
        kind,
        text: text.trim(),
        ...(includeDetails ? {details: feedbackDetails()} : {}),
      },
      {service: HORIZON_PUSH_SERVICE},
    )
  } catch (error) {
    throw new FeedbackError(isRateLimited(error) ? 'rate-limited' : 'failed')
  }
}

/** One report, as the inbox shows it. */
export type FeedbackReport = {
  id: number
  did: string
  kind: FeedbackKind
  text: string
  details?: Record<string, string>
  createdAt: string
  done: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The reports of a list answer, checked; odd ones are left out. */
export function readReports(items: readonly unknown[]): FeedbackReport[] {
  const reports: FeedbackReport[] = []
  for (const item of items) {
    if (!isObject(item)) continue
    const {id, did, kind, text, details, createdAt, done} = item
    if (
      typeof id !== 'number' ||
      typeof did !== 'string' ||
      (kind !== 'bug' && kind !== 'idea' && kind !== 'other') ||
      typeof text !== 'string' ||
      typeof createdAt !== 'string' ||
      typeof done !== 'boolean'
    ) {
      continue
    }
    const kept: Record<string, string> = {}
    if (isObject(details)) {
      for (const [key, value] of Object.entries(details)) {
        if (typeof value === 'string') kept[key] = value
      }
    }
    reports.push({
      id,
      did,
      kind,
      text,
      createdAt,
      done,
      ...(Object.keys(kept).length > 0 ? {details: kept} : {}),
    })
  }
  return reports
}

function isForbidden(error: unknown): boolean {
  return error instanceof XrpcResponseError && error.status === 403
}

/**
 * A page of reports, newest first, or `'forbidden'` when the signed-in
 * account is not a feedback admin.
 */
export async function listFeedback({
  cursor,
  done,
  limit = 50,
}: {
  cursor?: string
  done?: boolean
  limit?: number
} = {}): Promise<
  {reports: FeedbackReport[]; cursor?: string} | 'forbidden'
> {
  const client = getCurrentPdsClient()
  if (!client) return 'forbidden'
  try {
    const res = await client.call(
      nearhorizon.feedbackList,
      {
        limit,
        ...(cursor ? {cursor} : {}),
        ...(done !== undefined ? {done} : {}),
      },
      {service: HORIZON_PUSH_SERVICE},
    )
    return {
      reports: readReports(res.items),
      ...(res.cursor ? {cursor: res.cursor} : {}),
    }
  } catch (error) {
    if (isForbidden(error)) return 'forbidden'
    throw error
  }
}

/** Mark a report done, or open again. */
export async function markFeedback(id: number, done: boolean): Promise<void> {
  const client = getCurrentPdsClient()
  if (!client) throw new FeedbackError('signed-out')
  await client.call(
    nearhorizon.feedbackUpdate,
    {id, done},
    {service: HORIZON_PUSH_SERVICE},
  )
}
