/*
 * The emoji field's picker on web: the composer's emoji-mart picker, in a
 * Radix dropdown anchored to the button. Radix layers it above the Edit
 * Profile dialog: its portal sits outside the dialog, its focus scope pauses
 * the dialog's while open, and Escape or an outside click closes only the
 * top layer, so the dialog stays open. emoji-mart takes focus in its search
 * box and handles arrow-key navigation and Enter itself. On close Radix
 * returns focus to the button.
 */

import {useLingui} from '@lingui/react/macro'

import {useTheme} from '#/alf'
import {Button} from '#/components/Button'
import * as EmojiPicker from '#/components/EmojiPicker'
import {EmojiArc_Stroke2_Corner0_Rounded as EmojiIcon} from '#/components/icons/Emoji'
import {focusRing, MIN_TARGET} from '#/horizon/identity/edit/a11y'
import {type EmojiPickerButtonProps} from './types'

export * from './types'

export function EmojiPickerButton({
  onPick,
  testID = 'memberEmojiPickerButton',
}: EmojiPickerButtonProps) {
  const t = useTheme()
  const {t: l} = useLingui()
  return (
    <EmojiPicker.Root
      onEmojiSelect={emoji => onPick({native: emoji.native, name: emoji.name})}>
      <EmojiPicker.Trigger
        label={l`Choose an emoji`}
        hint={l`Opens the emoji picker. Type to search, use the arrow keys to move, and Enter to choose.`}>
        {({props, state}) => (
          <Button
            testID={testID}
            {...props}
            label={props.accessibilityLabel}
            size="small"
            color="secondary"
            shape="round"
            style={[
              {width: MIN_TARGET, height: MIN_TARGET},
              focusRing(t.palette.primary_500, state.focused),
            ]}>
            <EmojiIcon size="lg" fill={t.atoms.text.color} />
          </Button>
        )}
      </EmojiPicker.Trigger>
      <EmojiPicker.Picker />
    </EmojiPicker.Root>
  )
}
