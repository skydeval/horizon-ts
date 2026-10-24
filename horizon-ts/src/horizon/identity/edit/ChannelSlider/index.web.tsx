/*
 * A colour channel slider on web: a native `<input type="range">`, so the
 * browser supplies the slider role, the arrow keys, Home and End, and the
 * screen reader support. Page Up and Page Down move by `pageStep`. The
 * stylesheet removes the focus outline from inputs, so the ring is set
 * inline.
 */

import {useState} from 'react'
import {View} from 'react-native'

import {useTheme} from '#/alf'
import {MIN_TARGET} from '#/horizon/identity/edit/a11y'
import {type ChannelSliderProps, clampStep} from './types'

export * from './types'

export function ChannelSlider({
  label,
  value,
  min,
  max,
  step = 1,
  pageStep = 10,
  valueText,
  onChange,
  track,
  testID,
}: ChannelSliderProps) {
  const t = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <View style={{height: MIN_TARGET, justifyContent: 'center'}}>
      <input
        data-testid={testID}
        type="range"
        aria-label={label}
        aria-valuetext={valueText}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.currentTarget.value))}
        onKeyDown={e => {
          if (e.key === 'PageUp' || e.key === 'PageDown') {
            e.preventDefault()
            const delta = e.key === 'PageUp' ? pageStep : -pageStep
            onChange(clampStep(value + delta, min, max, step))
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: '100%',
          height: 16,
          margin: 0,
          borderRadius: 8,
          border: `1px solid ${t.palette.contrast_500}`,
          appearance: 'none',
          WebkitAppearance: 'none',
          cursor: 'pointer',
          background: `linear-gradient(to right, ${track.join(', ')})`,
          outline: focused ? `2px solid ${t.palette.primary_500}` : 'none',
          outlineOffset: 3,
        }}
      />
    </View>
  )
}
