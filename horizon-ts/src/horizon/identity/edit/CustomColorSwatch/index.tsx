/*
 * The colour field's preview swatch on native. There is no system colour
 * picker to open, so the swatch opens and closes the field's hue,
 * saturation and lightness sliders, and says so through its expanded state.
 */

import {Pressable, View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {MIN_TARGET} from '#/horizon/identity/edit/a11y'
import {type CustomColorSwatchProps} from './types'

export * from './types'

export function CustomColorSwatch({
  color,
  label,
  expanded,
  onToggleSliders,
  testID = 'memberColorSwatch',
}: CustomColorSwatchProps) {
  const t = useTheme()
  const {t: l} = useLingui()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={
        expanded ? l`Hides the colour sliders` : l`Shows the colour sliders`
      }
      accessibilityState={{expanded}}
      onPress={onToggleSliders}
      style={[
        a.align_center,
        a.justify_center,
        a.rounded_full,
        {width: MIN_TARGET, height: MIN_TARGET},
      ]}>
      <View
        style={[
          a.rounded_full,
          a.border,
          t.atoms.border_contrast_high,
          {width: 32, height: 32, backgroundColor: color || 'transparent'},
        ]}
      />
    </Pressable>
  )
}
