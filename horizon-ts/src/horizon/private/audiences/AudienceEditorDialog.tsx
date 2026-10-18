/*
 * Creating a list: a name and the people on it. `kind: 'audience'` makes a
 * list audience (the Audiences screen's New list, and New audience... under
 * Who can see); `kind: 'replyList'` makes a Bluesky curate list for reply
 * rules (New reply list... under Who can reply, 5.5). Both are public lists.
 *
 * The member picker is the stock `SearchablePeopleList`, shown as a second
 * step of the same dialog. That list closes its dialog from its own header
 * through the dialog context; here the context's `close` returns to the first
 * step instead, so the picker never closes the editor.
 */

import {useContext, useState} from 'react'
import {View} from 'react-native'
import {type ModerationOpts} from '@bsky/sdk/moderation'
import {Trans, useLingui} from '@lingui/react/macro'
import {useQueryClient} from '@tanstack/react-query'

import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {usePdsClient, useSession} from '#/state/session'
import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {Context as DialogContext} from '#/components/Dialog/context'
import {
  type ProfileItem,
  SearchablePeopleList,
} from '#/components/dialogs/SearchablePeopleList'
import * as TextField from '#/components/forms/TextField'
import {PlusLarge_Stroke2_Corner0_Rounded as PlusIcon} from '#/components/icons/Plus'
import {TimesLarge_Stroke2_Corner0_Rounded as XIcon} from '#/components/icons/Times'
import {Loader} from '#/components/Loader'
import * as ProfileCard from '#/components/ProfileCard'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {createListAudience} from '#/horizon/private/api/audiences'
import {
  createReplyList,
  ReplyListPartlyCreatedError,
} from '#/horizon/private/api/reply-lists'
import {getPrismClient} from '#/horizon/routing/prism'
import type * as bsky from '#/types/bsky'

type Member = bsky.profile.AnyProfileView

/**
 * What the editor creates.
 */
export type ListEditorKind = 'audience' | 'replyList'

/**
 * The editor dialog. `onCreated` runs after the dialog has closed, with the
 * new list's URI and name.
 */
export function AudienceEditorDialog({
  control,
  onCreated,
  kind = 'audience',
}: {
  control: Dialog.DialogControlProps
  onCreated?: (uri: string, name: string) => void
  kind?: ListEditorKind
}) {
  return (
    <Dialog.Outer control={control} nativeOptions={{fullHeight: true}}>
      <Dialog.Handle />
      <EditorInner control={control} onCreated={onCreated} kind={kind} />
    </Dialog.Outer>
  )
}

function EditorInner({
  control,
  onCreated,
  kind,
}: {
  control: Dialog.DialogControlProps
  onCreated?: (uri: string, name: string) => void
  kind: ListEditorKind
}) {
  const [step, setStep] = useState<'details' | 'people'>('details')
  const [name, setName] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const dialogContext = useContext(DialogContext)
  const moderationOpts = useModerationOpts()

  const toggleMember = (profile: Member) => {
    setMembers(current =>
      current.some(member => member.did === profile.did)
        ? current.filter(member => member.did !== profile.did)
        : [...current, profile],
    )
  }

  if (step === 'people') {
    return (
      <DialogContext.Provider
        value={{
          ...dialogContext,
          close: callback => {
            setStep('details')
            callback?.()
          },
        }}>
        <PeoplePicker
          members={members}
          moderationOpts={moderationOpts}
          onToggle={toggleMember}
        />
      </DialogContext.Provider>
    )
  }

  return (
    <DetailsStep
      control={control}
      name={name}
      onChangeName={setName}
      members={members}
      onRemoveMember={toggleMember}
      onAddPeople={() => setStep('people')}
      moderationOpts={moderationOpts}
      onCreated={onCreated}
      kind={kind}
    />
  )
}

function PeoplePicker({
  members,
  moderationOpts,
  onToggle,
}: {
  members: Member[]
  moderationOpts: ModerationOpts | undefined
  onToggle: (profile: Member) => void
}) {
  const {t: l} = useLingui()
  const renderProfileCard = (item: ProfileItem) => {
    const isMember = members.some(member => member.did === item.profile.did)
    if (!moderationOpts) return null
    return (
      <View style={[a.flex_1, a.py_sm, a.px_lg]}>
        <ProfileCard.Header>
          <ProfileCard.Avatar
            profile={item.profile}
            moderationOpts={moderationOpts}
            disabledPreview
          />
          <View style={[a.flex_1]}>
            <ProfileCard.Name
              profile={item.profile}
              moderationOpts={moderationOpts}
            />
            <ProfileCard.Handle profile={item.profile} />
          </View>
          <Button
            label={isMember ? l`Remove from this list` : l`Add to this list`}
            onPress={() => onToggle(item.profile)}
            size="small"
            color={isMember ? 'secondary' : 'primary'}>
            <ButtonText>
              {isMember ? <Trans>Remove</Trans> : <Trans>Add</Trans>}
            </ButtonText>
          </Button>
        </ProfileCard.Header>
      </View>
    )
  }
  return (
    <SearchablePeopleList
      title={l`Add people`}
      renderProfileCard={renderProfileCard}
    />
  )
}

