/*
 * One "Backdrop softness" row on web (live fix batch 1): the theme's name
 * and the value, then a raw range input from 0 to 100, as the colour
 * sliders use. Arrow keys step by 1, Page Up and Page Down by 10.
 */

import {type ChangeEvent} from 'react'
import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {rangeKeyDown} from '#/horizon/appearance/settings/keys'

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
  return (
    <View style={[a.w_full, {gap: 6}]}>
      <View style={[a.flex_row, a.justify_between]}>
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>{label}</Text>
        <Text style={[a.text_sm, {fontVariant: ['tabular-nums']}]}>
          {value}
        </Text>
      </View>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={l({
          message: `Backdrop softness in ${label}`,
          comment: 'Label of a slider; the variable is a theme name',
        })}
        aria-valuetext={String(value)}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          onChange(Number(e.target.value))
        }
        onKeyDown={rangeKeyDown(value, onChange, {page: 10, max: 100})}
        style={{width: '100%', accentColor: t.palette.primary_500}}
      />
    </View>
  )
}
