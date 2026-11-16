/*
 * Member labelers in moderation: each is added to the moderation options
 * for everything (with its own defaults, as a labeler nobody configured),
 * and to the label definitions the label UI reads. They are never added to
 * the account's subscriptions or to any request header.
 *
 * Both take the store's snapshot as an argument rather than reading the
 * store, so the providers that call them in render recompute when it
 * changes (React Compiler caches plain store reads).
 */

import {type DidString} from '@atproto/syntax'
import {
  type InterpretedLabelValueDefinition,
  type ModerationOpts,
} from '@bsky/sdk/moderation'

import {type app} from '#/lexicons'
import {type MemberLabelersSnapshot} from './store'

/** `opts` with the account's member labelers added, or `opts` itself. */
export function withMemberLabelers(
  opts: ModerationOpts,
  did: string | undefined,
  {account, labelers}: MemberLabelersSnapshot,
): ModerationOpts {
  if (!did || did !== account || labelers.length === 0) return opts
  const have = new Set(opts.prefs.labelers.map(entry => entry.did))
  const added = labelers.filter(labeler => !have.has(labeler.id as DidString))
  if (added.length === 0) return opts
  const labelDefs = {...opts.labelDefs}
  for (const labeler of added) labelDefs[labeler.id] = labeler.defs
  return {
    ...opts,
    prefs: {
      ...opts.prefs,
      labelers: [
        ...opts.prefs.labelers,
        ...added.map(labeler => ({did: labeler.id as DidString, labels: {}})),
      ],
    },
    labelDefs,
  }
}

/** The label UI's definitions and labeler views, with member labelers. */
export function withMemberLabelDefinitions<
  T extends {
    labelDefs: Record<string, InterpretedLabelValueDefinition[]>
    labelers: app.bsky.labeler.defs.LabelerViewDetailed[]
  },
>(
  state: T,
  did: string | undefined,
  {account, labelers}: MemberLabelersSnapshot,
): T {
  if (!did || did !== account || labelers.length === 0) return state
  const labelDefs = {...state.labelDefs}
  for (const labeler of labelers) labelDefs[labeler.id] = labeler.defs
  return {
    ...state,
    labelDefs,
    labelers: [
      ...state.labelers.filter(
        view => !labelers.some(labeler => labeler.id === view.creator.did),
      ),
      ...labelers.map(labeler => labeler.view),
    ],
  }
}
