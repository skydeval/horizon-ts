/*
 * A member's emoji (Phase 5 design 7.2): free text of at most 4 graphemes
 * (`member.json`), the limit announced through the stock counter. A picker
 * button beside the field puts the chosen emoji at the cursor, or at the
 * end. Typing can still go over the limit and is then flagged, as every
 * limited field is; a pick that would go over is refused with a short
 * note instead, so a pick never leaves the field invalid. Each pick and
 * each refusal is announced through a polite live region.
 */

import {useRef, useState} from 'react'
import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {insertEmoji, type Selection} from '#/horizon/identity/edit/emoji-insert'
import {
  EmojiPickerButton,
  type PickedEmoji,
} from '#/horizon/identity/edit/EmojiPickerButton'
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
  const t = useTheme()
  const {t: l} = useLingui()
  // Where the next pick goes; unset until the field has had a cursor.
  const selection = useRef<Selection | undefined>(undefined)
  const [note, setNote] = useState<{text: string; refused: boolean} | null>(
    null,
  )

  const onPick = (emoji: PickedEmoji) => {
    const result = insertEmoji(
      value,
      emoji.native,
      selection.current,
      EMOJI_MAX_GRAPHEMES,
    )
    if (!result.ok) {
      setNote({
        text: l`The emoji field is full. Remove one to add another.`,
        refused: true,
      })
      return
    }
    selection.current = {start: result.cursor, end: result.cursor}
    onChange(result.value)
    setNote({
      text: emoji.name
        ? l`Added ${emoji.native} ${emoji.name}`
        : l`Added ${emoji.native}`,
      refused: false,
    })
  }

  return (
    <View>
      <LimitedField
        testID="memberEmojiInput"
        label={l`Emoji`}
        value={value}
        onChange={next => {
          setNote(null)
          onChange(next)
        }}
        onSelectionChange={next => {
          selection.current = next
        }}
        max={EMOJI_MAX_GRAPHEMES}
        placeholder="🌿"
        accessory={<EmojiPickerButton onPick={onPick} />}
      />
      <Text
        testID="memberEmojiNote"
        emoji
        accessibilityLiveRegion="polite"
        style={[
          a.text_sm,
          a.mt_xs,
          note?.refused
            ? {color: t.palette.negative_400}
            : t.atoms.text_contrast_medium,
        ]}>
        {note?.text ?? ''}
      </Text>
    </View>
  )
}
