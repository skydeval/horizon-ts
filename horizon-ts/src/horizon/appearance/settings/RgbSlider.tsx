/*
 * One R, G or B row of the Custom editor on native (Phase 3 design, 10.6):
 * 1.0's minus / number field / plus stepper; a long press on minus or plus
 * steps by 10. Built, not verified in Phase 3 (N-1).
 * `RgbSlider.web.tsx` is the web range input.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as TextField from '#/components/forms/TextField'
import {Text} from '#/components/Typography'
import {type Channel} from '#/horizon/appearance/settings/editor'
import {useChannelLabels} from '#/horizon/appearance/settings/strings'

function clamp(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

export function RgbSlider({
  channel,
  column,
  value,
  onChange,
}: {
  channel: Channel
  /** The column's label ("Color", "Top Left", "Bottom Right"). */
  column: string
  value: number
  onChange: (value: number) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {letter, name} = useChannelLabels(channel)
  const [draft, setDraft] = useState<string | null>(null)
  const label = l({
    message: `${column} ${name}`,
    comment: 'Label of a colour slider: the colour column, then the channel',
  })
  return (
    <View style={[{gap: 6}]}>
      <View style={[a.flex_row, a.justify_between]}>
        <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>{letter}</Text>
        <Text style={[a.text_xs, {fontVariant: ['tabular-nums']}]}>
          {value}
        </Text>
      </View>
      <View style={[a.flex_row, a.align_center, a.gap_sm]}>
        <Button
          label={l`Decrease ${label}`}
          accessibilityHint={l`Long-press to step by 10`}
          size="small"
          color="secondary"
          shape="square"
          onPress={() => onChange(clamp(value - 1))}
          onLongPress={() => onChange(clamp(value - 10))}>
          <ButtonText>-</ButtonText>
        </Button>
        <View style={[a.flex_1]}>
          <TextField.Root>
            <TextField.Input
              label={label}
              value={draft ?? String(value)}
              keyboardType="number-pad"
              maxLength={3}
              onChangeText={text => {
                setDraft(text)
                const n = Number(text)
                if (text !== '' && Number.isInteger(n)) onChange(clamp(n))
              }}
              onBlur={() => setDraft(null)}
            />
          </TextField.Root>
        </View>
        <Button
          label={l`Increase ${label}`}
          accessibilityHint={l`Long-press to step by 10`}
          size="small"
          color="secondary"
          shape="square"
          onPress={() => onChange(clamp(value + 1))}
          onLongPress={() => onChange(clamp(value + 10))}>
          <ButtonText>+</ButtonText>
        </Button>
      </View>
    </View>
  )
}
