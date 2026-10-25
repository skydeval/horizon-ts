/*
 * The composer's "Posting as" control (Phase 5 design 8.1, PP-4, B-15): the
 * avatar beside the first post's text field becomes its trigger, showing
 * the posting account's avatar (or the single chosen member's) with a small
 * chevron. Its menu has up to two groups:
 *
 * - **Accounts** (radio), when the current account has system accounts
 *   (system accounts design 8.1, S-1): the current account, then its
 *   registered system accounts that are ready on this device, each labelled
 *   "@x" in the "Post from" group; never other switcher accounts. Picking
 *   one runs the reset (`gates.ts`). While a video is attached the group is
 *   disabled: the video was uploaded as the current account (8.5). Listed
 *   accounts that need a sign-in here follow as plain items ("Sign in as
 *   @lala on this device", "Sign in again as @lala"), which open the
 *   re-verify sign-in over the composer (8.2), then "Manage system
 *   accounts...", which opens Edit Profile on the Plurality tab (4.1).
 * - **Members of @account** (checkboxes), when the posting account has a
 *   system: zero to 20, none meaning "post as the account". Held, with its
 *   spinner, until the posting account's reads have applied (P5R4-L1).
 *   "Edit front..." for the current account.
 *
 * Absent (the stock avatar) with one account and no system, and with
 * `POSTING_AS` off.
 */

// Registers the toast for refused choices.
import './toasts'

