/*
 * Moderate: what a member of a cairn labeler's team can do to a post or an
 * account while browsing, without opening cairn's own UI. Each action shows
 * only with the permission cairn grants for it on the chosen labeler; the
 * labeler checks the role again on every event.
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
import {
  emitEvent,
  getCurrentLabels,
  getSubjectStatus,
  hasOpenReports,
  type ModerationEvent,
  type ModerationSubject,
  type QueriedLabel,
  subjectKey,
} from './api'
import {
  actionComment,
  PERMISSIONS,
  reasonFallbackName,
  SYSTEM_LABEL_VALUES,
  type TeamLabeler,
} from './permissions'

/** The reason drop-down's "none" value (a select can't hold an empty one). */
const NO_REASON = 'none'
import {useTeamLabelersQuery} from './team'

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
            {team.length > 0 && (
              <View style={[a.gap_xs]}>
                <Text style={[a.text_sm, a.font_semi_bold]}>
                  <Trans>Labeler</Trans>
                </Text>
                <Select.Root value={labeler.did} onValueChange={setChosen}>
                  <Select.Trigger label={l`Labeler`}>
                    <Select.ValueText placeholder={l`Labeler`} />
                    <Select.Icon />
                  </Select.Trigger>
                  <Select.Content
                    label={l`Labeler`}
                    items={team.map(each => ({
                      label: each.name,
                      value: each.did,
                    }))}
                    renderItem={({label, value}) => (
                      <Select.Item value={value} label={label}>
                        <Select.ItemIndicator />
                        <Select.ItemText>{label}</Select.ItemText>
                      </Select.Item>
                    )}
                  />
                </Select.Root>
              </View>
            )}
            <Actions key={labeler.did} labeler={labeler} target={target} />
          </>
        )}
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

