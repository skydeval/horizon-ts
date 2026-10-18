/*
 * Pure helpers of the audience drop-down's reply and quote sections (4.2.1,
 * 4.2.2): the stock interaction form's transitions, its summary label, the
 * stock "save as default" comparison, and whether the stock pill is shown.
 * A plain module, so it is tested without the design system.
 */

import {type AtUriString, toDatetimeString} from '@atproto/syntax'
import deepEqual from 'fast-deep-equal'

import {embeddingRules} from '#/state/queries/postgate/util'
import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {threadgateRecordToAllowUISetting} from '#/state/queries/threadgate/util'
import {COMPOSER_AUDIENCE_MENU} from '#/horizon/switches'
import {type app} from '#/lexicons'

/**
 * A threadgate holds at most five rules (the stock lexicon's `allow`, and
 * aurora's validator).
 */
export const MAX_REPLY_RULES = 5

/**
 * A checkbox value of the reply section: a group, or `list:<uri>`.
 */
export type ReplyValue =
  'followers' | 'following' | 'mention' | `list:${string}`

/**
 * A choice in the reply section.
 */
export type ReplyChoice =
  {type: 'everybody'} | {type: 'nobody'} | {type: 'toggle'; value: ReplyValue}

const GROUP_ORDER = ['followers', 'following', 'mention'] as const

/**
 * The checked values of `settings`: none when anyone or nobody can reply,
 * else the groups and lists it names, in its order.
 */
export function replyValues(
  settings: ThreadgateAllowUISetting[],
): ReplyValue[] {
  const values: ReplyValue[] = []
  for (const setting of settings) {
    switch (setting.type) {
      case 'everybody':
      case 'nobody':
        return []
      case 'list':
        values.push(`list:${setting.list}`)
        break
      default:
        values.push(setting.type)
    }
  }
  return values
}

function toSetting(value: ReplyValue): ThreadgateAllowUISetting {
  if (value.startsWith('list:')) {
    return {type: 'list', list: value.slice('list:'.length)}
  }
  return {type: value as (typeof GROUP_ORDER)[number]}
}

/**
 * Whether `value` can be checked now: it is checked already (it can always be
 * unchecked), or fewer than five values are checked.
 */
export function canToggleReplyValue(
  settings: ThreadgateAllowUISetting[],
  value: ReplyValue,
): boolean {
  const values = replyValues(settings)
  return values.includes(value) || values.length < MAX_REPLY_RULES
}

/**
 * The reply settings after `choice`, as the stock form computes them:
 * Anyone and Nobody replace everything; a checkbox is added or removed, the
 * last one removed returns to Anyone, and the result lists the groups in the
 * order followers, following, mention, then lists in the order checked. A
 * sixth value is refused (the settings come back unchanged).
 */
export function applyReplyChoice(
  settings: ThreadgateAllowUISetting[],
  choice: ReplyChoice,
): ThreadgateAllowUISetting[] {
  if (choice.type === 'everybody') return [{type: 'everybody'}]
  if (choice.type === 'nobody') return [{type: 'nobody'}]
  const values = replyValues(settings)
  let next: ReplyValue[]
  if (values.includes(choice.value)) {
    next = values.filter(value => value !== choice.value)
  } else {
    if (values.length >= MAX_REPLY_RULES) return settings
    next = [...values, choice.value]
  }
  if (next.length === 0) return [{type: 'everybody'}]
  const groups = GROUP_ORDER.filter(group => next.includes(group))
  const lists = next.filter(value => value.startsWith('list:'))
  return [...groups, ...lists].map(toSetting)
}

/**
 * Whether anyone can reply under `settings`.
 */
export function anyoneCanReply(settings: ThreadgateAllowUISetting[]): boolean {
  return settings.length === 1 && settings[0].type === 'everybody'
}

/**
 * Who can reply under `settings`, for a one-line summary: `anyone`, `nobody`,
 * or `limited` (some groups or lists).
 */
export function replySummary(
  settings: ThreadgateAllowUISetting[],
): 'anyone' | 'nobody' | 'limited' {
  if (anyoneCanReply(settings)) return 'anyone'
  if (settings.some(setting => setting.type === 'nobody')) return 'nobody'
  return 'limited'
}

/**
 * Whether quote posts are allowed under `postgate`.
 */
export function quotesAllowed(
  postgate: app.bsky.feed.postgate.Main | undefined,
): boolean {
  return !postgate?.embeddingRules?.some(
    rule => rule.$type === embeddingRules.disableRule.$type,
  )
}

/**
 * `postgate` with quote posts allowed or not, as the stock form writes it.
 */
export function withQuotesAllowed(
  postgate: app.bsky.feed.postgate.Main,
  allowed: boolean,
): app.bsky.feed.postgate.Main {
  return {
    ...postgate,
    embeddingRules: allowed ? [] : [embeddingRules.disableRule],
  }
}

/**
 * The stock pill's wording: `anyone` ("Anyone can interact") when anyone can
 * reply and quotes are allowed, else `limited` ("Interaction limited").
 */
export function interactionSummary(
  threadgate: ThreadgateAllowUISetting[],
  postgate: app.bsky.feed.postgate.Main | undefined,
): 'anyone' | 'limited' {
  return anyoneCanReply(threadgate) && quotesAllowed(postgate)
    ? 'anyone'
    : 'limited'
}

/**
 * What the audience drop-down's trigger reads (v2 round 2, fix 5): the
 * interaction summary in both visibilities, as the stock pill does, with the
 * audience named inside under Who can see. Only a private compose with no
 * reply section (a reply composed Private, starting a branch, where who can
 * see is all the menu sets) has no summary to show, so it names the audience.
 */
export function audienceTriggerReads({
  isPrivate,
  hasReplySection,
}: {
  isPrivate: boolean
  hasReplySection: boolean
}): 'summary' | 'audience' {
  return isPrivate && !hasReplySection ? 'audience' : 'summary'
}

/**
 * The account's saved interaction defaults, as the preferences query holds
 * them.
 */
export type InteractionPrefs =
  | {
      threadgateAllowRules?: app.bsky.feed.threadgate.Main['allow']
      postgateEmbeddingRules?: app.bsky.feed.postgate.Main['embeddingRules']
    }
  | undefined

/**
 * Whether the composer's settings differ from the saved defaults: the stock
 * comparison of `ThreadgateBtn`.
 */
export function isInteractionDirty(
  prefs: InteractionPrefs,
  threadgate: ThreadgateAllowUISetting[],
  postgate: app.bsky.feed.postgate.Main,
): boolean {
  const prefThreadgate = threadgateRecordToAllowUISetting({
    $type: 'app.bsky.feed.threadgate',
    post: '' as AtUriString,
    createdAt: toDatetimeString(new Date()),
    allow: prefs?.threadgateAllowRules,
  })
  const prefEmbeddingRules = prefs?.postgateEmbeddingRules || []
  return (
    !deepEqual(threadgate, prefThreadgate) ||
    !deepEqual(postgate.embeddingRules, prefEmbeddingRules)
  )
}

/**
 * Whether the composer leaves out the stock interaction pill: always while
 * the audience drop-down takes its place in the pills row and sets the same
 * records, else while Private (v1).
 */
export function hidesStockInteractionPill(isPrivate: boolean): boolean {
  return COMPOSER_AUDIENCE_MENU || isPrivate
}
