/*
 * Pure formatting for pronouns, fronters and the front (Phase 5 design 5.1,
 * 6.1): forms are shown exactly as typed (pronouns spec rule 4), trimmed
 * only for display; a set joins its forms with `/`, and sets join with a
 * middle dot with a space either side. Nothing here splits a form.
 */

import {type MessageDescriptor} from '@lingui/core'
import {msg} from '@lingui/core/macro'

import {type Pronouns} from '#/horizon/identity/parse'

/** The separator between sets: space, U+00B7 MIDDLE DOT, space. */
export const SET_SEPARATOR = ' · '

/** The marker after fronters' names on posts and the profile header. */
export const FRONTERS_MARKER = '&'

/** One set: its forms, trimmed for display, joined with `/`. */
export function formatSet(forms: readonly string[]): string {
  return forms
    .map(form => form.trim())
    .filter(form => form.length > 0)
    .join('/')
}

/** Sets joined with {@link SET_SEPARATOR}, empty sets left out. */
export function formatSets(sets: readonly (readonly string[])[]): string {
  return sets
    .map(formatSet)
    .filter(set => set.length > 0)
    .join(SET_SEPARATOR)
}

/**
 * A pronouns record as its author asked (`displayMode`): every set, or the
 * first only. Empty `sets` gives `''` (show nothing).
 */
export function formatPronouns(
  pronouns: Pick<Pronouns, 'sets' | 'displayMode'>,
  mode: Pronouns['displayMode'] = pronouns.displayMode,
): string {
  if (pronouns.sets.length === 0) return ''
  return mode === 'firstOnly'
    ? formatSet(pronouns.sets[0])
    : formatSets(pronouns.sets)
}

/**
 * Fronters' names for an author line or header: joined with ", ", then the
 * `&` marker after the last (6.2, 6.3). Blank names are left out; none left
 * gives `''`.
 */
export function formatFronterNames(names: readonly string[]): string {
  const kept = names.map(name => name.trim()).filter(name => name.length > 0)
  if (kept.length === 0) return ''
  return `${kept.join(', ')}${FRONTERS_MARKER}`
}

/** A member's label: its emoji, when set, then its name. */
export function formatMemberLabel(member: {
  displayName: string
  emoji?: string
}): string {
  const emoji = member.emoji?.trim()
  const name = member.displayName.trim()
  return emoji ? `${emoji} ${name}` : name
}

/**
 * The front states given readable labels. Any other value, Horizon 1.0's
 * `co-front` and `just-switched` included, is shown as typed (PP-13).
 */
const FRONT_STATE_LABELS: Record<string, MessageDescriptor> = {
  solo: msg({message: 'Solo', comment: 'A plural system front state'}),
  'co-fronting': msg({
    message: 'Co-fronting',
    comment: 'A plural system front state',
  }),
  switching: msg({
    message: 'Switching',
    comment: 'A plural system front state',
  }),
}

/**
 * The front's `state` for display: a message to translate for a known
 * value, the value as typed (trimmed) otherwise, `undefined` when unset or
 * blank.
 */
export function formatFrontState(
  state: string | undefined,
): MessageDescriptor | string | undefined {
  const typed = state?.trim()
  if (!typed) return undefined
  return Object.hasOwn(FRONT_STATE_LABELS, typed)
    ? FRONT_STATE_LABELS[typed]
    : typed
}
