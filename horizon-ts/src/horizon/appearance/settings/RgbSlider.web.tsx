/*
 * One R, G or B row of the Custom editor on web (Phase 3 design, 10.6): the
 * letter and the value, then a raw range input, as the stock web volume
 * control uses. Arrow keys step by 1 (the browser's default), Page Up and
 * Page Down by 16.
 */

import {type ChangeEvent} from 'react'
import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {type Channel} from '#/horizon/appearance/settings/editor'
import {rangeKeyDown} from '#/horizon/appearance/settings/keys'
import {useChannelLabels} from '#/horizon/appearance/settings/strings'

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
  return (
    <View style={[{gap: 6}]}>
      <View style={[a.flex_row, a.justify_between]}>
        <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>{letter}</Text>
        <Text style={[a.text_xs, {fontVariant: ['tabular-nums']}]}>
          {value}
        </Text>
      </View>
      <input
        type="range"
        min={0}
        max={255}
        step={1}
        value={value}
        aria-label={l({
          message: `${column} ${name}`,
          comment:
            'Label of a colour slider: the colour column, then the channel',
        })}
        aria-valuetext={String(value)}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          onChange(Number(e.target.value))
        }
        onKeyDown={rangeKeyDown(value, onChange)}
        style={{width: '100%', accentColor: t.palette.primary_500}}
      />
    </View>
  )
}
