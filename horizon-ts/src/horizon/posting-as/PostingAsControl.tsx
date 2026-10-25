/*
 * The composer's "Posting as" control (Phase 5 design 8.1, PP-4, B-15): the
 * avatar beside the first post's text field becomes its trigger, showing
 * the posting account's avatar (or the single chosen member's) with a small
 * chevron. Its menu has up to two groups:
 *
 * - **Accounts** (radio), when more than one stored account can act. Picking
 *   one runs the reset (`gates.ts`). While a video is attached the group is
 *   disabled: the video was uploaded as the current account (8.5).
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

import {ActivityIndicator, StyleSheet, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {sanitizeHandle} from '#/lib/strings/handles'
import {useProfileQuery} from '#/state/queries/profile'
import {useSession} from '#/state/session'
import {UserAvatar} from '#/view/com/util/UserAvatar'
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
import {PLURAL_EDITING, POSTING_AS} from '#/horizon/switches'
import {isPostingAsOther, usePostingState} from './compose-store'
import {PUBLIC_FRONTERS_KEPT} from './fronters'
import {choosePostingAccount, togglePostingMember} from './gates'
import {canActAs} from './temp-client'

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
  const actable = accounts.filter(canActAs)
  const multiple = actable.length > 1
  const isSystem = membersOffered() && !!s.data?.isSystem
  if (!POSTING_AS || !s.active || !s.did) return <>{children}</>
  if (!multiple && !isSystem && !isPostingAsOther(s)) return <>{children}</>
  if (!isFirstPost) return <PostingAvatar />
  return <PostingMenu accounts={actable} multiple={multiple} />
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
  accounts,
  multiple,
}: {
  accounts: {did: string; handle: string}[]
  multiple: boolean
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const s = usePostingState()
  const frontControl = Dialog.useDialogControl()
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
      <Menu.Root>
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
                      label={l`Post from @${name}`}
                      disabled={s.hasVideo && account.did !== s.currentDid}
                      onPress={() => choosePostingAccount(account.did)}>
                      <Menu.ItemText>{`@${name}`}</Menu.ItemText>
                      <Menu.ItemRadio selected={account.did === s.did} />
                    </Menu.RadioItem>
                  )
                })}
              </Menu.RadioGroup>
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
        </Menu.Outer>
      </Menu.Root>
      {isCurrent && s.currentDid && PLURAL_EDITING ? (
        <FrontSwitcherDialog control={frontControl} did={s.currentDid} />
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
