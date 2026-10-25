/*
 * Edit Profile's Plurality tab (Phase 5 design 7.2, B-13).
 *
 * - **Not set up:** a line of explanation and "Set up a plural system",
 *   which writes an empty system record (the record existing is the
 *   signal, PL).
 * - **System:** name, description, collective noun, member count, saved on
 *   their own Save.
 * - **Front:** who is fronting now and "Switch front" (7.3).
 * - **Members:** the list in ascending rkey order (creation order, with
 *   TIDs) and "Add member"; a member opens the member editor in place.
 * - **System accounts** (system accounts design 4.1): below Members, or
 *   under "Set up a plural system"; a list needs no system record.
 * - **Remove plural system:** a confirm, then the system record first and
 *   everything else after (`removePluralSystem`). The dialog states the
 *   residual (P5R1-Q2); a failure after the system record is gone shows
 *   "Some members couldn't be removed" with "Try again".
 */

import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {UserAvatar} from '#/view/com/util/UserAvatar'
import {atoms as a, useTheme} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {useDialogControl} from '#/components/Dialog'
import * as Toggle from '#/components/forms/Toggle'
import {PlusLarge_Stroke2_Corner0_Rounded as PlusIcon} from '#/components/icons/Plus'
import {Loader} from '#/components/Loader'
import * as Prompt from '#/components/Prompt'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {HIT_44, LimitedField} from '#/horizon/identity/edit/fields'
import {FrontSwitcherDialog} from '#/horizon/identity/edit/FrontSwitcherDialog'
import {MemberEditor} from '#/horizon/identity/edit/MemberEditor'
import {useOwnEntry, useOwnWriter} from '#/horizon/identity/edit/own'
import {formatMemberLabel, formatSets} from '#/horizon/identity/format'
import {memberImageUrl} from '#/horizon/identity/images'
import {isEngaging, type PluralSystem} from '#/horizon/identity/parse'
import {type IdentityAnswer} from '#/horizon/identity/queries'
import {
  PluralRemovalIncompleteError,
  removePluralSystem,
  saveSystem,
  setUpSystem,
  type SystemInput,
  systemProblem,
} from '#/horizon/identity/writes'
import {SYSTEM_ACCOUNTS} from '#/horizon/switches'
import {useCachedLists} from '#/horizon/system-accounts/list-store'
import {removeSystemAccount} from '#/horizon/system-accounts/register'
import {SystemAccountsSection} from '#/horizon/system-accounts/SystemAccountsSection'

