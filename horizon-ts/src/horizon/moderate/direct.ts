/*
 * Moderating through a member labeler (one with no account or host): cairn's
 * direct methods, `POST <cairn>/direct/xrpc/<nsid>`, with the moderator's
 * own service token (`aud` cairn's bare service DID, `lxm` the method). The
 * labeler's id is only ever in a body.
 *
 * "labeler not available" (`400 InvalidRequest`) is final: not a member,
 * the labeler isn't theirs to see, or it's off. Only
 * `503 MembershipUnavailable` is worth trying again.
 */

import {type Client} from '@atproto/lex'
import {type NsidString} from '@atproto/syntax'

import {getServiceAuthToken} from '#/lib/media/video/upload.shared'
import {networkAwareFetch} from '#/state/session/network'
import {cairnUrl} from '#/horizon/cairn/primary-labeler'
import {cairnServiceDid} from '#/horizon/member-labelers/reports'
import {type ModerationEvent, type ModerationSubject} from './api'

export const DIRECT_METHODS = {
  permissions: 'tools.cairn.moderation.getDirectPermissions',
  labeler: 'tools.cairn.moderation.getDirectLabeler',
  subject: 'tools.cairn.moderation.getDirectSubject',
  emit: 'tools.cairn.moderation.emitDirectEvent',
} as const satisfies Record<string, NsidString>

/** A refused direct call: the status and the XRPC error name. */
export class DirectModerationError extends Error {
  constructor(
    readonly status: number,
    readonly error: string | undefined,
  ) {
    super(`Moderation call failed: ${status}${error ? ` ${error}` : ''}`)
    this.name = 'DirectModerationError'
  }

  get notAvailable(): boolean {
    return this.status === 400 && this.error === 'InvalidRequest'
  }

  get retryable(): boolean {
    return this.status === 503 || this.error === 'MembershipUnavailable'
  }
}

type Fetch = typeof fetch

async function call<T>(
  pdsClient: Client,
  lxm: NsidString,
  body: unknown,
  fetchImpl: Fetch = networkAwareFetch,
): Promise<T> {
  const base = cairnUrl()
  const aud = cairnServiceDid(base)
  if (!base || !aud) throw new DirectModerationError(0, 'NotConfigured')
  const token = await getServiceAuthToken({client: pdsClient, aud, lxm})
  const response = await fetchImpl(`${base}/direct/xrpc/${lxm}`, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let error: string | undefined
    try {
      const answer: unknown = await response.json()
      if (answer && typeof answer === 'object' && 'error' in answer) {
        error = typeof answer.error === 'string' ? answer.error : undefined
      }
    } catch {
      // No JSON body.
    }
    throw new DirectModerationError(response.status, error)
  }
  return (await response.json()) as T
}

export type DirectPermissions = {
  labeler: string
  name: string
  kind: string
  did: string
  member: boolean
  permissions: string[]
}

export async function getDirectPermissions(
  pdsClient: Client,
  fetchImpl?: Fetch,
): Promise<DirectPermissions[]> {
  const answer = await call<{labelers?: DirectPermissions[]}>(
    pdsClient,
    DIRECT_METHODS.permissions,
    {},
    fetchImpl,
  )
  return Array.isArray(answer.labelers) ? answer.labelers : []
}

export type DirectLabelValue = {
  identifier: string
  severity: string
  blurs: string
  defaultSetting: string
  adultOnly: boolean
  locales: {lang: string; name: string; description: string}[]
}

/** A labeler's reasons record: tokens, groups and their names. */
export type DirectReasons = {
  reasons?: {
    type: string
    group?: string
    locales?: {lang: string; title: string; description?: string}[]
  }[]
  groups?: {id: string; locales?: {lang: string; title: string}[]}[]
}

export type DirectFlagTarget = {
  did: string
  name: string
  reasonTypes: string[]
  canEscalate: boolean
}

export type DirectLabeler = {
  labeler: string
  name: string
  kind: string
  labelValues: DirectLabelValue[]
  audiences: {id: string; name: string}[]
  reasons?: DirectReasons
  policies: string[]
  severityLevels: string[]
  flagTargets?: DirectFlagTarget[]
}

export function getDirectLabeler(
  pdsClient: Client,
  labeler: string,
  fetchImpl?: Fetch,
) {
  return call<DirectLabeler>(
    pdsClient,
    DIRECT_METHODS.labeler,
    {labeler},
    fetchImpl,
  )
}

export type DirectSubject = {
  labels: {val: string; cts: string; exp?: string; audience?: string}[]
  openReportCount: number
  status?: {takendown?: boolean; muteUntil?: string; reviewState?: string}
}

export function getDirectSubject(
  pdsClient: Client,
  labeler: string,
  subject: ModerationSubject,
  fetchImpl?: Fetch,
) {
  return call<DirectSubject>(
    pdsClient,
    DIRECT_METHODS.subject,
    {labeler, subject},
    fetchImpl,
  )
}

export function emitDirectEvent(
  pdsClient: Client,
  labeler: string,
  {
    event,
    subject,
    audience,
  }: {event: ModerationEvent; subject: ModerationSubject; audience?: string},
  fetchImpl?: Fetch,
) {
  return call<{eventId?: number; flagId?: number}>(
    pdsClient,
    DIRECT_METHODS.emit,
    {labeler, subject, event, ...(audience ? {audience} : {})},
    fetchImpl,
  )
}
