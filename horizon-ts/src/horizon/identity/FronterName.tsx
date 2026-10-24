/*
 * A post's fronters in place of its author's display name (Phase 5 design
 * 6.3, 6.5, ID-1, ID-13, ID-16): the members' names joined with ", ", a dot
 * in each member's colour before its name (a swatch, never text colour,
 * PP-10), and the `&` marker after the last. Without fronters in scope for
 * this DID the stock text shows exactly as it was (PP-15). Only child text
 * changes: the press target, its profile and every cache stay the account's
 * (PP-14).
 *
 * The name link's accessible label is the carrier for screen readers
 * (`InlineLinkText` sets `accessibilityLabel={label}`, which overrides the
 * child text), so `useFronterLinkLabel` gives it in words, with the `&`
 * never read.
 */

import {Fragment} from 'react'
import {Text as RNText, View} from 'react-native'
import {moderateProfile, type ModerationUI} from '@bsky/sdk/moderation'
import {type I18n} from '@lingui/core'
import {msg} from '@lingui/core/macro'
import {useLingui} from '@lingui/react'

import {forceLTR} from '#/lib/strings/bidi'
import {sanitizeDisplayName} from '#/lib/strings/display-names'
import {sanitizeHandle} from '#/lib/strings/handles'
import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {atoms as a, native, web} from '#/alf'
import {formatSets, FRONTERS_MARKER} from '#/horizon/identity/format'
import {type PostFronter, usePostFronters} from '#/horizon/identity/hooks'
import {PRONOUNS} from '#/horizon/switches'

/** What a name's moderation needs: whether it is hidden. */
type NameModeration = {blur?: boolean} | undefined

/**
 * The fronters to draw for `did`, or `null` for the stock name: none in
 * scope, or the account's name hidden by moderation (a blurred account name
 * hides its members' names too, 6.2).
 */
export function useShownFronters(
  did: string | undefined,
  moderation: NameModeration,
): PostFronter[] | null {
  const fronters = usePostFronters(did)
  if (!fronters || moderation?.blur) return null
  return fronters
}

/** A member's name as shown: sanitised, never empty. */
export function memberName(fronter: PostFronter): string {
  return sanitizeDisplayName(fronter.member.displayName)
}

/** The colour swatch before a member's name. */
export function MemberSwatch({
  color,
  size = 6,
}: {
  color: string | undefined
  size?: number
}) {
  if (!color) return null
  return (
    <View
      accessible={false}
      style={[
        a.rounded_full,
        {
          width: size,
          height: size,
          marginRight: 3,
          backgroundColor: color,
        },
        web({display: 'inline-block', verticalAlign: 'middle'}),
        native({transform: [{translateY: -2}]}),
      ]}
    />
  )
}

/**
 * The display name child of an author line: the fronters' names, or
 * `fallback` (the stock text) when the post in scope names none for `did`.
 */
export function FronterName({
  did,
  fallback,
  moderation,
}: {
  did: string | undefined
  fallback: React.ReactNode
  /** The account's `displayName` moderation. */
  moderation: NameModeration
}) {
  const fronters = useShownFronters(did, moderation)
  if (!fronters) return <>{fallback}</>
  return (
    <>
      {fronters.map((fronter, i) => (
        <Fragment key={fronter.rkey}>
          {i > 0 ? ', ' : null}
          <MemberSwatch color={fronter.member.color} />
          {forceLTR(memberName(fronter))}
        </Fragment>
      ))}
      <RNText accessible={false}>{FRONTERS_MARKER}</RNText>
    </>
  )
}

/** One fronter in words for a label: its name, then its pronouns if any. */
function fronterWords(fronter: PostFronter, withPronouns: boolean): string {
  const name = memberName(fronter)
  const pronouns = withPronouns ? formatSets(fronter.member.pronouns) : ''
  return pronouns ? `${name}, ${pronouns}` : name
}

/**
 * Names in words: "Wren", "Wren and Sparrow", "Wren, Sparrow and Robin".
 */
function joinWords(i18n: I18n, words: string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  const head = words.slice(0, -1).join(', ')
  const last = words[words.length - 1]
  return i18n._(
    msg({
      message: `${head} and ${last}`,
      comment:
        'The members of a plural system who wrote a post, in a screen reader label, e.g. "Wren and Sparrow"',
    }),
  )
}

/**
 * The author line's accessible label for a post with fronters (6.5): "Wren
 * and Sparrow, of The Flock, @flock.example, she/her". With one fronter its
 * pronouns end the label; with several each follows its name (Q6).
 * `account` is the account's display name (already moderated) and handle.
 */
export function fronterLinkLabel(
  i18n: I18n,
  fronters: readonly PostFronter[],
  account: {displayName: string; handle: string},
  {withPronouns = PRONOUNS}: {withPronouns?: boolean} = {},
): string {
  const single = fronters.length === 1
  const names = joinWords(
    i18n,
    fronters.map(fronter => fronterWords(fronter, withPronouns && !single)),
  )
  const handle = sanitizeHandle(account.handle, '@')
  const parts = [names]
  if (account.displayName.trim()) {
    parts.push(
      i18n._(
        msg({
          message: `of ${account.displayName.trim()}`,
          comment:
            'In a screen reader label: the account the members of a plural system posted from, e.g. "of The Flock"',
        }),
      ),
    )
  }
  parts.push(handle)
  if (single && withPronouns) {
    const pronouns = formatSets(fronters[0].member.pronouns)
    if (pronouns) parts.push(pronouns)
  }
  return parts.join(', ')
}

/**
 * A profile's `displayName` moderation, for a caller that has the profile
 * but not its moderation decision.
 */
export function useNameModeration(
  profile: Parameters<typeof moderateProfile>[0],
): ModerationUI | undefined {
  const moderationOpts = useModerationOpts()
  return moderationOpts
    ? moderateProfile(profile, moderationOpts).ui('displayName')
    : undefined
}

/**
 * The name link's label for the post in scope when it names fronters for
 * `author`, else `undefined` (the caller keeps its stock label).
 */
export function useFronterLinkLabel(
  author: {did: string; handle: string; displayName?: string},
  moderation: NameModeration,
): string | undefined {
  const {i18n} = useLingui()
  const fronters = useShownFronters(author.did, moderation)
  if (!fronters) return undefined
  return fronterLinkLabel(i18n, fronters, {
    // A hidden name gives no fronters above, so the name here is shown.
    displayName: sanitizeDisplayName(author.displayName ?? ''),
    handle: author.handle,
  })
}
