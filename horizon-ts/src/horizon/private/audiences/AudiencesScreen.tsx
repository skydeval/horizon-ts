/*
 * Settings > Audiences: the account's audiences, standing ones first, then
 * its lists, with a read-only member list for each list.
 *
 * - New list (and the intro) only while the composer offers Private (2K
 *   design 4.7); otherwise the posting route's note (8.1).
 * - Edit (lists only) and Delete, with a confirmation, where the repo route
 *   writes them (`audienceEditAvailable`, PA-14): on any PDS other than
 *   locus, whatever the posting route; on locus once A-4 is live
 *   (`AUDIENCE_EDIT`).
 */

import {useState} from 'react'
import {View} from 'react-native'
import {type DidString} from '@atproto/syntax'
import {plural} from '@lingui/core/macro'
import {Trans, useLingui} from '@lingui/react/macro'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {
  type CommonNavigatorParams,
  type NativeStackScreenProps,
} from '#/lib/routes/types'
import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {useAppviewClient, usePdsClient, useSession} from '#/state/session'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {atoms as a, useTheme, web} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {Earth_Stroke2_Corner0_Rounded as EarthIcon} from '#/components/icons/Globe'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Pencil_Stroke2_Corner0_Rounded as PencilIcon} from '#/components/icons/Pencil'
import {
  Person_Stroke2_Corner0_Rounded as PersonIcon,
  PersonGroup_Stroke2_Corner2_Rounded as PersonGroupIcon,
} from '#/components/icons/Person'
import {PlusLarge_Stroke2_Corner0_Rounded as PlusIcon} from '#/components/icons/Plus'
import {Trash_Stroke2_Corner0_Rounded as TrashIcon} from '#/components/icons/Trash'
import * as Layout from '#/components/Layout'
import {Loader} from '#/components/Loader'
import * as ProfileCard from '#/components/ProfileCard'
import * as Prompt from '#/components/Prompt'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {
  audienceEditAvailable,
  type AudienceEntry,
  audienceLabel,
  deleteAudience,
  isEditableAudience,
  orderAudiences,
} from '#/horizon/private/api/audiences'
import {PrivateKryphocronHostError} from '#/horizon/private/api/writer'
import {AudienceEditorDialog} from '#/horizon/private/audiences/AudienceEditorDialog'
import {useAudiencesQuery} from '#/horizon/private/audiences/useAudiencesQuery'
import {privateRouteNote} from '#/horizon/private/composer/blockers'
import {useCanPostPrivately} from '#/horizon/private/membership'
import {getPrismClient} from '#/horizon/routing/prism'
import {app} from '#/lexicons'

const PROFILES_BATCH = 25

function iconFor(entry: AudienceEntry) {
  if (entry.mode === 'everyone') return EarthIcon
  if (entry.mode === 'nobody') return LockIcon
  if (entry.mode === 'list') return PersonGroupIcon
  return PersonIcon
}

