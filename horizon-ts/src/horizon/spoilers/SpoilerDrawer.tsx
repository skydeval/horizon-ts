/*
 * A block spoiler (spoilers design, 6.5, 6.7): a closed drawer under the line
 * above it, opened by an arrow at the end of that line, or by a "Spoiler" row
 * when nothing precedes it. The drawer is the stock `Expandable`, which
 * animates its height and unmounts its content once closed.
 */

import {useState} from 'react'
import {Pressable, type StyleProp, type TextStyle, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {useHaptics} from '#/lib/haptics'
import {Expandable} from '#/screens/Notifications/components/NotificationItem/Item/Expandable'
import {atoms as a, useTheme, web} from '#/alf'
import {
  ChevronBottom_Stroke2_Corner0_Rounded as ChevronDown,
  ChevronTop_Stroke2_Corner0_Rounded as ChevronUp,
} from '#/components/icons/Chevron'
import {Text} from '#/components/Typography'
import {onSpoilerKey, onSpoilerPress} from './InlineSpoiler'

function useDrawerLabels(open: boolean) {
  const {t: l} = useLingui()
  return {
    label: l({
      message: 'Spoiler',
      comment:
        'Screen reader label of the control that opens hidden spoiler lines in a post',
    }),
    hint: open
      ? l({
          message: 'Hides the lines',
          comment:
            'Screen reader hint of the control that closes open spoiler lines',
        })
      : l({
          message: 'Shows the hidden lines',
          comment:
            'Screen reader hint of the control that opens hidden spoiler lines',
        }),
  }
}

/**
 * The arrow at the end of the line above a block spoiler, inside that line's
 * text.
 */
export function SpoilerArrow({
  open,
  onToggle,
  style,
}: {
  open: boolean
  onToggle: () => void
  style: StyleProp<TextStyle>
}) {
  const t = useTheme()
  const haptics = useHaptics()
  const {label, hint} = useDrawerLabels(open)
  const [focused, setFocused] = useState(false)
  const toggle = () => {
    haptics.tap()
    onToggle()
  }
  const Chevron = open ? ChevronUp : ChevronDown
  return (
    <Text
      style={[
        style,
        web({cursor: 'pointer', userSelect: 'none'}),
        focused && web({boxShadow: `0 0 0 2px ${t.palette.primary_500}`}),
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{expanded: open}}
      onPress={onSpoilerPress(toggle)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      {...web({onKeyDown: onSpoilerKey(toggle)})}>
      {' '}
      <Chevron
        size="sm"
        fill={t.atoms.text_contrast_medium.color}
        style={web({verticalAlign: 'middle'})}
      />
    </Text>
  )
}

/**
 * The row that opens a block spoiler with nothing above it.
 */
export function SpoilerLabelRow({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}) {
  const t = useTheme()
  const haptics = useHaptics()
  const {label, hint} = useDrawerLabels(open)
  const Chevron = open ? ChevronUp : ChevronDown
  return (
    <Pressable
      style={[a.flex_row, a.align_center, a.gap_xs, a.self_start, a.py_2xs]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{expanded: open}}
      onPress={onSpoilerPress(() => {
        haptics.tap()
        onToggle()
      })}>
      <Text style={[a.text_sm, a.font_medium, t.atoms.text_contrast_medium]}>
        <Trans comment="Label of a closed or open block of spoiler lines in a post">
          Spoiler
        </Trans>
      </Text>
      <Chevron size="sm" fill={t.atoms.text_contrast_medium.color} />
    </Pressable>
  )
}

/**
 * The drawer: nothing in the tree while closed.
 */
export function SpoilerDrawerBody({
  open,
  children,
}: {
  open: boolean
  children: React.ReactNode
}) {
  const t = useTheme()
  return (
    <Expandable expanded={open}>
      <View
        style={[
          a.mt_2xs,
          a.mb_xs,
          a.pl_sm,
          {borderLeftWidth: 2},
          t.atoms.border_contrast_medium,
        ]}>
        {children}
      </View>
    </Expandable>
  )
}
