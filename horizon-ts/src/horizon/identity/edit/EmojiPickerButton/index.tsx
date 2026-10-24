/*
 * The emoji field's picker on iOS: the native picker the DM reactions use
 * (`@bsky.app/expo-emoji-picker`, MCEmojiPicker). A tap on the wrapped view
 * presents it as a popover from the view controller that hosts the view, so
 * it sits above the Edit Profile sheet and dismissing it leaves the sheet
 * open. VoiceOver activates the button by tapping its centre, which reaches
 * the picker's tap gesture.
 */

import {View} from 'react-native'
import {EmojiPicker} from '@bsky.app/expo-emoji-picker'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {EmojiArc_Stroke2_Corner0_Rounded as EmojiIcon} from '#/components/icons/Emoji'
import {MIN_TARGET} from '#/horizon/identity/edit/a11y'
import {type EmojiPickerButtonProps} from './types'

export * from './types'

export function EmojiPickerButton({
  onPick,
  testID = 'memberEmojiPickerButton',
}: EmojiPickerButtonProps) {
  const t = useTheme()
  const {t: l} = useLingui()
  return (
    <EmojiPicker onEmojiSelected={emoji => onPick({native: emoji})}>
      <View
        testID={testID}
        accessible
        accessibilityRole="button"
        accessibilityLabel={l`Choose an emoji`}
        accessibilityHint={l`Opens the emoji picker`}
        style={[
          a.align_center,
          a.justify_center,
          a.rounded_full,
          t.atoms.bg_contrast_50,
          {width: MIN_TARGET, height: MIN_TARGET},
        ]}>
        <EmojiIcon size="lg" fill={t.atoms.text.color} />
      </View>
    </EmojiPicker>
  )
}
