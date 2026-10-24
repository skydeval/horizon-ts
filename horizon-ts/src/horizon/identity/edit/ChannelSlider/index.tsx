/*
 * A colour channel slider on native, with no slider dependency: a track of
 * colour segments and a thumb, dragged with the responder system. Screen
 * readers get an adjustable control with its value read out in words, and
 * swipe up and down (VoiceOver) or the volume-style actions (TalkBack)
 * step it. While a finger is on it the Edit Profile sheet does not drag.
 */

import {useRef, useState} from 'react'
import {type GestureResponderEvent, View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {useDialogContext} from '#/components/Dialog'
import {MIN_TARGET} from '#/horizon/identity/edit/a11y'
import {type ChannelSliderProps, clampStep} from './types'

export * from './types'

const TRACK_HEIGHT = 16
const THUMB = 28

export function ChannelSlider({
  label,
  value,
  min,
  max,
  step = 1,
  valueText,
  onChange,
  track,
  testID,
}: ChannelSliderProps) {
  const t = useTheme()
  const {t: l} = useLingui()
  const dialog = useDialogContext()
  const [width, setWidth] = useState(0)
  const dragWasDisabled = useRef(false)
  const fraction = max > min ? (value - min) / (max - min) : 0

  const fromTouch = (e: GestureResponderEvent) => {
    if (width <= 0) return
    const x = Math.max(0, Math.min(width, e.nativeEvent.locationX))
    onChange(clampStep(min + (x / width) * (max - min), min, max, step))
  }

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityHint={l`Swipe up or down to adjust`}
      accessibilityValue={{text: valueText}}
      accessibilityActions={[{name: 'increment'}, {name: 'decrement'}]}
      onAccessibilityAction={e => {
        if (e.nativeEvent.actionName === 'increment') {
          onChange(clampStep(value + step, min, max, step))
        } else if (e.nativeEvent.actionName === 'decrement') {
          onChange(clampStep(value - step, min, max, step))
        }
      }}
      onLayout={e => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={e => {
        dragWasDisabled.current = dialog.disableDrag
        dialog.setDisableDrag(true)
        fromTouch(e)
      }}
      onResponderMove={fromTouch}
      onResponderRelease={() => dialog.setDisableDrag(dragWasDisabled.current)}
      onResponderTerminate={() =>
        dialog.setDisableDrag(dragWasDisabled.current)
      }
      style={[a.justify_center, {height: MIN_TARGET}]}>
      <View
        pointerEvents="none"
        style={[
          a.flex_row,
          a.overflow_hidden,
          a.rounded_full,
          a.border,
          t.atoms.border_contrast_high,
          {height: TRACK_HEIGHT},
        ]}>
        {track.map((color, i) => (
          <View key={i} style={[a.flex_1, {backgroundColor: color}]} />
        ))}
      </View>
      <View
        pointerEvents="none"
        style={[
          a.absolute,
          a.rounded_full,
          {
            width: THUMB,
            height: THUMB,
            left: Math.max(
              0,
              Math.min(width - THUMB, fraction * width - THUMB / 2),
            ),
            borderWidth: 3,
            borderColor: t.palette.white,
            backgroundColor: 'transparent',
            shadowColor: t.palette.black,
            shadowOpacity: 0.5,
            shadowRadius: 2,
            shadowOffset: {width: 0, height: 0},
            elevation: 2,
          },
        ]}>
        <View
          style={[
            a.flex_1,
            a.rounded_full,
            {borderWidth: 1, borderColor: t.palette.black},
          ]}
        />
      </View>
    </View>
  )
}
