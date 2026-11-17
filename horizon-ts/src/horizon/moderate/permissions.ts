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
  /**
   * `public`: a labeler with an account, reached through the PDS proxy.
   * `member`: one that exists only for Horizon members, reached through
   * cairn's direct methods.
   */
  source: 'public' | 'member'
  /** The DID, or a member labeler's opaque id. */
  did: string
  name: string
  /** `labels_only` labelers only take a label, one value at a time. */
  kind: 'moderation' | 'labels_only'
  permissions: ReadonlySet<string>
  /** The values it defines, interpreted, in its own order. */
  defs: InterpretedLabelValueDefinition[]
  /** The report reasons it accepts (tokens). */
  reasonTypes: string[]
  /** Names for reason tokens the labeler itself gives (member labelers). */
  reasonNames: Record<string, string>
  /** Who a member labeler's label can be limited to. */
  audiences: {id: string; name: string}[]
  /** The public labelers a member labeler's moderators may flag to. */
  flagTargets: {
    did: string
    name: string
    reasonTypes: string[]
    canEscalate: boolean
  }[]
}

/** Whether a labeler takes takedowns and mutes (member labelers don't). */
export function takesTakedowns(labeler: TeamLabeler): boolean {
  return labeler.source === 'public'
}

/**
 * A reason token as readable text, when no name is known for it:
 * `tools.ozone.report.defs#reasonMisleadingSpam` reads "Misleading spam".
 */
export function reasonFallbackName(token: string): string {
  const name = (token.split('#')[1] ?? token).replace(/^reason/, '')
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
  if (!words) return token
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

/**
 * The text kept with an action: the chosen reason (name and token, so it
 * reads and can be searched) above the moderator's note.
 */
export function actionComment(
  reason: {token: string; name: string} | undefined,
  note: string,
): string | undefined {
  const parts = [
    reason ? `Reason: ${reason.name} (${reason.token})` : undefined,
    note.trim() || undefined,
  ].filter(Boolean)
  return parts.length ? parts.join('\n') : undefined
}
