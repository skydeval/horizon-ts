import {
  type InterpretedLabelValueDefinition,
  interpretLabelValueDefinition,
} from '@bsky/sdk/moderation'

import {type DirectLabeler} from './direct'
import {type TeamLabeler} from './permissions'

/** A member labeler's details as the Moderate dialog uses them. */
export function fromDirectLabeler(
  info: DirectLabeler,
  permissions: string[],
  locale = 'en',
): TeamLabeler {
  const defs: InterpretedLabelValueDefinition[] = []
  for (const value of info.labelValues ?? []) {
    try {
      defs.push(interpretLabelValueDefinition(value, info.labeler))
    } catch {
      // A malformed definition is skipped.
    }
  }
  const reasonNames: Record<string, string> = {}
  const groupNames = new Map<string, string>()
  for (const group of info.reasons?.groups ?? []) {
    const title = pickLocale(group.locales, locale)?.title
    if (title) groupNames.set(group.id, title)
  }
  const reasonTypes: string[] = []
  for (const reason of info.reasons?.reasons ?? []) {
    if (typeof reason.type !== 'string') continue
    reasonTypes.push(reason.type)
    const title = pickLocale(reason.locales, locale)?.title
    if (!title) continue
    const group = reason.group ? groupNames.get(reason.group) : undefined
    reasonNames[reason.type] = group ? `${group}: ${title}` : title
  }
  return {
    source: 'member',
    did: info.labeler,
    name: info.name,
    kind: info.kind === 'labels_only' ? 'labels_only' : 'moderation',
    permissions: new Set(permissions),
    defs,
    reasonTypes,
    reasonNames,
    audiences: (info.audiences ?? []).map(({id, name}) => ({id, name})),
    flagTargets: info.flagTargets ?? [],
  }
}

function pickLocale<T extends {lang: string}>(
  locales: T[] | undefined,
  locale: string,
): T | undefined {
  return (
    locales?.find(each => locale.startsWith(each.lang)) ??
    locales?.find(each => each.lang.startsWith('en')) ??
    locales?.[0]
  )
}
