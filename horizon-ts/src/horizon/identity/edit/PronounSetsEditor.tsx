/*
 * The pronoun set editor (Phase 5 design 7.1), shared by the account's
 * pronouns and a member's: one row per set, typed as forms separated by
 * `/`; rows added, removed and reordered, the first the primary set; preset
 * chips that add a row and never change typed rows. Over-limit forms are
 * refused with a note, never cut.
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import {
  ArrowBottom_Stroke2_Corner0_Rounded as DownIcon,
  ArrowTop_Stroke2_Corner0_Rounded as UpIcon,
} from '#/components/icons/Arrow'
import {PlusLarge_Stroke2_Corner0_Rounded as PlusIcon} from '#/components/icons/Plus'
import {TimesLarge_Stroke2_Corner0_Rounded as XIcon} from '#/components/icons/Times'
import {Text} from '#/components/Typography'
import {HIT_44} from '#/horizon/identity/edit/fields'
import {
  editRow,
  moveRow,
  newRow,
  PRONOUN_PRESETS,
  type PronounLimits,
  type PronounRow,
  rowProblem,
  setsFromRows,
} from '#/horizon/identity/edit/pronoun-rows'

export function PronounSetsEditor({
  label,
  rows,
  onChange,
  limits,
  disabled = false,
  testID = 'pronouns',
}: {
  label: string
  rows: PronounRow[]
  onChange: (rows: PronounRow[]) => void
  limits: PronounLimits
  disabled?: boolean
  testID?: string
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const tooManySets = setsFromRows(rows).length > limits.sets
  const full = rows.length >= limits.sets

  return (
    <View style={[a.gap_sm]}>
      <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
        <Trans>
          Type each set with its forms separated by “/”, like she/her. The first
          set is your main one.
        </Trans>
      </Text>
      {rows.map((row, index) => {
        const problem = rowProblem(row, limits)
        const n = index + 1
        return (
          <View key={row.key} style={[a.gap_xs]}>
            <View style={[a.flex_row, a.align_center, a.gap_xs]}>
              <View style={[a.flex_1]}>
                <TextField.Root isInvalid={!!problem}>
                  <Dialog.Input
                    testID={`${testID}Row${index}`}
                    label={l`${label}, set ${n}`}
                    value={row.text}
                    editable={!disabled}
                    onChangeText={text => {
                      const next = [...rows]
                      next[index] = editRow(row, text)
                      onChange(next)
                    }}
                    placeholder={
                      index === 0
                        ? l({
                            message: 'she/her',
                            comment: 'Example of a pronoun set, as a hint',
                          })
                        : undefined
                    }
                  />
                </TextField.Root>
              </View>
              <Button
                label={l`Move set ${n} up`}
                onPress={() => onChange(moveRow(rows, index, -1))}
                disabled={disabled || index === 0}
                size="small"
                color="secondary"
                shape="round"
                hitSlop={HIT_44}>
                <ButtonIcon icon={UpIcon} />
              </Button>
              <Button
                label={l`Move set ${n} down`}
                onPress={() => onChange(moveRow(rows, index, 1))}
                disabled={disabled || index === rows.length - 1}
                size="small"
                color="secondary"
                shape="round"
                hitSlop={HIT_44}>
                <ButtonIcon icon={DownIcon} />
              </Button>
              <Button
                testID={`${testID}Remove${index}`}
                label={l`Remove set ${n}`}
                onPress={() => onChange(rows.filter(r => r.key !== row.key))}
                disabled={disabled}
                size="small"
                color="secondary"
                shape="round"
                hitSlop={HIT_44}>
                <ButtonIcon icon={XIcon} />
              </Button>
            </View>
            {problem ? (
              <Text
                accessibilityLiveRegion="polite"
                style={[a.text_sm, {color: t.palette.negative_400}]}>
                {problem.kind === 'formTooLong' ? (
                  <Trans>
                    “{problem.form}” is too long. Each form can have up to{' '}
                    {limits.graphemes} characters.
                  </Trans>
                ) : (
                  <Trans>A set can have up to {limits.forms} forms.</Trans>
                )}
              </Text>
            ) : null}
          </View>
        )
      })}
      {tooManySets ? (
        <Text style={[a.text_sm, {color: t.palette.negative_400}]}>
          <Trans>You can have up to {limits.sets} sets.</Trans>
        </Text>
      ) : null}
      <View style={[a.flex_row]}>
        <Button
          testID={`${testID}AddRow`}
          label={l`Add a set`}
          onPress={() => onChange([...rows, newRow()])}
          disabled={disabled || full}
          size="small"
          color="secondary"
          hitSlop={HIT_44}>
          <ButtonIcon icon={PlusIcon} />
          <ButtonText>
            <Trans>Add a set</Trans>
          </ButtonText>
        </Button>
      </View>
      <View style={[a.flex_row, a.flex_wrap, a.gap_xs]}>
        {PRONOUN_PRESETS.map(preset => (
          <Button
            key={preset}
            testID={`${testID}Preset-${preset}`}
            label={l`Add ${preset}`}
            onPress={() => onChange([...rows, newRow(preset)])}
            disabled={disabled || full}
            size="small"
            color="secondary"
            hitSlop={HIT_44}>
            <ButtonText>{preset}</ButtonText>
          </Button>
        ))}
      </View>
    </View>
  )
}
