import {type InterpretedLabelValueDefinition} from '@bsky/sdk/moderation'

/** cairn's permission ids the Moderate dialog acts on. */
export const PERMISSIONS = {
  /** Apply and negate labels. */
  labels: 'labels.apply',
  /** `!` system labels (`!hide`, `!warn`). */
  systemLabels: 'labels.system',
  takedowns: 'takedowns',
  mutes: 'mutes',
  /** Acknowledge, escalate, comment. */
  triage: 'cases.triage',
} as const

/** The system label values offered with {@link PERMISSIONS.systemLabels}. */
export const SYSTEM_LABEL_VALUES = ['!hide', '!warn'] as const

/** A labeler this account moderates for. */
export type TeamLabeler = {
  did: string
  name: string
  permissions: ReadonlySet<string>
  /** The values it defines, interpreted, in its own order. */
  defs: InterpretedLabelValueDefinition[]
}
