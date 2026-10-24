/*
 * A member's colour (Phase 5 design 7.2, 6.5): preset swatches and a hex
 * text field beside them, so colour is never the only way to choose or
 * read it. The value is `#RRGGBB` or empty (no colour).
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import {Text} from '#/components/Typography'
import {COLOR_PRESETS} from '#/horizon/identity/edit/suggestions'

const COLOR = /^#[0-9A-Fa-f]{6}$/

/** Whether a colour field value can be written (empty is no colour). */
export function colorValid(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || COLOR.test(trimmed)
}

export function ColorField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const valid = colorValid(value)
  const current = value.trim().toUpperCase()
  return (
    <View style={[a.gap_sm]}>
      <TextField.LabelText>
        <Trans>Colour</Trans>
      </TextField.LabelText>
      <View style={[a.flex_row, a.flex_wrap, a.gap_sm]}>
        {COLOR_PRESETS.map(preset => {
          const selected = current === preset.value.toUpperCase()
          const name = i18n._(preset.label)
          return (
            <Button
              key={preset.value}
              label={l`${name}, ${preset.value}`}
              accessibilityState={{selected}}
              onPress={() => onChange(preset.value)}
              size="small"
              color="secondary"
              shape="round"
              style={[
                {width: 44, height: 44},
                selected && {
                  borderWidth: 2,
                  borderColor: t.atoms.text.color,
                },
              ]}>
              <View
                style={[
                  a.rounded_full,
                  {width: 28, height: 28, backgroundColor: preset.value},
                ]}
              />
            </Button>
          )
        })}
      </View>
      <View style={[a.flex_row, a.align_center, a.gap_sm]}>
        <View
          accessible={false}
          style={[
            a.rounded_full,
            a.border,
            t.atoms.border_contrast_medium,
            {
              width: 28,
              height: 28,
              backgroundColor: valid && current ? current : 'transparent',
            },
          ]}
        />
        <View style={[a.flex_1]}>
          <TextField.Root isInvalid={!valid}>
            <Dialog.Input
              testID="memberColorInput"
              label={l`Colour as a hex code`}
              value={value}
              onChangeText={onChange}
              placeholder="#RRGGBB"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </TextField.Root>
        </View>
        {value ? (
          <Button
            label={l`No colour`}
            onPress={() => onChange('')}
            size="small"
            color="secondary">
            <ButtonText>
              <Trans>None</Trans>
            </ButtonText>
          </Button>
        ) : null}
      </View>
      {!valid ? (
        <Text style={[a.text_sm, {color: t.palette.negative_400}]}>
          <Trans>Use a hex code like #30A46C.</Trans>
        </Text>
      ) : null}
    </View>
  )
}