type Props = NativeStackScreenProps<CommonNavigatorParams, 'AudiencesSettings'>
export function AudiencesSettingsScreen({}: Props) {
  const t = useTheme()
  const {t: l} = useLingui()
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const pdsClient = usePdsClient()
  const editorControl = Dialog.useDialogControl()
  const membersControl = Dialog.useDialogControl()
  const deleteControl = Prompt.usePromptControl()
  const [openList, setOpenList] = useState<AudienceEntry | undefined>()
  const [editing, setEditing] = useState<AudienceEntry | undefined>()
  const [deleting, setDeleting] = useState<AudienceEntry | undefined>()
  const {data: audiences, isLoading, isError, refetch} = useAudiencesQuery()
  const {standing, lists} = orderAudiences(audiences ?? [])
  const can = useCanPostPrivately()
  const editable = audienceEditAvailable(can.routes.repoRoute)
  const routeNote = can.offered ? undefined : privateRouteNote(can.routes)

  const openEditor = (entry: AudienceEntry | undefined) => {
    setEditing(entry)
    editorControl.open()
  }
  const askDelete = (entry: AudienceEntry) => {
    setDeleting(entry)
    deleteControl.open()
  }
  const onConfirmDelete = async () => {
    if (!currentAccount || !deleting) return
    try {
      await deleteAudience(
        queryClient,
        {
          did: currentAccount.did,
          pdsClient,
          prismClient: getPrismClient(pdsClient),
        },
        deleting.uri,
      )
    } catch (e) {
      if (!(e instanceof PrivateKryphocronHostError)) {
        logger.warn('deleting an audience failed', {
          message: e instanceof Error ? e.message : String(e),
        })
      }
      Toast.show(cleanError(e instanceof Error ? e.message : String(e)), {
        type: 'error',
      })
    }
  }

  /** Edit and Delete at a row's end, when the repo route writes them. */
  const rowActions = (entry: AudienceEntry) => {
    if (!editable) return null
    const label = audienceLabel(entry, {isSelf: true})
    return (
      <>
        {isEditableAudience(entry) ? (
          <Button
            testID="audienceEditButton"
            label={l`Edit ${label}`}
            size="small"
            color="secondary"
            shape="round"
            onPress={() => openEditor(entry)}>
            <ButtonIcon icon={PencilIcon} />
          </Button>
        ) : null}
        <Button
          testID="audienceDeleteButton"
          label={l`Delete ${label}`}
          size="small"
          color="secondary"
          shape="round"
          onPress={() => askDelete(entry)}>
          <ButtonIcon icon={TrashIcon} />
        </Button>
      </>
    )
  }

  return (
    <Layout.Screen>
      <Layout.Header.Outer>
        <Layout.Header.BackButton />
        <Layout.Header.Content>
          <Layout.Header.TitleText>
            <Trans>Audiences</Trans>
          </Layout.Header.TitleText>
        </Layout.Header.Content>
        <Layout.Header.Slot />
      </Layout.Header.Outer>
      <Layout.Content>
        <SettingsList.Container>
          <View style={[a.px_xl, a.pt_md, a.pb_sm, a.gap_md]}>
            {can.offered ? (
              <>
                <Text
                  style={[
                    a.text_sm,
                    a.leading_snug,
                    t.atoms.text_contrast_medium,
                  ]}>
                  <Trans>
                    Audiences decide who can see your private posts. Everyone,
                    Followers, People you follow and Only me are made the first
                    time you use them.
                  </Trans>
                </Text>
                <Button
                  testID="newAudienceListButton"
                  label={l`New list`}
                  color="primary"
                  size="small"
                  style={[a.self_start]}
                  onPress={() => openEditor(undefined)}>
                  <ButtonIcon icon={PlusIcon} />
                  <ButtonText>
                    <Trans>New list</Trans>
                  </ButtonText>
                </Button>
              </>
            ) : routeNote ? (
              <Text
                testID="audiencesRouteNote"
                style={[
                  a.text_sm,
                  a.leading_snug,
                  t.atoms.text_contrast_medium,
                ]}>
                {routeNote}
              </Text>
            ) : null}
          </View>

          {isLoading ? (
            <View style={[a.p_xl, a.align_center]}>
              <Loader size="xl" />
            </View>
          ) : isError ? (
            <View style={[a.px_xl, a.py_md, a.gap_sm]}>
              <Text style={[a.text_md]}>
                <Trans>Your audiences couldn’t be loaded.</Trans>
              </Text>
              <Button
                label={l`Try again`}
                size="small"
                color="secondary"
                style={[a.self_start]}
                onPress={() => void refetch()}>
                <ButtonText>
                  <Trans>Try again</Trans>
                </ButtonText>
              </Button>
            </View>
          ) : (
            <>
              {standing.map(entry => (
                <SettingsList.Item key={entry.uri}>
                  <SettingsList.ItemIcon icon={iconFor(entry)} />
                  <SettingsList.ItemText>
                    {audienceLabel(entry, {isSelf: true})}
                  </SettingsList.ItemText>
                  {rowActions(entry)}
                </SettingsList.Item>
              ))}
              {standing.length > 0 && lists.length > 0 ? (
                <SettingsList.Divider />
              ) : null}
              {lists.map(entry => {
                const label = audienceLabel(entry, {isSelf: true})
                const showMembers = () => {
                  setOpenList(entry)
                  membersControl.open()
                }
                const count = (
                  <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                    {plural(entry.members.length, {
                      one: '# person',
                      other: '# people',
                    })}
                  </Text>
                )
                if (!editable) {
                  return (
                    <SettingsList.PressableItem
                      key={entry.uri}
                      label={l`${label}, show who is on this list`}
                      onPress={showMembers}>
                      <SettingsList.ItemIcon icon={iconFor(entry)} />
                      <SettingsList.ItemText>{label}</SettingsList.ItemText>
                      {count}
                      <SettingsList.Chevron />
                    </SettingsList.PressableItem>
                  )
                }
                /*
                 * With row actions the row itself is not one button: the
                 * label part shows the members, beside Edit and Delete.
                 */
                return (
                  <SettingsList.Item key={entry.uri}>
                    <Button
                      label={l`${label}, show who is on this list`}
                      style={[a.flex_1, a.justify_start, a.gap_sm]}
                      onPress={showMembers}>
                      <SettingsList.ItemIcon icon={iconFor(entry)} />
                      <SettingsList.ItemText>{label}</SettingsList.ItemText>
                      {count}
                    </Button>
                    {rowActions(entry)}
                  </SettingsList.Item>
                )
              })}
              {standing.length === 0 && lists.length === 0 ? (
                <View style={[a.px_xl, a.py_md]}>
                  <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                    <Trans>You haven’t used any audiences yet.</Trans>
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </SettingsList.Container>
      </Layout.Content>
      <AudienceEditorDialog control={editorControl} editing={editing} />
      <AudienceMembersDialog control={membersControl} entry={openList} />
      <Prompt.Basic
        control={deleteControl}
        title={l`Delete ${deleting ? audienceLabel(deleting, {isSelf: true}) : ''}?`}
        description={l`Private posts shared with this audience will be visible only to you. This can’t be undone.`}
        confirmButtonCta={l`Delete`}
        confirmButtonColor="negative"
        onConfirm={() => void onConfirmDelete()}
      />
    </Layout.Screen>
  )
}

function AudienceMembersDialog({
  control,
  entry,
}: {
  control: Dialog.DialogControlProps
  entry: AudienceEntry | undefined
}) {
  return (
    <Dialog.Outer control={control}>
      <Dialog.Handle />
      {entry ? <MembersInner entry={entry} /> : null}
    </Dialog.Outer>
  )
}

function MembersInner({entry}: {entry: AudienceEntry}) {
  const t = useTheme()
  const appviewClient = useAppviewClient()
  const moderationOpts = useModerationOpts()
  const label = audienceLabel(entry, {isSelf: true})
  const {data: profiles, isLoading} = useQuery({
    queryKey: ['horizon-audience-members', entry.uri, entry.members],
    queryFn: async () => {
      const batches: DidString[][] = []
      for (let i = 0; i < entry.members.length; i += PROFILES_BATCH) {
        batches.push(entry.members.slice(i, i + PROFILES_BATCH) as DidString[])
      }
      const pages = await Promise.all(
        batches.map(actors =>
          appviewClient.call(app.bsky.actor.getProfiles, {actors}),
        ),
      )
      return pages.flatMap(page => page.profiles)
    },
    enabled: entry.members.length > 0,
  })

  return (
    <Dialog.ScrollableInner label={label} style={web({maxWidth: 420})}>
      <View style={[a.gap_md]}>
        <Text style={[a.text_xl, a.font_bold]}>{label}</Text>
        <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
          <Trans>Anyone can see who is on this list.</Trans>
        </Text>
        {entry.members.length === 0 ? (
          <Text style={[a.text_sm]}>
            <Trans>No one is on this list.</Trans>
          </Text>
        ) : isLoading || !moderationOpts ? (
          <Loader size="lg" />
        ) : (
          (profiles ?? []).map(profile => (
            <ProfileCard.Header key={profile.did}>
              <ProfileCard.Avatar
                profile={profile}
                moderationOpts={moderationOpts}
                disabledPreview
              />
              <View style={[a.flex_1]}>
                <ProfileCard.Name
                  profile={profile}
                  moderationOpts={moderationOpts}
                />
                <ProfileCard.Handle profile={profile} />
              </View>
            </ProfileCard.Header>
          ))
        )}
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}
