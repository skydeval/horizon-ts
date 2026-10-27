/*
 * "Describe this image" for the avatar or banner in Edit Profile: the
 * composer's alt-text dialog (`ImageAltTextDialog`) for a profile image,
 * with the same layout, limit, counter and save-on-close. The text is kept
 * in the form and written with Edit Profile's Save.
 */

import {useRef, useState} from 'react'
import {type ImageStyle, View} from 'react-native'
import {Image} from 'expo-image'
import {Plural, Trans, useLingui} from '@lingui/react/macro'

import {MAX_ALT_TEXT} from '#/lib/constants'
import {enforceLen} from '#/lib/strings/helpers'
import {AltTextCounterWrapper} from '#/view/com/composer/AltTextCounterWrapper'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import {CircleInfo_Stroke2_Corner0_Rounded as CircleInfo} from '#/components/icons/CircleInfo'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {type ProfileImageSlot} from '#/horizon/profile-alt/parse'

export function ProfileAltDialog({
  control,
  slot,
  imageUri,
  alt,
  onChange,
}: {
  control: Dialog.DialogControlProps
  slot: ProfileImageSlot
  /** The image being described: the picked file or the current URL. */
  imageUri: string
  alt: string
  onChange: (next: string) => void
}) {
  /*
   * As in the composer's dialog: the text being edited lives in the inner
   * component, and this keeps the latest edit to save on close, however
   * the dialog is closed.
   */
  const edited = useRef<string | null>(null)

  return (
    <Dialog.Outer
      control={control}
      onClose={() => {
        if (edited.current === null) return
        onChange(enforceLen(edited.current, MAX_ALT_TEXT, true))
        edited.current = null
      }}
      nativeOptions={{fullHeight: true}}>
      <Dialog.Handle />
      <Inner
        control={control}
        slot={slot}
        imageUri={imageUri}
        alt={alt}
        onChangeText={text => {
          edited.current = text
        }}
      />
    </Dialog.Outer>
  )
}

function Inner({
  control,
  slot,
  imageUri,
  alt,
  onChangeText,
}: {
  control: Dialog.DialogControlProps
  slot: ProfileImageSlot
  imageUri: string
  alt: string
  onChangeText: (text: string) => void
}) {
  const {t: l, i18n} = useLingui()
  const t = useTheme()
  const [altText, setAltText] = useState(alt)
  const title =
    slot === 'avatar' ? l`Describe your avatar` : l`Describe your banner`
  const imageStyle: ImageStyle = {
    width: slot === 'avatar' ? '50%' : '100%',
    aspectRatio: slot === 'avatar' ? 1 : 3,
    borderRadius: 8,
    alignSelf: 'center',
  }

  return (
    <Dialog.ScrollableInner label={title}>
      <Dialog.Close />

      <View>
        {IS_WEB && (
          <Text
            style={[a.text_2xl, a.font_semi_bold, a.leading_tight, a.pb_sm]}>
            {title}
          </Text>
        )}

        <View style={[t.atoms.bg_contrast_50, a.rounded_sm, a.overflow_hidden]}>
          <Image
            style={imageStyle}
            source={{uri: imageUri}}
            contentFit="cover"
            accessibilityIgnoresInvertColors
            autoplay={false}
          />
        </View>
      </View>

      <View style={[a.mt_md, a.gap_md]}>
        <View style={[a.gap_sm]}>
          <View style={[a.relative, {width: '100%'}]}>
            <TextField.LabelText>
              <Trans>Descriptive alt text</Trans>
            </TextField.LabelText>
            <TextField.Root>
              <Dialog.Input
                testID="profileAltInput"
                label={l`Alt text`}
                onChangeText={text => {
                  setAltText(text)
                  onChangeText(text)
                }}
                value={altText}
                multiline
                autoFocus
                scrollEnabled={false}
              />
            </TextField.Root>
          </View>

          {altText.length > MAX_ALT_TEXT && (
            <View style={[a.pb_sm, a.flex_row, a.gap_xs]}>
              <CircleInfo fill={t.palette.negative_500} />
              <Text
                style={[
                  a.italic,
                  a.leading_snug,
                  t.atoms.text_contrast_medium,
                ]}>
                <Trans>
                  Alt text will be truncated.{' '}
                  <Plural
                    value={MAX_ALT_TEXT}
                    other={`Limit: ${i18n.number(MAX_ALT_TEXT)} characters.`}
                  />
                </Trans>
              </Text>
            </View>
          )}

          <Text style={[a.leading_snug, t.atoms.text_contrast_medium]}>
            <Trans>
              Saved with your profile. People using screen readers hear it, and
              anyone can see it when the image is opened full size.
            </Trans>
          </Text>
        </View>

        <AltTextCounterWrapper altText={altText}>
          <Button
            testID="profileAltDone"
            label={l`Done`}
            disabled={altText === alt}
            size="large"
            color="primary"
            variant="solid"
            onPress={() => {
              control.close()
            }}
            style={[a.flex_grow]}>
            <ButtonText>
              <Trans>Done</Trans>
            </ButtonText>
          </Button>
        </AltTextCounterWrapper>
      </View>
    </Dialog.ScrollableInner>
  )
}
