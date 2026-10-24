/*
 * The colour field's preview swatch on web: a button that opens the
 * browser's own colour picker through a visually hidden
 * `<input type="color">` placed under the swatch, so the browser anchors
 * its popup there. The input is out of the tab order and hidden from
 * screen readers; the swatch is the control. The picker is browser UI, so
 * it does not take part in the Edit Profile dialog's focus scope, and the
 * dialog ignores focus leaving for it.
 */

import {useRef, useState} from 'react'
import {Pressable, View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {focusRing, MIN_TARGET} from '#/horizon/identity/edit/a11y'
import {type CustomColorSwatchProps} from './types'

export * from './types'

export function CustomColorSwatch({
  color,
  label,
  onChange,
  testID = 'memberColorSwatch',
}: CustomColorSwatchProps) {
  const t = useTheme()
  const {t: l} = useLingui()
  const input = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  return (
    <View style={[a.relative]}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={l`Opens your browser’s colour picker`}
        onPress={() => {
          const el = input.current
          if (!el) return
          if (typeof el.showPicker === 'function') {
            try {
              el.showPicker()
              return
            } catch {
              // Older browsers: fall through to the click.
            }
          }
          el.click()
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          a.align_center,
          a.justify_center,
          a.rounded_full,
          {width: MIN_TARGET, height: MIN_TARGET},
          focusRing(t.palette.primary_500, focused),
        ]}>
        <View
          style={[
            a.rounded_full,
            a.border,
            t.atoms.border_contrast_high,
            {
              width: 32,
              height: 32,
              backgroundColor: color || 'transparent',
            },
          ]}
        />
      </Pressable>
      <input
        ref={input}
        data-testid={`${testID}-input`}
        type="color"
        tabIndex={-1}
        aria-hidden
        value={(color || '#000000').toLowerCase()}
        onChange={e => onChange(e.currentTarget.value.toUpperCase())}
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: MIN_TARGET,
          height: 1,
          opacity: 0,
          border: 0,
          padding: 0,
          pointerEvents: 'none',
        }}
      />
    </View>
  )
}
