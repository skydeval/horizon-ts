/*
 * One "Backdrop softness" row on native (live fix batch 1): the theme's
 * name and the value, then a minus / plus stepper by 5; a long press steps
 * by 25. Built, not verified (N-1). `SoftnessSlider.web.tsx` is the web
 * range input.
 */

import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import {Text} from '#/components/Typography'

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function SoftnessSlider({
  label,
  value,
  onChange,
}: {
  /** The theme's name ("Dim", "Dark"). */
  label: string
  value: number
  onChange: (value: number) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const name = l({
    message: `Backdrop softness in ${label}`,
    comment: 'Label of a slider; the variable is a theme name',
  })
  return (
    <View style={[a.w_full, a.flex_row, a.align_center, a.gap_sm]}>
      <Text style={[a.flex_1, a.text_sm, t.atoms.text_contrast_medium]}>
        {label}
      </Text>
      <Button
        label={l`Decrease ${name}`}
        accessibilityHint={l`Long-press to step by 25`}
        size="small"
        color="secondary"
        shape="square"
        onPress={() => onChange(clamp(value - 5))}
        onLongPress={() => onChange(clamp(value - 25))}>
        <ButtonText>-</ButtonText>
      </Button>
      <Text
        style={[
          a.text_sm,
          a.text_center,
          {minWidth: 32, fontVariant: ['tabular-nums']},
        ]}>
        {value}
      </Text>
      <Button
        label={l`Increase ${name}`}
        accessibilityHint={l`Long-press to step by 25`}
        size="small"
        color="secondary"
        shape="square"
        onPress={() => onChange(clamp(value + 5))}
        onLongPress={() => onChange(clamp(value + 25))}>
        <ButtonText>+</ButtonText>
      </Button>
    </View>
  )
}
