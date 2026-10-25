/*
 * The front switcher (Phase 5 design 7.3, B-14), for one's own system.
 * Opened from the Plurality tab, and from the profile's front indicator and
 * the composer's "Edit front..." (5B, 5D) with the same `control`.
 *
 * Members as rows; checking one adds it as engaging, and each checked
 * member has a status (Engaging, Co-conscious, Observing, Dormant,
 * Nonverbal, Blurry, or "Other..." as free text). At most 20 (`front.json`);
 * at 20 the other rows are disabled with "Up to 20 members". A state
 * (Solo, Co-fronting, Switching, Blurry, Unknown, or free text) and a
 * comment. "Nobody fronting" writes empty `members`. Save writes the whole
 * record over the one read, `setAt` now, optimistic.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as Toggle from '#/components/forms/Toggle'
import {Loader} from '#/components/Loader'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {HIT_44, LimitedField} from '#/horizon/identity/edit/fields'
import {
  choicesFrom,
  type FrontChoice,
  frontMembersFrom,
} from '#/horizon/identity/edit/front-model'
import {useOwnEntry, useOwnWriter} from '#/horizon/identity/edit/own'
import {FRONT_STATES, FRONT_STATUSES} from '#/horizon/identity/edit/suggestions'
import {formatMemberLabel, formatSets} from '#/horizon/identity/format'
import {type PluralFront} from '#/horizon/identity/parse'
import {type IdentityAnswer, type MemberList} from '#/horizon/identity/queries'
import {
  FRONT_MAX_MEMBERS,
  type FrontInput,
  frontProblem,
  saveFront,
} from '#/horizon/identity/writes'

export function FrontSwitcherDialog({
  control,
  did,
  onClose,
}: {
  control: Dialog.DialogControlProps
  /** The current account's DID (one's own system only). */
  did: string
  /** After the dialog has closed, e.g. to return focus to its trigger. */
  onClose?: () => void
}) {
  return (
    <Dialog.Outer
      control={control}
      onClose={onClose}
      nativeOptions={{fullHeight: true}}>
      <Dialog.Handle />
      <SwitcherLoader control={control} did={did} />
    </Dialog.Outer>
  )
}