import {useEffect, useState} from 'react'
import {ActivityIndicator, StyleSheet, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {sanitizeHandle} from '#/lib/strings/handles'
import {useProfileQuery} from '#/state/queries/profile'
import {useSession} from '#/state/session'
import {UserAvatar} from '#/view/com/util/UserAvatar'
import {EditProfileDialog} from '#/screens/Profile/Header/EditProfileDialog'
import {atoms as a, useTheme} from '#/alf'
import {Button} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {TinyChevronBottom_Stroke2_Corner0_Rounded as TinyChevronIcon} from '#/components/icons/Chevron'
import * as Menu from '#/components/Menu'
import {Text} from '#/components/Typography'
import {FrontSwitcherDialog} from '#/horizon/identity/edit/FrontSwitcherDialog'
import {formatMemberLabel, formatSets} from '#/horizon/identity/format'
import {MemberSwatch} from '#/horizon/identity/FronterName'
import {MAX_FRONTERS} from '#/horizon/identity/fronters'
import {usePluralProfile} from '#/horizon/identity/hooks'
import {memberImageUrl} from '#/horizon/identity/images'
import {type ListedMember} from '#/horizon/identity/reads'
import {MenuCheck} from '#/horizon/private/composer/AudienceMenu'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {PLURAL_EDITING, POSTING_AS, SYSTEM_ACCOUNTS} from '#/horizon/switches'
import {AddSystemAccountDialog} from '#/horizon/system-accounts/AddSystemAccountDialog'
import {holdAnnouncements} from '#/horizon/system-accounts/announce'
import {
  type SystemAccountRow,
  useSystemAccountRows,
} from '#/horizon/system-accounts/hooks'
import {readList} from '#/horizon/system-accounts/sync'
import {requestSystemAccountsFocus} from '#/horizon/system-accounts/SystemAccountsSection'
import {isPostingAsOther, usePostingState} from './compose-store'
import {PUBLIC_FRONTERS_KEPT} from './fronters'
import {
  choosePostingAccount,
  onPostingReverifyRequested,
  togglePostingMember,
} from './gates'

/** Whether the members group is offered at all (section 10). */
function membersOffered(): boolean {
  return PLURAL_EDITING && PUBLIC_FRONTERS_KEPT
}

/**
 * Hook PA-1: in place of the composer's avatar. `children` is the stock
 * avatar, rendered as it is wherever the control has nothing to offer.
 */
export function PostingAsControl({
  isFirstPost,
  children,
}: {
  isFirstPost: boolean
  children: React.ReactNode
}) {
  const s = usePostingState()
  const {accounts} = useSession()
  // The current account's system accounts (8.1), never other switcher ones.
  const rows = useSystemAccountRows(s.currentDid, accounts)
  const multiple = rows.length > 0
  const isSystem = membersOffered() && !!s.data?.isSystem
  // Composer open: the list is read in the background when stale (5.5).
  const currentDid = s.currentDid
  useEffect(() => {
    if (!SYSTEM_ACCOUNTS || !currentDid) return
    const clients = getCurrentClients()
    if (clients?.did === currentDid)
      void readList(currentDid, clients.pdsClient)
  }, [currentDid])
  if (!POSTING_AS || !s.active || !s.did) return <>{children}</>
  if (!multiple && !isSystem && !isPostingAsOther(s)) return <>{children}</>
  if (!isFirstPost) return <PostingAvatar />
  return <PostingMenu rows={rows} multiple={multiple} />
}

/** The posting account's avatar, or its single chosen member's. */
function PostingAvatar({inTrigger = false}: {inTrigger?: boolean}) {
  const s = usePostingState()
  const {data: profile} = useProfileQuery({did: s.did})
  const single =
    s.members.length === 1
      ? s.data?.members.find(member => member.rkey === s.members[0])
      : undefined
  const avatar =
    single?.value.avatar && s.did
      ? memberImageUrl(s.did, single.value.avatar, 'avatar_thumbnail')
      : profile?.avatar
  return (
    <UserAvatar
      avatar={avatar}
      size={42}
      type={profile?.associated?.labeler ? 'labeler' : 'user'}
      // In the trigger the slot carries the stock top margin.
      style={inTrigger ? undefined : [a.mt_xs]}
    />
  )
}

function PostingMenu({
  rows,
  multiple,
}: {
  rows: SystemAccountRow[]
  multiple: boolean
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const s = usePostingState()
  const frontControl = Dialog.useDialogControl()
  const menuControl = Menu.useMenuControl()
  const reverifyControl = Dialog.useDialogControl()
  const editControl = Dialog.useDialogControl()
  const [reverify, setReverify] = useState<SystemAccountRow>()
  const {data: currentProfile} = useProfileQuery({
    did: SYSTEM_ACCOUNTS ? s.currentDid : undefined,
  })
  const accounts = [
    ...(s.currentDid
      ? [{did: s.currentDid, handle: s.currentHandle ?? s.currentDid}]
      : []),
    ...rows
      .filter(row => row.state === 'ready')
      .map(row => ({did: row.did, handle: row.handle ?? row.did})),
  ]
  const needSignIn = rows.filter(
    row => row.state === 'signIn' || row.state === 'signInAgain',
  )

  // Announcements wait while the menu's modal hides the page (4.6).
  const menuOpen = menuControl.isOpen
  useEffect(() => {
    if (!menuOpen) return
    return holdAnnouncements()
  }, [menuOpen])

  // A choice or a draft that needs a sign-in opens it here (8.2, 6.4).
  useEffect(
    () =>
      onPostingReverifyRequested(did => {
        const row = rows.find(r => r.did === did)
        if (!row) return false
        setReverify(row)
        reverifyControl.open()
        return true
      }),
    [rows, reverifyControl],
  )
  // Cached answers, drawn greyed under the spinner until the reads apply.
  const cached = usePluralProfile(membersOffered() ? s.did : undefined, {
    mode: 'post',
  })
  const handle = s.handle ? sanitizeHandle(s.handle) : ''
  const held = s.resetPending || s.hold.kind !== 'none' || !!s.heldMembers
  const isSystem =
    membersOffered() && (s.data ? s.data.isSystem : held && cached.isSystem)
  const shownMembers = s.data?.members ?? cached.members?.members ?? []
  const atCap = s.members.length >= MAX_FRONTERS
  const isCurrent = !isPostingAsOther(s)

  const label = l`Posting as @${handle}, change account or members`

  return (
    /*
     * The slot is the stock avatar's exact footprint (42x42 below `mt_xs`),
     * so the text input beside it keeps its place. The 44x44 trigger is laid
     * over it and the chevron is a badge on the avatar's corner, neither
     * taking room in the row.
     */
    <View testID="composerPostingAsSlot" style={[a.mt_xs, styles.slot]}>
      <Menu.Root control={menuControl}>
        <Menu.Trigger label={label}>
          {({props, state}) => (
            <Button
              {...props}
              testID="composerPostingAsButton"
              label={label}
              accessibilityHint={l`Opens a menu to choose who this post is from`}
              style={[a.rounded_full, a.bg_transparent, styles.target]}>
              <PostingAvatar inTrigger />
              <View
                testID="composerPostingAsChevron"
                pointerEvents="none"
                style={[
                  a.align_center,
                  a.justify_center,
                  a.rounded_full,
                  a.border,
                  t.atoms.bg,
                  t.atoms.border_contrast_low,
                  styles.badge,
                ]}>
                <TinyChevronIcon
                  size="xs"
                  style={[t.atoms.text_contrast_medium]}
                />
              </View>
              {state.focused ? (
                <View
                  pointerEvents="none"
                  style={[
                    a.rounded_full,
                    styles.ring,
                    {borderColor: t.palette.primary_500},
                  ]}
                />
              ) : null}
            </Button>
          )}
        </Menu.Trigger>
        <Menu.Outer style={[{minWidth: 260, maxWidth: 360}]}>
          {/*
           * The accounts are a radio group and the members a checkbox group,
           * so a screen reader hears which are chosen (SAR2-L5). Each also
           * shows a mark, never colour alone. Labels sit outside the groups:
           * a native group renders only its items.
           */}
          {multiple ? (
            <>
              <Menu.LabelText>
                <Trans>Post from</Trans>
              </Menu.LabelText>
              {s.hasVideo ? (
                <Menu.LabelText>
                  <Trans>Remove the video to post from another account</Trans>
                </Menu.LabelText>
              ) : null}
              <Menu.RadioGroup label={l`Post from`} value={s.did}>
                {accounts.map(account => {
                  const name = sanitizeHandle(account.handle)
                  return (
                    <Menu.RadioItem
                      key={account.did}
                      value={account.did}
                      testID={`composerPostingAs-${account.handle}`}
                      // The group says "Post from" (SA-H11, SAR3-N11).
                      label={`@${name}`}
                      disabled={s.hasVideo && account.did !== s.currentDid}
                      onPress={() => choosePostingAccount(account.did)}>
                      <Menu.ItemText>{`@${name}`}</Menu.ItemText>
                      <Menu.ItemRadio selected={account.did === s.did} />
                    </Menu.RadioItem>
                  )
                })}
              </Menu.RadioGroup>
              {needSignIn.length > 0 ? (
                <Menu.Group>
                  {needSignIn.map(row => {
                    const name = row.handle
                      ? `@${sanitizeHandle(row.handle)}`
                      : row.did
                    const label =
                      row.state === 'signInAgain'
                        ? l`Sign in again as ${name}`
                        : l`Sign in as ${name} on this device`
                    return (
                      <Menu.Item
                        key={row.did}
                        testID={`composerPostingAsSignIn-${row.did}`}
                        label={label}
                        accessibilityHint={l`Opens your server’s sign-in`}
                        onPress={() => {
                          setReverify(row)
                          reverifyControl.open()
                        }}>
                        <Menu.ItemText>{label}</Menu.ItemText>
                      </Menu.Item>
                    )
                  })}
                </Menu.Group>
              ) : null}
            </>
          ) : null}
          {isSystem ? (
            <>
              {multiple ? <Menu.Divider /> : null}
              <Menu.LabelText>
                <Trans>Members of @{handle}</Trans>
              </Menu.LabelText>
              {held ? (
                <View
                  testID="composerPostingAsMembersHeld"
                  style={[a.flex_row, a.align_center, a.gap_sm, a.px_md]}>
                  <ActivityIndicator size="small" />
                </View>
              ) : null}
              {shownMembers.length > 0 ? (
                <Menu.CheckboxGroup label={l`Members of @${handle}`}>
                  {shownMembers.map(member => {
                    const selected = s.members.includes(member.rkey)
                    return (
                      <Menu.CheckboxItem
                        key={member.rkey}
                        checked={selected}
                        testID={`composerPostingAsMember-${member.rkey}`}
                        label={l`Post as ${formatMemberLabel(member.value)}`}
                        disabled={held || (atCap && !selected)}
                        onPress={() => togglePostingMember(member.rkey)}>
                        <MemberItemContent member={member} />
                        <MenuCheck selected={selected} />
                      </Menu.CheckboxItem>
                    )
                  })}
                </Menu.CheckboxGroup>
              ) : null}
              {atCap ? (
                <Menu.LabelText>
                  <Trans>Up to 20 members</Trans>
                </Menu.LabelText>
              ) : null}
              {isCurrent && PLURAL_EDITING ? (
                <Menu.Group>
                  <Menu.Item
                    testID="composerPostingAsEditFront"
                    label={l`Edit front…`}
                    onPress={() => frontControl.open()}>
                    <Menu.ItemText>
                      <Trans>Edit front…</Trans>
                    </Menu.ItemText>
                  </Menu.Item>
                </Menu.Group>
              ) : null}
            </>
          ) : null}
          {SYSTEM_ACCOUNTS && s.currentDid && currentProfile ? (
            <>
              <Menu.Divider />
              <Menu.Group>
                <Menu.Item
                  testID="composerPostingAsManage"
                  label={l`Manage system accounts…`}
                  onPress={() => {
                    requestSystemAccountsFocus()
                    editControl.open()
                  }}>
                  <Menu.ItemText>
                    <Trans>Manage system accounts…</Trans>
                  </Menu.ItemText>
                </Menu.Item>
              </Menu.Group>
            </>
          ) : null}
        </Menu.Outer>
      </Menu.Root>
      {isCurrent && s.currentDid && PLURAL_EDITING ? (
        <FrontSwitcherDialog control={frontControl} did={s.currentDid} />
      ) : null}
      {reverify && s.currentDid ? (
        <AddSystemAccountDialog
          control={reverifyControl}
          registrar={s.currentDid}
          reverify={{did: reverify.did, handle: reverify.handle}}
          // On success the account becomes a radio item and is chosen (8.2).
          onDone={did => choosePostingAccount(did)}
        />
      ) : null}
      {SYSTEM_ACCOUNTS && currentProfile ? (
        <EditProfileDialog
          profile={currentProfile}
          control={editControl}
          initialTab="plurality"
        />
      ) : null}
    </View>
  )
}

const AVATAR = 42
const TARGET = 44

const styles = StyleSheet.create({
  slot: {
    position: 'relative',
    flexShrink: 0,
    width: AVATAR,
    height: AVATAR,
  },
  /** Centred on the avatar, one point past each edge, out of the flow. */
  target: {
    position: 'absolute',
    top: (AVATAR - TARGET) / 2,
    left: (AVATAR - TARGET) / 2,
    width: TARGET,
    height: TARGET,
    padding: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  badge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 16,
    height: 16,
  },
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2,
  },
})

/**
 * A member row's swatch, name and pronouns. The `CheckboxItem` stays a direct
 * child of its group, which a native group needs to render it.
 */
function MemberItemContent({member}: {member: ListedMember}) {
  const t = useTheme()
  const pronouns = formatSets(member.value.pronouns)
  return (
    <View style={[a.flex_1, a.flex_row, a.align_center, a.gap_xs]}>
      <MemberSwatch color={member.value.color} size={8} />
      <View style={[a.flex_1]}>
        <Menu.ItemText>{formatMemberLabel(member.value)}</Menu.ItemText>
        {pronouns ? (
          <Text
            emoji
            style={[a.text_xs, a.leading_snug, t.atoms.text_contrast_medium]}>
            {pronouns}
          </Text>
        ) : null}
      </View>
    </View>
  )
}
