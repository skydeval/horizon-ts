/*
 * Moderate: what a member of a cairn labeler's team can do to a post or an
 * account while browsing, without opening cairn's own UI.
 *
 * - The labeler drop-down lists every labeler the account moderates for:
 *   public ones and member labelers alike. Everything below it follows the
 *   chosen labeler: its values, reasons, audiences and the actions it takes.
 * - Each action shows only with the permission cairn grants for it there;
 *   cairn checks the role again on every event.
 * - Member labelers take labels (optionally limited to an audience),
 *   notes, acknowledge, escalate and a flag to a public labeler, but no
 *   takedowns or mutes. A labels-only labeler takes a label and nothing
 *   else.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {usePdsClient, useSession} from '#/state/session'
import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import * as Toggle from '#/components/forms/Toggle'
import {Loader} from '#/components/Loader'
import {useReportOptions} from '#/components/moderation/ReportDialog/utils/useReportOptions'
import * as Prompt from '#/components/Prompt'
import * as Select from '#/components/Select'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {type ModerationEvent, type ModerationSubject, subjectKey} from './api'
import {
  loadSubject,
  sendEvent,
  type SubjectLabel,
  type SubjectState,
} from './backend'
import {
  actionComment,
  PERMISSIONS,
  reasonFallbackName,
  SYSTEM_LABEL_VALUES,
  takesTakedowns,
  type TeamLabeler,
} from './permissions'
import {useTeamLabelersQuery} from './team'

/** A select's "none" value (a select can't hold an empty one). */
const NONE = 'none'

/** What the dialog moderates. */
export type ModerateTarget =
  | {type: 'post'; uri: string; cid: string; authorDid: string}
  | {type: 'account'; did: string}

export {useDialogControl as useModerateDialogControl} from '#/components/Dialog'

export function ModerateDialog({
  control,
  target,
}: {
  control: Dialog.DialogOuterProps['control']
  target: ModerateTarget
}) {
  return (
    <Dialog.Outer control={control} nativeOptions={{fullHeight: true}}>
      <Dialog.Handle />
      <Inner target={target} />
    </Dialog.Outer>
  )
}

const EXPIRY_HOURS = ['0', '24', '168', '720'] as const

function postSubject(target: ModerateTarget): ModerationSubject {
  return target.type === 'post'
    ? {$type: 'com.atproto.repo.strongRef', uri: target.uri, cid: target.cid}
    : {$type: 'com.atproto.admin.defs#repoRef', did: target.did}
}

function accountSubject(target: ModerateTarget): ModerationSubject {
  return {
    $type: 'com.atproto.admin.defs#repoRef',
    did: target.type === 'post' ? target.authorDid : target.did,
  }
}