function DetailsStep({
  control,
  name,
  onChangeName,
  members,
  onRemoveMember,
  onAddPeople,
  moderationOpts,
  onCreated,
  kind,
}: {
  control: Dialog.DialogControlProps
  name: string
  onChangeName: (name: string) => void
  members: Member[]
  onRemoveMember: (profile: Member) => void
  onAddPeople: () => void
  moderationOpts: ModerationOpts | undefined
  onCreated?: (uri: string, name: string) => void
  kind: ListEditorKind
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const pdsClient = usePdsClient()
  const [error, setError] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const onCreate = async () => {
    if (!currentAccount) return
    if (!name.trim()) {
      setError(l`Give the list a name.`)
      return
    }
    setError('')
    setIsCreating(true)
    const memberDids = members.map(member => member.did)
    const listName = name.trim()
    try {
      const uri =
        kind === 'replyList'
          ? await createReplyList(
              queryClient,
              {did: currentAccount.did, pdsClient},
              {name, members: memberDids},
            )
          : await createListAudience(
              queryClient,
              {
                did: currentAccount.did,
                pdsClient,
                prismClient: getPrismClient(pdsClient),
              },
              {name, members: memberDids},
            )
      control.close(() => onCreated?.(uri, listName))
    } catch (e) {
      if (e instanceof ReplyListPartlyCreatedError) {
        const message = e.message
        control.close(() => {
          onCreated?.(e.uri, listName)
          Toast.show(message, {type: 'warning'})
        })
        return
      }
      logger.warn('creating a list failed', {
        kind,
        message: e instanceof Error ? e.message : String(e),
      })
      setError(cleanError(e instanceof Error ? e.message : String(e)))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog.ScrollableInner label={l`New list`} style={web({maxWidth: 480})}>
      <View style={[a.gap_lg]}>
        <Text style={[a.text_2xl, a.font_bold]}>
          <Trans>New list</Trans>
        </Text>
        <View>
          <TextField.LabelText>
            <Trans>Name</Trans>
          </TextField.LabelText>
          <TextField.Root isInvalid={!!error && !name.trim()}>
            <Dialog.Input
              testID="audienceNameInput"
              label={l`List name`}
              placeholder={l`Close friends`}
              value={name}
              maxLength={64}
              onChangeText={value => {
                onChangeName(value)
                if (error) setError('')
              }}
            />
          </TextField.Root>
        </View>

        <View style={[a.gap_sm]}>
          <Text style={[a.text_md, a.font_semi_bold]}>
            <Trans>People</Trans>
          </Text>
          {members.length === 0 ? (
            <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
              {kind === 'replyList' ? (
                <Trans>No one yet.</Trans>
              ) : (
                <Trans>No one yet. You always see your own posts.</Trans>
              )}
            </Text>
          ) : (
            members.map(member => (
              <View
                key={member.did}
                style={[a.flex_row, a.align_center, a.gap_sm]}>
                {moderationOpts ? (
                  <ProfileCard.Avatar
                    profile={member}
                    moderationOpts={moderationOpts}
                    disabledPreview
                    size={32}
                  />
                ) : null}
                <Text style={[a.flex_1, a.text_sm]} numberOfLines={1} emoji>
                  {member.displayName || `@${member.handle}`}
                </Text>
                <Button
                  label={l`Remove ${member.handle} from this list`}
                  onPress={() => onRemoveMember(member)}
                  size="small"
                  color="secondary"
                  shape="round">
                  <ButtonIcon icon={XIcon} />
                </Button>
              </View>
            ))
          )}
          <Button
            testID="audienceAddPeopleButton"
            label={l`Add people`}
            onPress={onAddPeople}
            size="small"
            color="secondary">
            <ButtonIcon icon={PlusIcon} />
            <ButtonText>
              <Trans>Add people</Trans>
            </ButtonText>
          </Button>
          <Text
            style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
            <Trans>Anyone can see who is on this list.</Trans>
          </Text>
        </View>

        {error ? <Admonition type="error">{error}</Admonition> : null}

        <Button
          testID="audienceCreateButton"
          label={l`Create list`}
          color="primary"
          size="large"
          disabled={isCreating}
          onPress={() => void onCreate()}>
          <ButtonText>
            <Trans>Create</Trans>
          </ButtonText>
          {isCreating && <ButtonIcon icon={Loader} />}
        </Button>
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}
