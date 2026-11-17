/*
 * One way for the Moderate dialog to read a subject and send an event,
 * whichever kind of labeler is chosen: a public one through the PDS proxy,
 * a member labeler through cairn's direct methods.
 */

import {type Client} from '@atproto/lex'

import {
  emitEvent,
  getCurrentLabels,
  getSubjectStatus,
  hasOpenReports,
  type ModerationEvent,
  type ModerationSubject,
} from './api'
import {emitDirectEvent, getDirectSubject} from './direct'
import {type TeamLabeler} from './permissions'

/** A label in force on a subject, from the chosen labeler. */
export type SubjectLabel = {val: string; audience?: string}

/** What the dialog shows about a subject. */
export type SubjectState = {
  labels: SubjectLabel[]
  takendown: boolean
  muted: boolean
  openReports: number
}

export async function loadSubject(
  pdsClient: Client,
  labeler: TeamLabeler,
  subject: ModerationSubject,
  now = Date.now(),
): Promise<SubjectState> {
  if (labeler.source === 'member') {
    const answer = await getDirectSubject(pdsClient, labeler.did, subject)
    return {
      labels: (answer.labels ?? [])
        .filter(label => !(label.exp && Date.parse(label.exp) <= now))
        .map(({val, audience}) => (audience ? {val, audience} : {val})),
      takendown: !!answer.status?.takendown,
      muted: false,
      openReports: answer.openReportCount ?? 0,
    }
  }
  const [labels, status] = await Promise.all([
    getCurrentLabels(pdsClient, labeler.did, subject),
    getSubjectStatus(pdsClient, labeler.did, subject),
  ])
  return {
    labels: labels.map(({val}) => ({val})),
    takendown: !!status?.takendown,
    muted: !!status?.muteUntil && Date.parse(status.muteUntil) > now,
    openReports: hasOpenReports(status) ? 1 : 0,
  }
}

export function sendEvent(
  pdsClient: Client,
  labeler: TeamLabeler,
  {
    event,
    subject,
    audience,
    createdBy,
  }: {
    event: ModerationEvent
    subject: ModerationSubject
    audience?: string
    createdBy: string
  },
): Promise<unknown> {
  return labeler.source === 'member'
    ? emitDirectEvent(pdsClient, labeler.did, {event, subject, audience})
    : emitEvent(pdsClient, labeler.did, {event, subject, createdBy})
}
