/*
 * Creating a list: a name and the people on it. `kind: 'audience'` makes a
 * list audience (the Audiences screen's New list, and New audience... under
 * Who can see); `kind: 'replyList'` makes a Bluesky curate list for reply
 * rules (New reply list... under Who can reply, 5.5). A reply list is a
 * public Bluesky list; an audience is private once prism holds audiences
 * (`private.audiences`), and public in the repo until then.
 * With `editing`, the same dialog edits a list audience (2K design 4.7):
 * "Edit list", its name and people filled in, and Save, swapping on the CID
 * it was listed with.
 *
 * The member picker is the stock `SearchablePeopleList`, shown as a second
 * step of the same dialog. That list closes its dialog from its own header
 * through the dialog context; here the context's `close` returns to the first
 * step instead, so the picker never closes the editor.
 */

import {useContext, useEffect, useState} from 'react'
import {View} from 'react-native'
import {type Client} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {type ModerationOpts} from '@bsky/sdk/moderation'
import {Trans, useLingui} from '@lingui/react/macro'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {useAppviewClient, usePdsClient, useSession} from '#/state/session'
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
import {
  AudienceChangedError,
  type AudienceEntry,
  createListAudience,
  updateListAudience,
} from '#/horizon/private/api/audiences'
import {
  createReplyList,
  ReplyListPartlyCreatedError,
} from '#/horizon/private/api/reply-lists'
import {PrivateKryphocronHostError} from '#/horizon/private/api/writer'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {getPrismClient} from '#/horizon/routing/prism'
import {app} from '#/lexicons'
import type * as bsky from '#/types/bsky'

type Member = bsky.profile.AnyProfileView

const PROFILES_BATCH = 25

/**
 * A list member before their profile has loaded: the DID stands in for the
 * handle, so a member whose profile cannot be read is still kept on Save.
 */
function placeholderMember(did: string): Member {
  return {did, handle: did} as Member
}

/**
 * What the editor creates.
 */
export type ListEditorKind = 'audience' | 'replyList'

/**
 * The editor dialog. `onCreated` runs after the dialog has closed, with the
 * new list's URI and name (not called for an edit).
 */
/**
 * The account a list is created in, when it is not the current account (the
 * composer's posting account, Phase 5 PA-14).
 */
export type EditorAccount = {did: string; pdsClient: Client}

export function AudienceEditorDialog({
  control,
  onCreated,
  kind = 'audience',
  editing,
  account,
}: {
  control: Dialog.DialogControlProps
  onCreated?: (uri: string, name: string) => void
  kind?: ListEditorKind
  /** A list audience to edit instead of creating one. */
  editing?: AudienceEntry
  /** Create in this account's repo, through its client. */
  account?: EditorAccount
}) {
  return (
    <Dialog.Outer control={control} nativeOptions={{fullHeight: true}}>
      <Dialog.Handle />
      <EditorInner
        key={editing?.uri ?? 'new'}
        control={control}
        onCreated={onCreated}
        kind={kind}
        editing={editing}
        account={account}
      />
    </Dialog.Outer>
  )
}

function EditorInner({
  control,
  onCreated,
  kind,
  editing,
  account,
}: {
  control: Dialog.DialogControlProps
  onCreated?: (uri: string, name: string) => void
  kind: ListEditorKind
  editing: AudienceEntry | undefined
  account: EditorAccount | undefined
}) {
  const appviewClient = useAppviewClient()
  const [step, setStep] = useState<'details' | 'people'>('details')
  const [name, setName] = useState(editing?.name ?? '')
  const [members, setMembers] = useState<Member[]>(() =>
    (editing?.members ?? []).map(placeholderMember),
  )
  const dialogContext = useContext(DialogContext)
  const moderationOpts = useModerationOpts()

  // An edited list's people, filled in as their profiles arrive.
  const editedDids = editing?.members ?? []
  const {data: profiles} = useQuery({
    queryKey: ['horizon-audience-members', editing?.uri, editedDids],
    queryFn: async () => {
      const batches: DidString[][] = []
      for (let i = 0; i < editedDids.length; i += PROFILES_BATCH) {
        batches.push(editedDids.slice(i, i + PROFILES_BATCH) as DidString[])
      }
      const pages = await Promise.all(
        batches.map(actors =>
          appviewClient.call(app.bsky.actor.getProfiles, {actors}),
        ),
      )
      return pages.flatMap(page => page.profiles)
    },
    enabled: editedDids.length > 0,
  })
  useEffect(() => {
    if (!profiles) return
    const byDid = new Map<string, Member>(
      profiles.map(profile => [profile.did, profile]),
    )
    setMembers(current =>
      current.map(member => byDid.get(member.did) ?? member),
    )
  }, [profiles])

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
      editing={editing}
      account={account}
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
  editing,
  account,
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
  editing: AudienceEntry | undefined
  account: EditorAccount | undefined
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const currentClient = usePdsClient()
  const [error, setError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  /*
   * Read for the current account: prism switches every member at once, so
   * it holds for a posting account too.
   */
  const onPrism = usePrismFeature('private.audiences')
  // The posting account's repo when one is given (Phase 5 PA-14).
  const did = account ? account.did : currentAccount?.did
  const pdsClient = account ? account.pdsClient : currentClient

  const onCreate = async () => {
    if (!did) return
    if (!name.trim()) {
      setError(l`Give the list a name.`)
      return
    }
    setError('')
    setIsCreating(true)
    const memberDids = members.map(member => member.did)
    const listName = name.trim()
    const clients = {
      did,
      pdsClient,
      prismClient: getPrismClient(pdsClient),
    }
    if (editing) {
      try {
        await updateListAudience(queryClient, clients, {
          entry: editing,
          name,
          members: memberDids,
        })
        control.close()
      } catch (e) {
        if (
          e instanceof AudienceChangedError ||
          e instanceof PrivateKryphocronHostError
        ) {
          setError(e.message)
        } else {
          logger.warn('editing a list failed', {
            message: e instanceof Error ? e.message : String(e),
          })
          setError(cleanError(e instanceof Error ? e.message : String(e)))
        }
      } finally {
        setIsCreating(false)
      }
      return
    }
    try {
      const uri =
        kind === 'replyList'
          ? await createReplyList(
              queryClient,
              {did, pdsClient},
              {name, members: memberDids},
            )
          : await createListAudience(queryClient, clients, {
              name,
              members: memberDids,
            })
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
    <Dialog.ScrollableInner
      label={editing ? l`Edit list` : l`New list`}
      style={web({maxWidth: 480})}>
      <View style={[a.gap_lg]}>
        <Text style={[a.text_2xl, a.font_bold]}>
          {editing ? <Trans>Edit list</Trans> : <Trans>New list</Trans>}
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
            {kind === 'audience' && onPrism ? (
              <Trans>Only you can see who is on this list.</Trans>
            ) : (
              <Trans>Anyone can see who is on this list.</Trans>
            )}
          </Text>
        </View>

        {error ? <Admonition type="error">{error}</Admonition> : null}

        <Button
          testID={editing ? 'audienceSaveButton' : 'audienceCreateButton'}
          label={editing ? l`Save list` : l`Create list`}
          color="primary"
          size="large"
          disabled={isCreating}
          onPress={() => void onCreate()}>
          <ButtonText>
            {editing ? <Trans>Save</Trans> : <Trans>Create</Trans>}
          </ButtonText>
          {isCreating && <ButtonIcon icon={Loader} />}
        </Button>
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}