function Inner({target}: {target: ModerateTarget}) {
  const {t: l} = useLingui()
  const {data: team, isLoading} = useTeamLabelersQuery()
  const [chosen, setChosen] = useState<string | undefined>()
  const labeler = team?.find(each => each.did === chosen) ?? team?.[0]
  const title = target.type === 'post' ? l`Moderate post` : l`Moderate account`

  return (
    <Dialog.ScrollableInner label={title} style={web({maxWidth: 520})}>
      <View style={[a.gap_lg]}>
        <Text style={[a.text_2xl, a.font_bold]}>{title}</Text>
        {isLoading ? (
          <View style={[a.p_xl, a.align_center]}>
            <Loader size="xl" />
          </View>
        ) : !labeler || !team ? (
          <Text style={[a.text_md]}>
            <Trans>You aren’t on any labeler’s moderation team.</Trans>
          </Text>
        ) : (
          <>
            <Picker
              heading={l`Labeler`}
              value={labeler.did}
              onChange={setChosen}
              items={team.map(each => ({label: each.name, value: each.did}))}
            />
            <Actions key={labeler.did} labeler={labeler} target={target} />
          </>
        )}
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

/** A labelled drop-down. */
function Picker({
  heading,
  value,
  onChange,
  items,
  placeholder,
}: {
  heading: string
  value: string | undefined
  onChange: (value: string) => void
  items: {label: string; value: string}[]
  placeholder?: string
}) {
  return (
    <View style={[a.gap_xs]}>
      <Text style={[a.text_sm, a.font_semi_bold]}>{heading}</Text>
      <Select.Root value={value} onValueChange={onChange}>
        <Select.Trigger label={heading}>
          <Select.ValueText placeholder={placeholder ?? heading} />
          <Select.Icon />
        </Select.Trigger>
        <Select.Content
          label={heading}
          items={items}
          renderItem={({label, value: item}) => (
            <Select.Item value={item} label={label}>
              <Select.ItemIndicator />
              <Select.ItemText>{label}</Select.ItemText>
            </Select.Item>
          )}
        />
      </Select.Root>
    </View>
  )
}

function useSubjectState(labeler: TeamLabeler, subject: ModerationSubject) {
  const pdsClient = usePdsClient()
  return useQuery({
    queryKey: ['horizon-moderate-subject', labeler.did, subjectKey(subject)],
    queryFn: () => loadSubject(pdsClient, labeler, subject),
  })
}

/** The dialog's body for one labeler (exported for its render test). */
export function Actions({
  labeler,
  target,
}: {
  labeler: TeamLabeler
  target: ModerateTarget
}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const {currentAccount} = useSession()
  const pdsClient = usePdsClient()
  const queryClient = useQueryClient()
  const takedownPrompt = Prompt.usePromptControl()
  const {categories} = useReportOptions()
  const can = (permission: string) => labeler.permissions.has(permission)
  const labelsOnly = labeler.kind === 'labels_only'
  const triage = can(PERMISSIONS.triage) && !labelsOnly

  const post = postSubject(target)
  const account = accountSubject(target)
  const postState = useSubjectState(labeler, post)
  const accountState = useSubjectState(labeler, account)
  const status = postState.data

  const [value, setValue] = useState<string | undefined>()
  const [onAccount, setOnAccount] = useState(false)
  const [expiry, setExpiry] = useState<string>('0')
  const [audience, setAudience] = useState<string>(NONE)
  const [note, setNote] = useState('')
  const [reason, setReason] = useState<string>(NONE)
  const [flagTarget, setFlagTarget] = useState<string | undefined>(
    labeler.flagTargets[0]?.did,
  )
  const [flagReason, setFlagReason] = useState<string | undefined>()
  const [flagEscalate, setFlagEscalate] = useState(false)

  const reasonNameOf = (token: string) => {
    if (labeler.reasonNames[token]) return labeler.reasonNames[token]
    for (const category of categories) {
      const option = category.options.find(each => each.reason === token)
      if (option) return `${category.title}: ${option.title}`
    }
    return reasonFallbackName(token)
  }
  const chosenReason =
    reason === NONE ? undefined : {token: reason, name: reasonNameOf(reason)}
  const text = labelsOnly ? undefined : actionComment(chosenReason, note)
  const comment = text ? {comment: text} : {}

  const nameOf = (identifier: string) => {
    const def = labeler.defs.find(each => each.identifier === identifier)
    const strings =
      def?.locales.find(each => i18n.locale.startsWith(each.lang)) ??
      def?.locales[0]
    return strings?.name || identifier
  }
  const audienceName = (id: string | undefined) =>
    id
      ? (labeler.audiences.find(each => each.id === id)?.name ?? id)
      : undefined
  const labelName = (label: SubjectLabel) => {
    const group = audienceName(label.audience)
    return group ? `${nameOf(label.val)} (${group})` : nameOf(label.val)
  }
  const values = [
    ...labeler.defs.map(def => def.identifier),
    ...(can(PERMISSIONS.systemLabels) && !labelsOnly
      ? SYSTEM_LABEL_VALUES
      : []),
  ]

  const {mutate, isPending} = useMutation({
    mutationFn: ({
      event,
      subject,
      audience: limitTo,
    }: {
      event: ModerationEvent
      subject: ModerationSubject
      audience?: string
      done: string
    }) =>
      sendEvent(pdsClient, labeler, {
        event,
        subject,
        audience: limitTo,
        createdBy: currentAccount?.did ?? '',
      }),
    onSuccess: (_answer, {done}) => {
      Toast.show(done, {type: 'success'})
      setNote('')
      void queryClient.invalidateQueries({
        queryKey: ['horizon-moderate-subject', labeler.did],
      })
    },
    onError: error => {
      // Never the labeler's id or the subject: the error's name only.
      logger.warn('moderate: event refused', {
        message: error instanceof Error ? error.name : 'unknown',
      })
      Toast.show(
        cleanError(error instanceof Error ? error.message : String(error)),
        {type: 'error'},
      )
    },
  })

  const send = (
    event: ModerationEvent,
    done: string,
    subject: ModerationSubject = post,
    limitTo?: string,
  ) => mutate({event, subject, done, audience: limitTo})

  const applyLabel = () => {
    if (!value) return
    const hours = Number(expiry)
    send(
      {
        $type: 'tools.ozone.moderation.defs#modEventLabel',
        createLabelVals: [value],
        negateLabelVals: [],
        ...comment,
        ...(hours > 0 ? {durationInHours: hours} : {}),
      },
      l`Label applied`,
      onAccount ? account : post,
      audience === NONE ? undefined : audience,
    )
  }
  const removeLabel = (label: SubjectLabel, subject: ModerationSubject) =>
    send(
      {
        $type: 'tools.ozone.moderation.defs#modEventLabel',
        createLabelVals: [],
        negateLabelVals: [label.val],
        ...comment,
      },
      l`Label removed`,
      subject,
      label.audience,
    )
  const canRemove = (label: SubjectLabel) =>
    label.val.startsWith('!')
      ? can(PERMISSIONS.systemLabels)
      : can(PERMISSIONS.labels)

  const target_ = labeler.flagTargets.find(each => each.did === flagTarget)
  const sendFlag = () => {
    if (!target_ || !flagReason) return
    send(
      {
        $type: 'tools.cairn.moderation.defs#flagEvent',
        target: target_.did,
        reasonType: flagReason,
        ...comment,
        ...(flagEscalate && target_.canEscalate ? {escalateTarget: true} : {}),
      },
      l`Flagged to ${target_.name}`,
    )
  }

  const expiryLabels: Record<(typeof EXPIRY_HOURS)[number], string> = {
    '0': l`No expiry`,
    '24': l`24 hours`,
    '168': l`7 days`,
    '720': l`30 days`,
  }

  return (
    <View style={[a.gap_xl]}>
      {can(PERMISSIONS.labels) && (
        <View style={[a.gap_sm]}>
          <Text style={[a.text_lg, a.font_semi_bold]}>
            <Trans>Apply a label</Trans>
          </Text>
          <Select.Root value={value} onValueChange={setValue}>
            <Select.Trigger label={l`Label`}>
              <Select.ValueText placeholder={l`Choose a label`} />
              <Select.Icon />
            </Select.Trigger>
            <Select.Content
              label={l`Label`}
              items={values.map(each => ({label: nameOf(each), value: each}))}
              renderItem={({label, value: item}) => (
                <Select.Item value={item} label={label}>
                  <Select.ItemIndicator />
                  <Select.ItemText>{label}</Select.ItemText>
                </Select.Item>
              )}
            />
          </Select.Root>
          {labeler.audiences.length > 0 && (
            <Picker
              heading={l`Who sees it`}
              value={audience}
              onChange={setAudience}
              items={[
                {label: l`Everyone who sees this labeler`, value: NONE},
                ...labeler.audiences.map(each => ({
                  label: each.name,
                  value: each.id,
                })),
              ]}
            />
          )}
          {target.type === 'post' && (
            <Toggle.Item
              testID="moderateOnAccount"
              name="moderateOnAccount"
              type="checkbox"
              label={l`Apply to the account instead`}
              value={onAccount}
              onChange={setOnAccount}>
              <Toggle.Checkbox />
              <Toggle.LabelText style={[a.flex_1, a.font_normal]}>
                <Trans>Apply to the account instead</Trans>
              </Toggle.LabelText>
            </Toggle.Item>
          )}
          <Select.Root value={expiry} onValueChange={setExpiry}>
            <Select.Trigger label={l`Expiry`}>
              <Select.ValueText placeholder={l`No expiry`} />
              <Select.Icon />
            </Select.Trigger>
            <Select.Content
              label={l`Expiry`}
              items={EXPIRY_HOURS.map(each => ({
                label: expiryLabels[each],
                value: each,
              }))}
              renderItem={({label, value: item}) => (
                <Select.Item value={item} label={label}>
                  <Select.ItemIndicator />
                  <Select.ItemText>{label}</Select.ItemText>
                </Select.Item>
              )}
            />
          </Select.Root>
          <Button
            testID="moderateApplyLabel"
            label={l`Apply label`}
            color="primary"
            size="small"
            style={[a.self_start]}
            disabled={!value || isPending}
            onPress={applyLabel}>
            <ButtonText>
              <Trans>Apply label</Trans>
            </ButtonText>
            {isPending && <ButtonIcon icon={Loader} />}
          </Button>
        </View>
      )}

      {!labelsOnly && labeler.reasonTypes.length > 0 && (
        <Picker
          heading={l`Reason (optional)`}
          value={reason}
          onChange={setReason}
          placeholder={l`No reason`}
          items={[
            {label: l`No reason`, value: NONE},
            ...labeler.reasonTypes.map(token => ({
              label: reasonNameOf(token),
              value: token,
            })),
          ]}
        />
      )}

      {!labelsOnly && (
        <View style={[a.gap_xs]}>
          <TextField.LabelText>
            <Trans>Note (kept with the action)</Trans>
          </TextField.LabelText>
          <TextField.Root>
            <Dialog.Input
              testID="moderateNote"
              label={l`Note`}
              value={note}
              multiline
              onChangeText={setNote}
            />
          </TextField.Root>
        </View>
      )}

      <CurrentLabels
        heading={target.type === 'post' ? l`On this post` : l`On this account`}
        state={postState}
        labelName={labelName}
        canRemove={canRemove}
        disabled={isPending}
        onRemove={label => removeLabel(label, post)}
      />
      {target.type === 'post' && (
        <CurrentLabels
          heading={l`On the account`}
          state={accountState}
          labelName={labelName}
          canRemove={canRemove}
          disabled={isPending}
          onRemove={label => removeLabel(label, account)}
        />
      )}

      {!labelsOnly && (
        <View style={[a.gap_sm]}>
          <Text style={[a.text_lg, a.font_semi_bold]}>
            <Trans>Actions</Trans>
          </Text>
          <View style={[a.flex_row, a.flex_wrap, a.gap_sm]}>
            {takesTakedowns(labeler) &&
              can(PERMISSIONS.takedowns) &&
              (status?.takendown ? (
                <ActionButton
                  label={l`Restore`}
                  disabled={isPending}
                  onPress={() =>
                    send(
                      {
                        $type:
                          'tools.ozone.moderation.defs#modEventReverseTakedown',
                        ...comment,
                      },
                      l`Restored`,
                    )
                  }
                />
              ) : (
                <ActionButton
                  label={l`Take down`}
                  negative
                  disabled={isPending}
                  onPress={() => takedownPrompt.open()}
                />
              ))}
            {takesTakedowns(labeler) &&
              can(PERMISSIONS.mutes) &&
              (status?.muted ? (
                <ActionButton
                  label={l`Unmute reports`}
                  disabled={isPending}
                  onPress={() =>
                    send(
                      {
                        $type: 'tools.ozone.moderation.defs#modEventUnmute',
                        ...comment,
                      },
                      l`Reports unmuted`,
                    )
                  }
                />
              ) : (
                <ActionButton
                  label={l`Mute reports for 7 days`}
                  disabled={isPending}
                  onPress={() =>
                    send(
                      {
                        $type: 'tools.ozone.moderation.defs#modEventMute',
                        durationInHours: 168,
                        ...comment,
                      },
                      l`Reports muted`,
                    )
                  }
                />
              ))}
            {triage && (
              <ActionButton
                label={l`Save note`}
                disabled={isPending || !text}
                onPress={() =>
                  send(
                    {
                      $type: 'tools.ozone.moderation.defs#modEventComment',
                      comment: text ?? '',
                    },
                    l`Note saved`,
                  )
                }
              />
            )}
          </View>
        </View>
      )}

      {triage && labeler.flagTargets.length > 0 && (
        <View style={[a.gap_sm]}>
          <Text style={[a.text_lg, a.font_semi_bold]}>
            <Trans>Flag to a public labeler</Trans>
          </Text>
          <Picker
            heading={l`Flag to`}
            value={flagTarget}
            onChange={next => {
              setFlagTarget(next)
              setFlagReason(undefined)
            }}
            items={labeler.flagTargets.map(each => ({
              label: each.name,
              value: each.did,
            }))}
          />
          {target_ && (
            <Picker
              heading={l`Flag reason`}
              value={flagReason}
              onChange={setFlagReason}
              placeholder={l`Choose a reason`}
              items={target_.reasonTypes.map(token => ({
                label: reasonNameOf(token),
                value: token,
              }))}
            />
          )}
          {target_?.canEscalate && (
            <Toggle.Item
              testID="moderateFlagEscalate"
              name="moderateFlagEscalate"
              type="checkbox"
              label={l`Escalate it there too`}
              value={flagEscalate}
              onChange={setFlagEscalate}>
              <Toggle.Checkbox />
              <Toggle.LabelText style={[a.flex_1, a.font_normal]}>
                <Trans>Escalate it there too</Trans>
              </Toggle.LabelText>
            </Toggle.Item>
          )}
          <ActionButton
            label={l`Flag`}
            disabled={isPending || !target_ || !flagReason}
            onPress={sendFlag}
          />
        </View>
      )}

      {triage && (status?.openReports ?? 0) > 0 && (
        <View style={[a.gap_sm]}>
          <Admonition type="warning">
            <Trans>This has open reports.</Trans>
          </Admonition>
          <View style={[a.flex_row, a.flex_wrap, a.gap_sm]}>
            <ActionButton
              label={l`Acknowledge`}
              disabled={isPending}
              onPress={() =>
                send(
                  {
                    $type: 'tools.ozone.moderation.defs#modEventAcknowledge',
                    ...comment,
                  },
                  l`Reports acknowledged`,
                )
              }
            />
            <ActionButton
              label={l`Escalate`}
              disabled={isPending}
              onPress={() =>
                send(
                  {
                    $type: 'tools.ozone.moderation.defs#modEventEscalate',
                    ...comment,
                  },
                  l`Escalated`,
                )
              }
            />
          </View>
        </View>
      )}

      <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
        <Trans>
          Actions are taken as {labeler.name}. Labels can take a minute to show
          everywhere.
        </Trans>
      </Text>

      {takesTakedowns(labeler) && (
        <Prompt.Basic
          control={takedownPrompt}
          title={
            target.type === 'post'
              ? l`Take down this post?`
              : l`Take down this account?`
          }
          description={l`It will be hidden wherever this labeler is used. You can restore it later.`}
          confirmButtonCta={l`Take down`}
          confirmButtonColor="negative"
          onConfirm={() =>
            send(
              {
                $type: 'tools.ozone.moderation.defs#modEventTakedown',
                ...comment,
              },
              l`Taken down`,
            )
          }
        />
      )}
    </View>
  )
}

function ActionButton({
  label,
  onPress,
  disabled,
  negative = false,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  negative?: boolean
}) {
  return (
    <Button
      label={label}
      size="small"
      color={negative ? 'negative_subtle' : 'secondary'}
      disabled={disabled}
      onPress={onPress}>
      <ButtonText>{label}</ButtonText>
    </Button>
  )
}

function CurrentLabels({
  heading,
  state,
  labelName,
  canRemove,
  disabled,
  onRemove,
}: {
  heading: string
  state: {data?: SubjectState; isLoading: boolean; isError: boolean}
  labelName: (label: SubjectLabel) => string
  canRemove: (label: SubjectLabel) => boolean
  disabled: boolean
  onRemove: (label: SubjectLabel) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const labels = state.data?.labels ?? []
  return (
    <View style={[a.gap_xs]}>
      <Text style={[a.text_md, a.font_semi_bold]}>{heading}</Text>
      {state.isLoading ? (
        <Loader />
      ) : state.isError ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>Couldn’t load this labeler’s labels.</Trans>
        </Text>
      ) : labels.length === 0 ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>No labels from this labeler.</Trans>
        </Text>
      ) : (
        labels.map(label => {
          const name = labelName(label)
          return (
            <View
              key={`${label.val} ${label.audience ?? ''}`}
              style={[a.flex_row, a.align_center, a.justify_between, a.gap_sm]}>
              <Text style={[a.text_md, a.flex_1]}>{name}</Text>
              {canRemove(label) && (
                <Button
                  label={l`Remove ${name}`}
                  size="small"
                  color="secondary"
                  disabled={disabled}
                  onPress={() => onRemove(label)}>
                  <ButtonText>
                    <Trans>Remove</Trans>
                  </ButtonText>
                </Button>
              )}
            </View>
          )
        })
      )}
    </View>
  )
}
