/*
 * Moderating as a member of a cairn labeler's team, from Horizon.
 *
 * Every call goes through the moderator's own PDS with
 * `atproto-proxy: <labeler DID>#atproto_labeler`, as Ozone's own UI does:
 * the PDS mints the service token for that labeler and method, and the
 * labeler checks the moderator's role on its team. The labeler is chosen by
 * the proxy DID alone.
 */

import {type Client} from '@atproto/lex'

/** What a call is refused with: the HTTP status and the XRPC error name. */
export class ModerateCallError extends Error {
  constructor(
    readonly status: number,
    readonly error: string | undefined,
  ) {
    super(`Moderation call failed: ${status}${error ? ` ${error}` : ''}`)
    this.name = 'ModerateCallError'
  }
}

function service(labeler: string) {
  return `${labeler}#atproto_labeler`
}

async function errorOf(response: Response): Promise<ModerateCallError> {
  let error: string | undefined
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'error' in body) {
      error = typeof body.error === 'string' ? body.error : undefined
    }
  } catch {
    // No JSON body.
  }
  return new ModerateCallError(response.status, error)
}

async function query<T>(
  pdsClient: Client,
  labeler: string,
  nsid: string,
  params: Record<string, string | string[]> = {},
): Promise<T> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    for (const each of Array.isArray(value) ? value : [value]) {
      search.append(key, each)
    }
  }
  const qs = search.toString()
  const response = await pdsClient.agent.fetchHandler(
    `/xrpc/${nsid}${qs ? `?${qs}` : ''}`,
    {
      method: 'GET',
      headers: {'atproto-proxy': service(labeler), accept: 'application/json'},
    },
  )
  if (!response.ok) throw await errorOf(response)
  return (await response.json()) as T
}

async function procedure<T>(
  pdsClient: Client,
  labeler: string,
  nsid: string,
  body: unknown,
): Promise<T> {
  const response = await pdsClient.agent.fetchHandler(`/xrpc/${nsid}`, {
    method: 'POST',
    headers: {
      'atproto-proxy': service(labeler),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await errorOf(response)
  return (await response.json()) as T
}

/** The moderator's permissions on one labeler. */
export type TeamPermissions = {
  labeler: string
  did: string
  member: boolean
  permissions: string[]
}

export function getMyPermissions(pdsClient: Client, labeler: string) {
  return query<TeamPermissions>(
    pdsClient,
    labeler,
    'tools.cairn.team.getMyPermissions',
  )
}

/** A moderation subject: an account, or a record by URI and CID. */
export type ModerationSubject =
  | {$type: 'com.atproto.admin.defs#repoRef'; did: string}
  | {$type: 'com.atproto.repo.strongRef'; uri: string; cid: string}

/** The URI (or DID) a subject is known by in labels and statuses. */
export function subjectKey(subject: ModerationSubject): string {
  return subject.$type === 'com.atproto.admin.defs#repoRef'
    ? subject.did
    : subject.uri
}

/** The events the dialog sends. */
export type ModerationEvent =
  | {
      $type: 'tools.ozone.moderation.defs#modEventLabel'
      createLabelVals: string[]
      negateLabelVals: string[]
      comment?: string
      durationInHours?: number
    }
  | {
      $type: 'tools.ozone.moderation.defs#modEventTakedown'
      comment?: string
      durationInHours?: number
    }
  | {
      $type: 'tools.ozone.moderation.defs#modEventReverseTakedown'
      comment?: string
    }
  | {
      $type: 'tools.ozone.moderation.defs#modEventMute'
      durationInHours: number
      comment?: string
    }
  | {$type: 'tools.ozone.moderation.defs#modEventUnmute'; comment?: string}
  | {$type: 'tools.ozone.moderation.defs#modEventAcknowledge'; comment?: string}
  | {$type: 'tools.ozone.moderation.defs#modEventEscalate'; comment?: string}
  | {$type: 'tools.ozone.moderation.defs#modEventComment'; comment: string}

export function emitEvent(
  pdsClient: Client,
  labeler: string,
  {
    event,
    subject,
    createdBy,
  }: {event: ModerationEvent; subject: ModerationSubject; createdBy: string},
) {
  return procedure<{id: number}>(
    pdsClient,
    labeler,
    'tools.ozone.moderation.emitEvent',
    {event, subject, createdBy, subjectBlobCids: []},
  )
}

/** A label as a labeler serves it. */
export type QueriedLabel = {
  src: string
  uri: string
  cid?: string
  val: string
  neg?: boolean
  cts: string
  exp?: string
}

/**
 * The labeler's labels on `subject` that are in force now: the latest
 * record per value, unless that record negates it or has expired.
 */
export async function getCurrentLabels(
  pdsClient: Client,
  labeler: string,
  subject: ModerationSubject,
): Promise<QueriedLabel[]> {
  const key = subjectKey(subject)
  const answer = await query<{labels?: QueriedLabel[]}>(
    pdsClient,
    labeler,
    'com.atproto.label.queryLabels',
    {uriPatterns: key, sources: labeler, limit: '250'},
  )
  return currentLabels(answer.labels ?? [], key, labeler)
}

/** {@link getCurrentLabels}' rule, for tests. */
export function currentLabels(
  labels: QueriedLabel[],
  key: string,
  labeler: string,
  now = Date.now(),
): QueriedLabel[] {
  const latest = new Map<string, QueriedLabel>()
  for (const label of labels) {
    if (label.uri !== key || label.src !== labeler) continue
    const held = latest.get(label.val)
    if (!held || label.cts > held.cts) latest.set(label.val, label)
  }
  return [...latest.values()].filter(
    label => !label.neg && !(label.exp && Date.parse(label.exp) <= now),
  )
}

/** The labeler's status for a subject, as far as the dialog needs it. */
export type SubjectStatus = {
  reviewState?: string
  takendown?: boolean
  muteUntil?: string
  lastReportedAt?: string
  appealed?: boolean
}

export async function getSubjectStatus(
  pdsClient: Client,
  labeler: string,
  subject: ModerationSubject,
): Promise<SubjectStatus | undefined> {
  const answer = await query<{subjectStatuses?: SubjectStatus[]}>(
    pdsClient,
    labeler,
    'tools.ozone.moderation.queryStatuses',
    {subject: subjectKey(subject), limit: '1'},
  )
  return answer.subjectStatuses?.[0]
}

/** Whether the status has reports waiting for a moderator. */
export function hasOpenReports(status: SubjectStatus | undefined): boolean {
  return (
    status?.reviewState === 'tools.ozone.moderation.defs#reviewOpen' ||
    status?.reviewState === 'tools.ozone.moderation.defs#reviewEscalated'
  )
}