export function PluralityTab({did}: {did: string}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const writer = useOwnWriter()
  const system = useOwnEntry('system', {did})
  const members = useOwnEntry('members', {did})
  const front = useOwnEntry('front', {did})
  const [editing, setEditing] = useState<{rkey?: string} | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [incomplete, setIncomplete] = useState(false)
  const removeControl = useDialogControl()
  const frontControl = useDialogControl()
  // System accounts stay unless also removed (system accounts design 13.4, SQ-6).
  const [alsoRemoveAccounts, setAlsoRemoveAccounts] = useState(false)
  const cachedLists = useCachedLists()
  const systemAccounts = SYSTEM_ACCOUNTS
    ? (cachedLists[did]?.accounts ?? [])
    : []

  const memberList = members.state === 'ready' ? members.answer.members : []

  if (editing) {
    return (
      <MemberEditor
        did={did}
        rkey={editing.rkey}
        members={memberList}
        front={front.state === 'ready' ? front.answer : undefined}
        onDone={() => setEditing(null)}
      />
    )
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      logger.warn('a plural write failed', {
        message: e instanceof Error ? e.message : String(e),
      })
      setError(cleanError(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const onRemove = () =>
    void run(async () => {
      if (!writer) return
      try {
        await removePluralSystem(writer)
        setIncomplete(false)
        Toast.show(l({message: 'Plural system removed', context: 'toast'}))
        if (alsoRemoveAccounts) {
          setAlsoRemoveAccounts(false)
          // Each as "Remove" does (4.5), one at a time.
          for (const account of systemAccounts) {
            await removeSystemAccount(did, account.did, account.handle)
          }
        }
      } catch (e) {
        if (e instanceof PluralRemovalIncompleteError) {
          setIncomplete(true)
          return
        }
        throw e
      }
    })

  let body: React.ReactNode
  if (system.state === 'loading') {
    body = <Loader size="lg" />
  } else if (system.state === 'error') {
    body = (
      <RetryLine
        message={l`Your plural system couldn’t be loaded.`}
        onRetry={system.retry}
      />
    )
  } else if (system.answer.kind === 'none') {
    body = (
      <View style={[a.gap_md]} testID="pluralityNotSetUp">
        <Text style={[a.text_md, a.leading_snug]}>
          <Trans>
            A plural system shares this account. Its members can be named on
            posts, and your profile shows who is fronting.
          </Trans>
        </Text>
        <Button
          testID="pluralitySetUp"
          label={l`Set up a plural system`}
          color="primary"
          size="large"
          disabled={!writer || busy}
          onPress={() =>
            void run(async () => {
              if (writer) await setUpSystem(writer)
            })
          }>
          <ButtonText>
            <Trans>Set up a plural system</Trans>
          </ButtonText>
          {busy && <ButtonIcon icon={Loader} />}
        </Button>
        {/* System accounts need no system record (SA-1). */}
        <SystemAccountsSection did={did} />
      </View>
    )
  } else {
    const engagingIds = new Set(
      front.state === 'ready' && front.answer.kind === 'record'
        ? front.answer.value.members.filter(isEngaging).map(m => m.id)
        : [],
    )
    const engaging = memberList.filter(m => engagingIds.has(m.rkey))
    body = (
      <View style={[a.gap_2xl]}>
        <SystemDetails
          key={system.answer.cid ?? 'system'}
          previous={system.answer}
        />

        <View style={[a.gap_sm]} testID="pluralityFront">
          <Text style={[a.text_lg, a.font_semi_bold]}>
            <Trans>Front</Trans>
          </Text>
          <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
            {front.state !== 'ready' ? (
              <Trans>Loading…</Trans>
            ) : front.answer.kind === 'none' ? (
              <Trans>No front set.</Trans>
            ) : engaging.length === 0 ? (
              <Trans>Nobody fronting</Trans>
            ) : (
              engaging.map(m => m.value.displayName).join(', ')
            )}
          </Text>
          <View style={[a.flex_row]}>
            <Button
              testID="pluralitySwitchFront"
              label={
                front.state === 'ready' && front.answer.kind === 'none'
                  ? l`Set front`
                  : l`Switch front`
              }
              onPress={() => frontControl.open()}
              disabled={front.state !== 'ready' || members.state !== 'ready'}
              size="small"
              color="secondary"
              hitSlop={HIT_44}>
              <ButtonText>
                {front.state === 'ready' && front.answer.kind === 'none' ? (
                  <Trans>Set front</Trans>
                ) : (
                  <Trans>Switch front</Trans>
                )}
              </ButtonText>
            </Button>
          </View>
        </View>

        <View style={[a.gap_sm]} testID="pluralityMembers">
          <Text style={[a.text_lg, a.font_semi_bold]}>
            <Trans>Members</Trans>
          </Text>
          {members.state === 'loading' ? (
            <Loader />
          ) : members.state === 'error' ? (
            <RetryLine
              message={l`Your members couldn’t be loaded.`}
              onRetry={members.retry}
            />
          ) : (
            <>
              {memberList.length === 0 ? (
                <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
                  <Trans>No members yet.</Trans>
                </Text>
              ) : (
                memberList.map(member => {
                  const pronouns = formatSets(member.value.pronouns)
                  const label = formatMemberLabel(member.value)
                  return (
                    <Button
                      key={member.rkey}
                      testID={`pluralityMember-${member.rkey}`}
                      label={l`Edit ${member.value.displayName}`}
                      onPress={() => setEditing({rkey: member.rkey})}
                      size="large"
                      color="secondary"
                      style={[a.justify_start, a.gap_sm]}>
                      <UserAvatar
                        type="user"
                        size={32}
                        avatar={
                          member.value.avatar
                            ? memberImageUrl(
                                did,
                                member.value.avatar,
                                'avatar_thumbnail',
                              )
                            : undefined
                        }
                      />
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
                      <Text
                        emoji
                        numberOfLines={1}
                        style={[a.flex_1, a.text_md, a.font_semi_bold]}>
                        {label}
                        {pronouns ? (
                          <Text
                            style={[
                              a.font_normal,
                              t.atoms.text_contrast_medium,
                            ]}>
                            {` ${pronouns}`}
                          </Text>
                        ) : null}
                      </Text>
                    </Button>
                  )
                })
              )}
              {members.answer.partial ? (
                <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                  <Trans>and more</Trans>
                </Text>
              ) : null}
              <View style={[a.flex_row]}>
                <Button
                  testID="pluralityAddMember"
                  label={l`Add member`}
                  onPress={() => setEditing({})}
                  size="small"
                  color="primary"
                  hitSlop={HIT_44}>
                  <ButtonIcon icon={PlusIcon} />
                  <ButtonText>
                    <Trans>Add member</Trans>
                  </ButtonText>
                </Button>
              </View>
            </>
          )}
        </View>

        <SystemAccountsSection did={did} />

        <View style={[a.gap_sm]}>
          <Button
            testID="pluralityRemove"
            label={l`Remove plural system`}
            color="negative_subtle"
            size="large"
            disabled={!writer || busy}
            onPress={() => removeControl.open()}>
            <ButtonText>
              <Trans>Remove plural system</Trans>
            </ButtonText>
          </Button>
        </View>

        <FrontSwitcherDialog control={frontControl} did={did} />
      </View>
    )
  }

  return (
    <View style={[a.px_xl, a.pb_2xl, a.gap_lg]} testID="pluralityTab">
      {incomplete ? (
        <View style={[a.gap_sm]} testID="pluralityRemoveIncomplete">
          <Admonition type="warning">
            <Trans>Some members couldn’t be removed.</Trans>
          </Admonition>
          <View style={[a.flex_row]}>
            <Button
              testID="pluralityRemoveRetry"
              label={l`Try removing the rest again`}
              onPress={onRemove}
              disabled={busy}
              size="small"
              color="secondary">
              <ButtonText>
                <Trans>Try again</Trans>
              </ButtonText>
            </Button>
          </View>
        </View>
      ) : null}
      {error ? <Admonition type="error">{error}</Admonition> : null}
      {body}
      <Prompt.Outer control={removeControl}>
        <Prompt.Content>
          <Prompt.TitleText>
            <Trans>Remove plural system?</Trans>
          </Prompt.TitleText>
          <Prompt.DescriptionText>
            <Trans>
              This deletes your system, all its members and the front.
            </Trans>
          </Prompt.DescriptionText>
          <Prompt.DescriptionText>
            <Trans>
              Your posts still record that members wrote them, though not their
              names.
            </Trans>
          </Prompt.DescriptionText>
          {systemAccounts.length > 0 ? (
            <View style={[a.gap_sm, a.pb_md]}>
              <Text style={[a.text_md, a.leading_snug]}>
                <Trans>Your system accounts stay. Also remove them?</Trans>
              </Text>
              <Toggle.Item
                testID="pluralityRemoveSystemAccounts"
                name="alsoRemoveSystemAccounts"
                label={l`Also remove your system accounts`}
                value={alsoRemoveAccounts}
                onChange={setAlsoRemoveAccounts}
                hitSlop={HIT_44}>
                <Toggle.Checkbox />
                <Toggle.LabelText>
                  <Trans>Also remove them</Trans>
                </Toggle.LabelText>
              </Toggle.Item>
            </View>
          ) : null}
        </Prompt.Content>
        <Prompt.Actions>
          <Prompt.Action
            testID="pluralityRemoveConfirm"
            cta={l`Remove`}
            color="negative"
            onPress={onRemove}
          />
          <Prompt.Cancel />
        </Prompt.Actions>
      </Prompt.Outer>
    </View>
  )
}

function RetryLine({message, onRetry}: {message: string; onRetry: () => void}) {
  const {t: l} = useLingui()
  return (
    <View style={[a.gap_sm]}>
      <Admonition type="error">{message}</Admonition>
      <View style={[a.flex_row]}>
        <Button
          label={l`Try again`}
          onPress={onRetry}
          size="small"
          color="secondary">
          <ButtonText>
            <Trans>Try again</Trans>
          </ButtonText>
        </Button>
      </View>
    </View>
  )
}

function inputFrom(system: PluralSystem | undefined): SystemInput {
  return {
    name: system?.name ?? '',
    description: system?.description ?? '',
    collectiveNoun: system?.collectiveNoun ?? '',
    memberCount: system?.memberCount ?? '',
  }
}

function SystemDetails({previous}: {previous: IdentityAnswer<PluralSystem>}) {
  const {t: l} = useLingui()
  const writer = useOwnWriter()
  const read = previous.kind === 'record' ? previous.value : undefined
  const [input, setInput] = useState(() => inputFrom(read))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const base = inputFrom(read)
  const dirty = (Object.keys(base) as (keyof SystemInput)[]).some(
    key => base[key].trim() !== input[key].trim(),
  )
  const problem = systemProblem(input)

  const set = (key: keyof SystemInput, value: string) => {
    setError('')
    setInput(current => ({...current, [key]: value}))
  }

  const onSave = async () => {
    if (!writer) return
    setSaving(true)
    setError('')
    try {
      await saveSystem(writer, previous, input)
      Toast.show(l({message: 'System saved', context: 'toast'}))
    } catch (e) {
      setError(cleanError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={[a.gap_lg]} testID="pluralitySystem">
      <Text style={[a.text_lg, a.font_semi_bold]}>
        <Trans>Plural system</Trans>
      </Text>
      <LimitedField
        testID="systemNameInput"
        label={l`Name`}
        value={input.name}
        onChange={value => set('name', value)}
        max={64}
      />
      <LimitedField
        testID="systemDescriptionInput"
        label={l`Description`}
        value={input.description}
        onChange={value => set('description', value)}
        max={256}
        multiline
      />
      <LimitedField
        testID="systemCollectiveNounInput"
        label={l`Collective noun`}
        value={input.collectiveNoun}
        onChange={value => set('collectiveNoun', value)}
        max={32}
        placeholder={l`e.g. system, collective, flock`}
      />
      <LimitedField
        testID="systemMemberCountInput"
        label={l`Member count`}
        value={input.memberCount}
        onChange={value => set('memberCount', value)}
        max={16}
        placeholder={l`e.g. 12, 20+, many`}
      />
      {error ? <Admonition type="error">{error}</Admonition> : null}
      <View style={[a.flex_row]}>
        <Button
          testID="systemSaveButton"
          label={l`Save system`}
          onPress={() => void onSave()}
          disabled={!writer || !dirty || saving || !!problem}
          size="small"
          color="primary"
          hitSlop={HIT_44}>
          <ButtonText>
            <Trans>Save system</Trans>
          </ButtonText>
          {saving && <ButtonIcon icon={Loader} />}
        </Button>
      </View>
    </View>
  )
}
