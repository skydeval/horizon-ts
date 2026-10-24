/*
 * Small fields the identity editors share (Phase 5 design 6.5, 7): a text
 * field with its grapheme limit announced through the stock counter, and a
 * chips field (roles, member types) with suggestions written only into its
 * own field (P5R1-L8).
 */

import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'
import {countGraphemes} from 'unicode-segmenter/grapheme'

import {CharProgress} from '#/view/com/composer/char-progress/CharProgress'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import {PlusLarge_Stroke2_Corner0_Rounded as PlusIcon} from '#/components/icons/Plus'
import {TimesLarge_Stroke2_Corner0_Rounded as XIcon} from '#/components/icons/Times'
import {Text} from '#/components/Typography'

/** Extends a small button toward a 44 px touch target (6.5). */
export const HIT_44 = {top: 6, bottom: 6, left: 6, right: 6}

/** The limit's counter, read out as the characters left. */
export function LimitCounter({value, max}: {value: string; max: number}) {
  const {t: l} = useLingui()
  const count = countGraphemes(value)
  const left = max - count
  return (
    <View
      accessible
      accessibilityLabel={
        left >= 0
          ? l`${left} characters left`
          : l`${-left} characters over the limit`
      }
      accessibilityHint={l`The most this field can hold is ${max} characters`}>
      <CharProgress count={count} max={max} size={22} />
    </View>
  )
}

/** A labelled text field with its grapheme limit. */
export function LimitedField({
  label,
  value,
  onChange,
  max,
  placeholder,
  multiline = false,
  required = false,
  testID,
  accessory,
  onSelectionChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  max: number
  placeholder?: string
  multiline?: boolean
  required?: boolean
  testID?: string
  /** A control beside the input, such as the emoji field's picker button. */
  accessory?: React.ReactNode
  /** The input's selection as it changes, in UTF-16 offsets. */
  onSelectionChange?: (selection: {start: number; end: number}) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const over = countGraphemes(value) > max
  const input = (
    <TextField.Root isInvalid={over}>
      <Dialog.Input
        testID={testID}
        label={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        multiline={multiline}
        accessibilityHint={required ? l`Required` : undefined}
        onSelectionChange={
          onSelectionChange
            ? e => onSelectionChange(e.nativeEvent.selection)
            : undefined
        }
      />
    </TextField.Root>
  )
  return (
    <View>
      <View style={[a.flex_row, a.align_center, a.justify_between]}>
        <TextField.LabelText>{label}</TextField.LabelText>
        <LimitCounter value={value} max={max} />
      </View>
      {accessory ? (
        <View style={[a.flex_row, a.align_center, a.gap_sm]}>
          <View style={[a.flex_1]}>{input}</View>
          {accessory}
        </View>
      ) : (
        input
      )}
      {over ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[
            a.text_sm,
            a.mt_xs,
            a.font_semi_bold,
            {color: t.palette.negative_400},
          ]}>
          <Trans>This is too long. The most is {max} characters.</Trans>
        </Text>
      ) : null}
    </View>
  )
}

/**
 * A list of short values as chips, with free text and suggestions. A
 * suggestion already chosen is not offered again.
 */
export function ChipsField({
  label,
  hint,
  values,
  onChange,
  suggestions,
  max,
  maxGraphemes,
  testID,
}: {
  label: string
  hint?: string
  values: string[]
  onChange: (values: string[]) => void
  suggestions: readonly string[]
  max: number
  maxGraphemes: number
  testID?: string
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const [draft, setDraft] = useState('')
  const full = values.length >= max
  const add = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || full || values.includes(trimmed)) return
    onChange([...values, trimmed])
  }
  const draftTooLong = countGraphemes(draft.trim()) > maxGraphemes
  const offered = suggestions.filter(s => !values.includes(s))
  return (
    <View style={[a.gap_sm]}>
      <TextField.LabelText>{label}</TextField.LabelText>
      {hint ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>{hint}</Text>
      ) : null}
      {values.length > 0 ? (
        <View style={[a.flex_row, a.flex_wrap, a.gap_xs]}>
          {values.map(value => (
            <Button
              key={value}
              label={l`Remove ${value}`}
              onPress={() => onChange(values.filter(v => v !== value))}
              size="small"
              color="secondary"
              hitSlop={HIT_44}>
              <ButtonText>{value}</ButtonText>
              <ButtonIcon icon={XIcon} />
            </Button>
          ))}
        </View>
      ) : null}
      <View style={[a.flex_row, a.align_center, a.gap_sm]}>
        <View style={[a.flex_1]}>
          <TextField.Root isInvalid={draftTooLong}>
            <Dialog.Input
              testID={testID}
              label={l`Add to ${label}`}
              value={draft}
              onChangeText={setDraft}
              placeholder={l`Type and add`}
              editable={!full}
              onSubmitEditing={() => {
                if (draftTooLong) return
                add(draft)
                setDraft('')
              }}
            />
          </TextField.Root>
        </View>
        <Button
          label={l`Add to ${label}`}
          onPress={() => {
            add(draft)
            setDraft('')
          }}
          disabled={full || draftTooLong || !draft.trim()}
          size="small"
          color="secondary"
          shape="round"
          hitSlop={HIT_44}>
          <ButtonIcon icon={PlusIcon} />
        </Button>
      </View>
      {draftTooLong ? (
        <Text style={[a.text_sm, {color: t.palette.negative_400}]}>
          <Trans>Each one can have up to {maxGraphemes} characters.</Trans>
        </Text>
      ) : null}
      {full ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>Up to {max}.</Trans>
        </Text>
      ) : offered.length > 0 ? (
        <View style={[a.gap_xs]}>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Suggestions</Trans>
          </Text>
          <View style={[a.flex_row, a.flex_wrap, a.gap_xs]}>
            {offered.map(suggestion => (
              <Button
                key={suggestion}
                label={l`Add ${suggestion} to ${label}`}
                onPress={() => add(suggestion)}
                size="small"
                color="secondary"
                hitSlop={HIT_44}>
                <ButtonIcon icon={PlusIcon} />
                <ButtonText>{suggestion}</ButtonText>
              </Button>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  )
}
