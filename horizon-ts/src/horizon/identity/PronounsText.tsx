/*
 * Pronouns on an author line, the thread anchor, the profile header and the
 * hover card (Phase 5 design 6.1, ID-2, ID-14). Three answers (PP-8): a
 * record shows its sets by its `displayMode`; a proven none shows Bluesky's
 * short field from the view the caller already has; unknown shows nothing.
 * No placeholder: the text fills in at the end of the line when it lands, so
 * nothing to its left moves.
 *
 * On a post with fronters in scope (6.1): one fronter, that member's
 * pronouns in the account's place; several, none on the author line (too
 * long), and each beside its name where the full text shows (`full`, the
 * anchor).
 */

import {type StyleProp, type TextStyle} from 'react-native'

import {NON_BREAKING_SPACE} from '#/lib/strings/constants'
import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {formatSets} from '#/horizon/identity/format'
import {memberName} from '#/horizon/identity/FronterName'
import {
  type PostFronter,
  usePostFronters,
  usePronouns,
} from '#/horizon/identity/hooks'
import {type ObserveMode} from '#/horizon/identity/schedule'
import {PRONOUNS} from '#/horizon/switches'

/**
 * Bluesky's short `pronouns` field from any profile view that carries it
 * (the chat view does not).
 */
export function stockPronouns(profile: object): string | undefined {
  const value = (profile as {pronouns?: unknown}).pronouns
  return typeof value === 'string' ? value : undefined
}

/**
 * The pronouns text for a post's fronters: one fronter's own sets; several,
 * nothing unless `full`, then "Wren (she/her), Sparrow (they/them)" for the
 * members that have any.
 */
export function fronterPronounsText(
  fronters: readonly PostFronter[],
  full: boolean,
): string {
  if (fronters.length === 1) return formatSets(fronters[0].member.pronouns)
  if (!full) return ''
  return fronters
    .map(fronter => {
      const sets = formatSets(fronter.member.pronouns)
      return sets ? `${memberName(fronter)} (${sets})` : ''
    })
    .filter(text => text.length > 0)
    .join(', ')
}

/**
 * The pronouns to show for `did`: the post's fronters' when the post in
 * scope names any for `did`, else the account's (three answers).
 */
export function usePronounsText(
  did: string | undefined,
  fallback: string | undefined,
  {full = false, mode = 'post'}: {full?: boolean; mode?: ObserveMode} = {},
): string {
  const fronters = usePostFronters(did)
  const account = usePronouns(did, fallback, {mode})
  if (!PRONOUNS) return ''
  if (fronters) return fronterPronounsText(fronters, full)
  return account.text
}

/**
 * The pronouns as a muted text, or nothing. `inline` sits after the handle
 * on an author line (one line, shrinking before the handle); otherwise it
 * is its own line, `full` showing every fronter's.
 */
export function PronounsText({
  did,
  fallback,
  inline = false,
  full = false,
  mode = 'post',
  style,
}: {
  did: string | undefined
  /** Bluesky's short `pronouns` field from the view in hand. */
  fallback: string | undefined
  inline?: boolean
  full?: boolean
  mode?: ObserveMode
  style?: StyleProp<TextStyle>
}) {
  const t = useTheme()
  const text = usePronounsText(did, fallback, {full, mode})
  if (!text) return null
  if (inline) {
    return (
      <Text
        emoji
        numberOfLines={1}
        testID="authorPronouns"
        style={[
          a.text_md,
          a.leading_tight,
          t.atoms.text_contrast_medium,
          {flexShrink: 20},
          style,
        ]}>
        {NON_BREAKING_SPACE + text}
      </Text>
    )
  }
  return (
    <Text
      emoji
      testID="profilePronouns"
      style={[a.text_md, a.leading_snug, t.atoms.text_contrast_medium, style]}>
      {text}
    </Text>
  )
}
