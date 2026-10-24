/*
 * The emoji field's picker on Android: the native emoji grid the DM
 * reactions use (`@bsky.app/expo-emoji-picker`), in a full-screen modal as
 * `EmojiPopup.android` shows it. The modal is its own window above the Edit
 * Profile sheet; the back gesture and the close button close only the
 * modal. When it closes, TalkBack focus goes back to the button.
 */

import {useRef, useState} from 'react'
import {AccessibilityInfo, findNodeHandle, Modal, View} from 'react-native'
import {SafeAreaView} from 'react-native-safe-area-context'
import {EmojiPicker} from '@bsky.app/expo-emoji-picker'
import {Trans, useLingui} from '@lingui/react/macro'

import {useA11y} from '#/state/a11y'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonIcon} from '#/components/Button'
import {EmojiArc_Stroke2_Corner0_Rounded as EmojiIcon} from '#/components/icons/Emoji'
import {TimesLarge_Stroke2_Corner0_Rounded as CloseIcon} from '#/components/icons/Times'
import {Text} from '#/components/Typography'
import {MIN_TARGET} from '#/horizon/identity/edit/a11y'
import {type EmojiPickerButtonProps} from './types'

export * from './types'

export function EmojiPickerButton({
  onPick,
  testID = 'memberEmojiPickerButton',
}: EmojiPickerButtonProps) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {reduceMotionEnabled} = useA11y()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<React.ComponentRef<typeof View>>(null)

  const close = () => {
    setOpen(false)
    // After the modal's window is gone, so TalkBack can land on the button.
    setTimeout(() => {
      const node = findNodeHandle(triggerRef.current)
      if (node) AccessibilityInfo.setAccessibilityFocus(node)
    }, 300)
  }

  return (
    <>
      <View ref={triggerRef} collapsable={false}>
        <Button
          testID={testID}
          label={l`Choose an emoji`}
          accessibilityHint={l`Opens the emoji picker`}
          onPress={() => setOpen(true)}
          size="small"
          color="secondary"
          shape="round"
          style={{width: MIN_TARGET, height: MIN_TARGET}}>
          <EmojiIcon size="lg" fill={t.atoms.text.color} />
        </Button>
      </View>
      <Modal
        testID={`${testID}-modal`}
        animationType={reduceMotionEnabled ? 'none' : 'slide'}
        visible={open}
        onRequestClose={close}
        transparent
        statusBarTranslucent
        navigationBarTranslucent>
        <SafeAreaView style={[a.flex_1, t.atoms.bg]}>
          <View
            style={[
              a.pl_lg,
              a.pr_md,
              a.py_sm,
              a.w_full,
              a.align_center,
              a.flex_row,
              a.justify_between,
              a.border_b,
              t.atoms.border_contrast_low,
            ]}>
            <Text
              accessibilityRole="header"
              style={[a.font_semi_bold, a.text_md]}>
              <Trans>Choose an emoji</Trans>
            </Text>
            <Button
              testID={`${testID}-close`}
              label={l`Close the emoji picker`}
              onPress={close}
              size="small"
              color="secondary"
              shape="round"
              style={{width: MIN_TARGET, height: MIN_TARGET}}>
              <ButtonIcon icon={CloseIcon} />
            </Button>
          </View>
          <EmojiPicker
            onEmojiSelected={emoji => {
              close()
              onPick({native: emoji})
            }}
          />
        </SafeAreaView>
      </Modal>
    </>
  )
}
