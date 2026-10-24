/*
 * The front switcher's model (Phase 5 design 7.3), pure: the choices read
 * from the front record, and the members to write from them.
 */

import {FRONT_STATUSES} from '#/horizon/identity/edit/suggestions'
import {type PluralFront} from '#/horizon/identity/parse'
import {type MemberList} from '#/horizon/identity/queries'
import {type FrontInput} from '#/horizon/identity/writes'

/** One checked member's status; `other` when typed as free text. */
export type FrontChoice = {status: string; other: boolean}

const KNOWN_STATUSES = new Set(FRONT_STATUSES.map(s => s.value))

/** Whether a status is one of the offered ones (else "Other..."). */
export function isKnownStatus(status: string): boolean {
  return KNOWN_STATUSES.has(status)
}

/** The switcher's choices from the front read (absent status: engaging). */
export function choicesFrom(
  front: PluralFront | undefined,
): Map<string, FrontChoice> {
  const choices = new Map<string, FrontChoice>()
  for (const member of front?.members ?? []) {
    const status = member.status ?? 'engaging'
    choices.set(member.id, {status, other: !isKnownStatus(status)})
  }
  return choices
}

/**
 * The members to write, in member-list order (ascending rkey). Entries for
 * ids not in the list are kept only while the list is partial (they may be
 * members not listed); with a complete list they name deleted members and
 * are dropped. A blank "Other..." status is written as engaging.
 */
export function frontMembersFrom(
  choices: ReadonlyMap<string, FrontChoice>,
  list: MemberList,
): FrontInput['members'] {
  const listed = new Set(list.members.map(m => m.rkey))
  const ordered = list.members.filter(m => choices.has(m.rkey)).map(m => m.rkey)
  const extra = list.partial
    ? [...choices.keys()].filter(id => !listed.has(id)).sort()
    : []
  return [...ordered, ...extra].map(id => {
    const status = choices.get(id)?.status.trim() || 'engaging'
    return {id, status}
  })
}
