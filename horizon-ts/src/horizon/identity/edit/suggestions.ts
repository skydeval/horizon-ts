/*
 * Suggested values for the member editor and the front switcher (Phase 5
 * design 7.2, 7.3, 7.4). Each was checked against the respectful-naming
 * rule (7.4's table): no slur meanings and no charged words in anything
 * users see. Not suggested: "little" (marks a member as a child on a public
 * list, and reads as an age-play term outside plural communities) and
 * "gatekeeper" (a hostile word in trans healthcare). Any value can still be
 * typed (PL "Extensible by convention").
 *
 * Roles and member types are two fields with two lists (P5R1-L8): a
 * suggestion is written only into its own field. The values are written
 * into records as conventions of the plural spec, so they are not
 * translated; the front's status and state labels are.
 */

import {type MessageDescriptor} from '@lingui/core'
import {msg} from '@lingui/core/macro'

/** `member.roles` suggestions. */
export const ROLE_SUGGESTIONS: readonly string[] = [
  'host',
  'protector',
  'caretaker',
  'memory holder',
]

/** `member.memberTypes` suggestions (the plural spec's own examples). */
export const MEMBER_TYPE_SUGGESTIONS: readonly string[] = [
  'fronter',
  'co-fronter',
  'non-fronter',
]

/** The front switcher's member statuses (PL's and Horizon 1.0's). */
export const FRONT_STATUSES: readonly {
  value: string
  label: MessageDescriptor
}[] = [
  {
    value: 'engaging',
    label: msg({message: 'Engaging', comment: 'A front member status'}),
  },
  {
    value: 'co-conscious',
    label: msg({message: 'Co-conscious', comment: 'A front member status'}),
  },
  {
    value: 'observing',
    label: msg({message: 'Observing', comment: 'A front member status'}),
  },
  {
    value: 'dormant',
    label: msg({message: 'Dormant', comment: 'A front member status'}),
  },
  {
    value: 'nonverbal',
    label: msg({message: 'Nonverbal', comment: 'A front member status'}),
  },
  {
    value: 'blurry',
    label: msg({message: 'Blurry', comment: 'A front member status'}),
  },
]

/** The front switcher's states. */
export const FRONT_STATES: readonly {
  value: string
  label: MessageDescriptor
}[] = [
  {value: 'solo', label: msg({message: 'Solo', comment: 'A front state'})},
  {
    value: 'co-fronting',
    label: msg({message: 'Co-fronting', comment: 'A front state'}),
  },
  {
    value: 'switching',
    label: msg({message: 'Switching', comment: 'A front state'}),
  },
  {value: 'blurry', label: msg({message: 'Blurry', comment: 'A front state'})},
  {
    value: 'unknown',
    label: msg({message: 'Unknown', comment: 'A front state'}),
  },
]

/** Swatches offered beside the colour's hex field. */
export const COLOR_PRESETS: readonly {
  value: string
  label: MessageDescriptor
}[] = [
  {value: '#E5484D', label: msg({message: 'Red', comment: 'A colour'})},
  {value: '#F76B15', label: msg({message: 'Orange', comment: 'A colour'})},
  {value: '#FFC53D', label: msg({message: 'Yellow', comment: 'A colour'})},
  {value: '#30A46C', label: msg({message: 'Green', comment: 'A colour'})},
  {value: '#12A594', label: msg({message: 'Teal', comment: 'A colour'})},
  {value: '#0090FF', label: msg({message: 'Blue', comment: 'A colour'})},
  {value: '#8E4EC6', label: msg({message: 'Purple', comment: 'A colour'})},
  {value: '#D6409F', label: msg({message: 'Pink', comment: 'A colour'})},
  {value: '#8B8D98', label: msg({message: 'Grey', comment: 'A colour'})},
]
