/*
 * A member's emoji (Phase 5 design 7.2): free text of at most 4 graphemes
 * (`member.json`), the limit announced through the stock counter.
 */

import {useLingui} from '@lingui/react/macro'

import {LimitedField} from '#/horizon/identity/edit/fields'

/** The member lexicon's limit. */
export const EMOJI_MAX_GRAPHEMES = 4

export function EmojiField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const {t: l} = useLingui()
  return (
    <LimitedField
      testID="memberEmojiInput"
      label={l`Emoji`}
      value={value}
      onChange={onChange}
      max={EMOJI_MAX_GRAPHEMES}
      placeholder="🌿"
    />
  )
}