function SwitcherLoader({
  control,
  did,
}: {
  control: Dialog.DialogControlProps
  did: string
}) {
  const {t: l} = useLingui()
  const members = useOwnEntry('members', {did})
  const front = useOwnEntry('front', {did})
  if (members.state === 'ready' && front.state === 'ready') {
    return (
      <Switcher
        control={control}
        members={members.answer}
        front={front.answer}
      />
    )
  }
  const failed = members.state === 'error' || front.state === 'error'
  return (
    <Dialog.ScrollableInner
      label={l`Switch front`}
      style={web({maxWidth: 480})}>
      <View style={[a.gap_md, a.py_lg]}>
        {failed ? (
          <>
            <Admonition type="error">
              <Trans>Your front couldn’t be loaded.</Trans>
            </Admonition>
            <View style={[a.flex_row]}>
              <Button
                label={l`Try loading your front again`}
                onPress={() => {
                  members.retry()
                  front.retry()
                }}
                size="small"
                color="secondary">
                <ButtonText>
                  <Trans>Try again</Trans>
                </ButtonText>
              </Button>
            </View>
          </>
        ) : (
          <Loader size="lg" />
        )}
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

type Choice = FrontChoice

const KNOWN_STATES = new Set(FRONT_STATES.map(s => s.value))

function Switcher({
  control,
  members,
  front,
}: {
  control: Dialog.DialogControlProps
  members: MemberList
  front: IdentityAnswer<PluralFront>
}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const writer = useOwnWriter()
  const read = front.kind === 'record' ? front.value : undefined
  const [choices, setChoices] = useState(() => choicesFrom(read))
  const [state, setState] = useState(read?.state ?? '')
  const [stateOther, setStateOther] = useState(
    !!read?.state && !KNOWN_STATES.has(read.state),
  )
  const [comment, setComment] = useState(read?.comment ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const input: FrontInput = {
    members: frontMembersFrom(choices, members),
    state,
    comment,
  }
  const problem = frontProblem(input)
  const checked = members.members
    .filter(m => choices.has(m.rkey))
    .map(m => m.rkey)
  const full = input.members.length >= FRONT_MAX_MEMBERS

  const setChoice = (id: string, choice: Choice | undefined) => {
    setError('')
    setChoices(current => {
      const next = new Map(current)
      if (choice) next.set(id, choice)
      else next.delete(id)
      return next
    })
  }

  const onSave = async (override?: FrontInput) => {
    if (!writer) return
    setSaving(true)
    setError('')
    try {
      await saveFront(writer, front, override ?? input)
      control.close(() => {
        Toast.show(l({message: 'Front updated', context: 'toast'}))
      })
    } catch (e) {
      logger.warn('saving the front failed', {
        message: e instanceof Error ? e.message : String(e),
      })
      setError(cleanError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.ScrollableInner
      label={l`Switch front`}
      style={web({maxWidth: 520})}>
      <View style={[a.gap_lg]} testID="frontSwitcher">
        <Text style={[a.text_2xl, a.font_bold]}>
          <Trans>Switch front</Trans>
        </Text>

        {members.members.length === 0 ? (
          <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
            <Trans>Add members in the Plurality tab first.</Trans>
          </Text>
        ) : (
          <Toggle.Group
            type="checkbox"
            label={l`Who is fronting`}
            values={checked}
            maxSelections={FRONT_MAX_MEMBERS}
            onChange={next => {
              const nextSet = new Set(next)
              for (const id of checked) {
                if (!nextSet.has(id)) setChoice(id, undefined)
              }
              for (const id of next) {
                if (!choices.has(id)) {
                  setChoice(id, {status: 'engaging', other: false})
                }
              }
            }}>
            <View style={[a.gap_md]}>
              {members.members.map(member => {
                const choice = choices.get(member.rkey)
                const pronouns = formatSets(member.value.pronouns)
                const name = formatMemberLabel(member.value)
                return (
                  <View key={member.rkey} style={[a.gap_sm]}>
                    <Toggle.Item
                      name={member.rkey}
                      label={pronouns ? `${name}, ${pronouns}` : name}
                      testID={`frontMember-${member.rkey}`}
                      hitSlop={HIT_44}>
                      <Toggle.Checkbox />
                      {member.value.color ? (
                        <View
                          accessible={false}
                          style={[
                            a.rounded_full,
                            {
                              width: 8,
                              height: 8,
                              backgroundColor: member.value.color,
                            },
                          ]}
                        />
                      ) : null}
                      <Toggle.LabelText style={[a.flex_1]}>
                        {name}
                        {pronouns ? (
                          <Text style={[t.atoms.text_contrast_medium]}>
                            {` ${pronouns}`}
                          </Text>
                        ) : null}
                      </Toggle.LabelText>
                    </Toggle.Item>
                    {choice ? (
                      <StatusChoice
                        name={member.value.displayName}
                        choice={choice}
                        onChange={next => setChoice(member.rkey, next)}
                      />
                    ) : null}
                  </View>
                )
              })}
            </View>
          </Toggle.Group>
        )}
        {full ? (
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Up to 20 members</Trans>
          </Text>
        ) : null}

        <View style={[a.gap_sm]}>
          <Text style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
            <Trans>State</Trans>
          </Text>
          <View style={[a.flex_row, a.flex_wrap, a.gap_xs]}>
            {FRONT_STATES.map(option => {
              const selected = !stateOther && state === option.value
              const label = i18n._(option.label)
              return (
                <Button
                  key={option.value}
                  label={label}
                  accessibilityState={{selected}}
                  onPress={() => {
                    setStateOther(false)
                    setState(selected ? '' : option.value)
                  }}
                  size="small"
                  color={selected ? 'primary' : 'secondary'}
                  hitSlop={HIT_44}>
                  <ButtonText>{label}</ButtonText>
                </Button>
              )
            })}
            <Button
              label={l`Other state`}
              accessibilityState={{selected: stateOther}}
              onPress={() => {
                setStateOther(true)
                if (KNOWN_STATES.has(state)) setState('')
              }}
              size="small"
              color={stateOther ? 'primary' : 'secondary'}
              hitSlop={HIT_44}>
              <ButtonText>
                <Trans>Other…</Trans>
              </ButtonText>
            </Button>
          </View>
          {stateOther ? (
            <LimitedField
              testID="frontStateInput"
              label={l`State`}
              value={state}
              onChange={setState}
              max={32}
            />
          ) : null}
        </View>

        <LimitedField
          testID="frontCommentInput"
          label={l`Comment`}
          value={comment}
          onChange={setComment}
          max={256}
          multiline
        />

        {problem ? (
          <Admonition type="error">
            <Trans>Some of these details are too long.</Trans>
          </Admonition>
        ) : null}
        {error ? <Admonition type="error">{error}</Admonition> : null}

        <View style={[a.gap_sm]}>
          <Button
            testID="frontSaveButton"
            label={l`Save front`}
            color="primary"
            size="large"
            disabled={!writer || saving || !!problem}
            onPress={() => void onSave()}>
            <ButtonText>
              <Trans>Save</Trans>
            </ButtonText>
            {saving && <ButtonIcon icon={Loader} />}
          </Button>
          <Button
            testID="frontNobodyButton"
            label={l`Nobody fronting`}
            accessibilityHint={l`Saves an empty front`}
            color="secondary"
            size="large"
            disabled={!writer || saving}
            onPress={() => {
              setChoices(new Map())
              void onSave({members: [], state, comment})
            }}>
            <ButtonText>
              <Trans>Nobody fronting</Trans>
            </ButtonText>
          </Button>
        </View>
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

function StatusChoice({
  name,
  choice,
  onChange,
}: {
  name: string
  choice: Choice
  onChange: (choice: Choice) => void
}) {
  const {t: l, i18n} = useLingui()
  return (
    <View style={[a.pl_2xl, a.gap_xs]}>
      <View
        style={[a.flex_row, a.flex_wrap, a.gap_xs]}
        accessibilityRole="radiogroup"
        accessibilityLabel={l`Status of ${name}`}
        accessibilityHint={l`Choose how ${name} is in front`}>
        {FRONT_STATUSES.map(option => {
          const selected = !choice.other && choice.status === option.value
          const label = i18n._(option.label)
          return (
            <Button
              key={option.value}
              label={l`${name}: ${label}`}
              role="radio"
              accessibilityState={{checked: selected}}
              onPress={() => onChange({status: option.value, other: false})}
              size="small"
              color={selected ? 'primary' : 'secondary'}
              hitSlop={HIT_44}>
              <ButtonText>{label}</ButtonText>
            </Button>
          )
        })}
        <Button
          label={l`${name}: other status`}
          role="radio"
          accessibilityState={{checked: choice.other}}
          onPress={() =>
            onChange({
              status: choice.other ? choice.status : '',
              other: true,
            })
          }
          size="small"
          color={choice.other ? 'primary' : 'secondary'}
          hitSlop={HIT_44}>
          <ButtonText>
            <Trans>Other…</Trans>
          </ButtonText>
        </Button>
      </View>
      {choice.other ? (
        <LimitedField
          label={l`Status of ${name}`}
          value={choice.status}
          onChange={status => onChange({status, other: true})}
          max={32}
        />
      ) : null}
    </View>
  )
}