function useLabelerState(labeler: string, subject: ModerationSubject) {
  const pdsClient = usePdsClient()
  const key = subjectKey(subject)
  const labels = useQuery({
    queryKey: ['horizon-moderate-labels', labeler, key],
    queryFn: () => getCurrentLabels(pdsClient, labeler, subject),
  })
  const status = useQuery({
    queryKey: ['horizon-moderate-status', labeler, key],
    queryFn: () => getSubjectStatus(pdsClient, labeler, subject),
  })
  return {labels, status}
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
  const can = (permission: string) => labeler.permissions.has(permission)

  const post = postSubject(target)
  const account = accountSubject(target)
  const postState = useLabelerState(labeler.did, post)
  const accountState = useLabelerState(labeler.did, account)
  const status = postState.status.data

  const [value, setValue] = useState<string | undefined>()
  const [onAccount, setOnAccount] = useState(false)
  const [expiry, setExpiry] = useState<string>('0')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState<string>(NO_REASON)
  const {categories} = useReportOptions()

  // A reason's name: Horizon's own report wording when it knows the token.
  const reasonNameOf = (token: string) => {
    for (const category of categories) {
      const option = category.options.find(each => each.reason === token)
      if (option) return `${category.title}: ${option.title}`
    }
    return reasonFallbackName(token)
  }
  const chosenReason =
    reason === NO_REASON
      ? undefined
      : {token: reason, name: reasonNameOf(reason)}

  const nameOf = (identifier: string) => {
    const def = labeler.defs.find(each => each.identifier === identifier)
    const strings =
      def?.locales.find(each => i18n.locale.startsWith(each.lang)) ??
      def?.locales[0]
    return strings?.name || identifier
  }
  const values = [
    ...labeler.defs.map(def => def.identifier),
    ...(can(PERMISSIONS.systemLabels) ? SYSTEM_LABEL_VALUES : []),
  ]

  const {mutate, isPending} = useMutation({
    mutationFn: ({
      event,
      subject,
    }: {
      event: ModerationEvent
      subject: ModerationSubject
      done: string
    }) =>
      emitEvent(pdsClient, labeler.did, {
        event,
        subject,
        createdBy: currentAccount?.did ?? '',
      }),
    onSuccess: (_answer, {done}) => {
      Toast.show(done, {type: 'success'})
      setNote('')
      void queryClient.invalidateQueries({
        queryKey: ['horizon-moderate-labels', labeler.did],
      })
      void queryClient.invalidateQueries({
        queryKey: ['horizon-moderate-status', labeler.did],
      })
    },
    onError: error => {
      logger.warn('moderate: event refused', {
        message: error instanceof Error ? error.message : 'unknown',
      })
      Toast.show(
        cleanError(error instanceof Error ? error.message : String(error)),
        {
          type: 'error',
        },
      )
    },
  })

  const text = actionComment(chosenReason, note)
  const comment = text ? {comment: text} : {}
  const send = (
    event: ModerationEvent,
    done: string,
    subject: ModerationSubject = post,
  ) => mutate({event, subject, done})

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
    )
  }
  const removeLabel = (label: QueriedLabel, subject: ModerationSubject) =>
    send(
      {
        $type: 'tools.ozone.moderation.defs#modEventLabel',
        createLabelVals: [],
        negateLabelVals: [label.val],
        ...comment,
      },
      l`Label removed`,
      subject,
    )

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

      {labeler.reasonTypes.length > 0 && (
        <View style={[a.gap_xs]}>
          <Text style={[a.text_sm, a.font_semi_bold]}>
            <Trans>Reason (optional)</Trans>
          </Text>
          <Select.Root value={reason} onValueChange={setReason}>
            <Select.Trigger label={l`Reason`}>
              <Select.ValueText placeholder={l`No reason`} />
              <Select.Icon />
            </Select.Trigger>
            <Select.Content
              label={l`Reason`}
              items={[
                {label: l`No reason`, value: NO_REASON},
                ...labeler.reasonTypes.map(token => ({
                  label: reasonNameOf(token),
                  value: token,
                })),
              ]}
              renderItem={({label, value: item}) => (
                <Select.Item value={item} label={label}>
                  <Select.ItemIndicator />
                  <Select.ItemText>{label}</Select.ItemText>
                </Select.Item>
              )}
            />
          </Select.Root>
        </View>
      )}

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

      <CurrentLabels
        heading={target.type === 'post' ? l`On this post` : l`On this account`}
        query={postState.labels}
        nameOf={nameOf}
        canRemove={label =>
          label.val.startsWith('!')
            ? can(PERMISSIONS.systemLabels)
            : can(PERMISSIONS.labels)
        }
        disabled={isPending}
        onRemove={label => removeLabel(label, post)}
      />
      {target.type === 'post' && (
        <CurrentLabels
          heading={l`On the account`}
          query={accountState.labels}
          nameOf={nameOf}
          canRemove={label =>
            label.val.startsWith('!')
              ? can(PERMISSIONS.systemLabels)
              : can(PERMISSIONS.labels)
          }
          disabled={isPending}
          onRemove={label => removeLabel(label, account)}
        />
      )}

      <View style={[a.gap_sm]}>
        <Text style={[a.text_lg, a.font_semi_bold]}>
          <Trans>Actions</Trans>
        </Text>
        <View style={[a.flex_row, a.flex_wrap, a.gap_sm]}>
          {can(PERMISSIONS.takedowns) &&
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
          {can(PERMISSIONS.mutes) &&
            (status?.muteUntil && Date.parse(status.muteUntil) > Date.now() ? (
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
          {can(PERMISSIONS.triage) && (
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

      {can(PERMISSIONS.triage) && hasOpenReports(status) && (
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
            {$type: 'tools.ozone.moderation.defs#modEventTakedown', ...comment},
            l`Taken down`,
          )
        }
      />
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
  query,
  nameOf,
  canRemove,
  disabled,
  onRemove,
}: {
  heading: string
  query: {data?: QueriedLabel[]; isLoading: boolean; isError: boolean}
  nameOf: (identifier: string) => string
  canRemove: (label: QueriedLabel) => boolean
  disabled: boolean
  onRemove: (label: QueriedLabel) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  return (
    <View style={[a.gap_xs]}>
      <Text style={[a.text_md, a.font_semi_bold]}>{heading}</Text>
      {query.isLoading ? (
        <Loader />
      ) : query.isError ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>Couldn’t load this labeler’s labels.</Trans>
        </Text>
      ) : (query.data ?? []).length === 0 ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>No labels from this labeler.</Trans>
        </Text>
      ) : (
        (query.data ?? []).map(label => {
          const name = nameOf(label.val)
          return (
            <View
              key={label.val}
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
