/*
 * "Describe avatar" and "Describe banner" in the stock Edit Profile dialog,
 * under the images. The state is `useProfileAltEditParts` (`edit-parts.ts`).
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {Text} from '#/components/Typography'
import {
  type ProfileAltEditParts,
  type Slots,
} from '#/horizon/profile-alt/edit-parts'
import {
  PROFILE_IMAGE_SLOTS,
  type ProfileImageSlot,
} from '#/horizon/profile-alt/parse'
import {ProfileAltDialog} from '#/horizon/profile-alt/ProfileAltDialog'

export {useProfileAltEditParts} from '#/horizon/profile-alt/edit-parts'

/**
 * "Describe avatar" and "Describe banner", under the images; each only
 * while there is an image to describe.
 */
export function ProfileAltFields({
  parts,
  images,
}: {
  parts: ProfileAltEditParts
  /** The images in the form now: a picked file, the current URL, or none. */
  images: Slots<string | null>
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  if (!parts.enabled) return null
  const shown = PROFILE_IMAGE_SLOTS.filter(slot => !!images[slot])
  if (shown.length === 0) return null

  if (parts.state !== 'ready') {
    return (
      <View style={[a.flex_row, a.align_center, a.gap_sm]}>
        <Text style={[a.flex_1, t.atoms.text_contrast_medium]}>
          {parts.state === 'error' ? (
            <Trans>Image descriptions couldn’t load.</Trans>
          ) : (
            <Trans>Loading image descriptions…</Trans>
          )}
        </Text>
        {parts.state === 'error' && (
          <Button
            label={l`Try loading image descriptions again`}
            onPress={parts.retry}
            size="small"
            color="secondary">
            <ButtonText>
              <Trans>Try again</Trans>
            </ButtonText>
          </Button>
        )}
      </View>
    )
  }

  return (
    <View style={[a.gap_xs]}>
      <View style={[a.flex_row, a.flex_wrap, a.gap_sm]}>
        {shown.map(slot => (
          <DescribeButton
            key={slot}
            slot={slot}
            imageUri={images[slot] ?? ''}
            alt={parts.texts[slot]}
            onChange={next => parts.setText(slot, next)}
          />
        ))}
      </View>
      {parts.error !== '' && (
        <Text
          role="alert"
          style={[
            a.text_sm,
            a.font_semi_bold,
            {color: t.palette.negative_400},
          ]}>
          <Trans>Image descriptions weren’t saved: {parts.error}</Trans>
        </Text>
      )}
    </View>
  )
}

function DescribeButton({
  slot,
  imageUri,
  alt,
  onChange,
}: {
  slot: ProfileImageSlot
  imageUri: string
  alt: string
  onChange: (next: string) => void
}) {
  const {t: l} = useLingui()
  const control = Dialog.useDialogControl()
  const described = alt.trim().length > 0
  let label: string
  if (slot === 'avatar') {
    label = described ? l`Edit avatar description` : l`Describe avatar`
  } else {
    label = described ? l`Edit banner description` : l`Describe banner`
  }

  return (
    <>
      <Button
        testID={`profileAltButton-${slot}`}
        label={label}
        accessibilityHint={l`Opens a field to write alt text for this image`}
        onPress={() => control.open()}
        size="small"
        color={described ? 'secondary' : 'primary_subtle'}>
        <ButtonText>{label}</ButtonText>
      </Button>
      <ProfileAltDialog
        control={control}
        slot={slot}
        imageUri={imageUri}
        alt={alt}
        onChange={onChange}
      />
    </>
  )
}
