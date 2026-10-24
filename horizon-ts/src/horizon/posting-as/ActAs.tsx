/*
 * Act as another signed-in account (Phase 5 design 8.6, hooks PA-6 to
 * PA-8): the account list a long press on the like or follow button, or
 * "Like as...", "Repost as..." and "Follow as..." in the post and profile
 * menus, opens. Each row is one of the other signed-in accounts that can
 * act, with that account's own state (liked, reposted, following), read as
 * it when the list opens; a press toggles it as that account
 * (`act-as.ts`), at once in the row, and the list stays open so several
 * accounts can act. The current account's controls and shadows are not
 * touched.
 *
 * Absent with `ACT_AS_CONTROLS` off, signed out, and with no other account
 * that can act.
 */

import {useEffect, useRef, useState} from 'react'
import {ActivityIndicator, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {sanitizeHandle} from '#/lib/strings/handles'
import {logger} from '#/logger'
import {useSession} from '#/state/session'
import {atoms as a, useTheme, web} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {Heart2_Stroke2_Corner0_Rounded as HeartIcon} from '#/components/icons/Heart2'
import {PersonPlus_Stroke2_Corner0_Rounded as PersonPlusIcon} from '#/components/icons/Person'
import {Repost_Stroke2_Corner2_Rounded as RepostIcon} from '#/components/icons/Repost'
import * as Menu from '#/components/Menu'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {useRestoredActionsHidden} from '#/horizon/refract/visitor'
import {ACT_AS_CONTROLS} from '#/horizon/switches'
import {
  type ActAsEntry,
  type ActAsKind,
  type ActAsPost,
  ActAsRefusedError,
  holdActAsClients,
  loadActAsPost,
  loadActAsProfile,
  toggleActAs,
  useActAs,
} from './act-as'
import {canActAs} from './temp-client'

type Account = {did: string; handle: string}

/** What a hook site holds: whether to offer act-as, and its list. */
export type ActAsControl = {
  available: boolean
  accounts: Account[]
  /** The list has been opened once (it is mounted from then on). */
  mounted: boolean
  kind: ActAsKind
  control: Dialog.DialogControlProps
  open: (kind: ActAsKind) => void
  /** The list closed: its accounts' clients are let go. */
  release: () => void
}

/**
 * The other signed-in accounts that can act, leaving out `exclude` (a
 * profile cannot be followed by itself).
 */
function useOtherAccounts(exclude?: string): Account[] {
  const {accounts, currentAccount, hasSession} = useSession()
  if (!ACT_AS_CONTROLS || !hasSession || !currentAccount) return []
  return accounts
    .filter(canActAs)
    .filter(
      account => account.did !== currentAccount.did && account.did !== exclude,
    )
    .map(account => ({did: account.did, handle: account.handle}))
}

function useControl(
  accounts: Account[],
  available: boolean,
  load: (did: string) => void,
): ActAsControl {
  const control = Dialog.useDialogControl()
  const [mounted, setMounted] = useState(false)
  const [kind, setKind] = useState<ActAsKind>('like')
  const held = useRef<(() => void) | undefined>(undefined)
  // A host unmounting with the list open lets its clients go too.
  useEffect(() => () => held.current?.(), [])
  return {
    available,
    accounts,
    mounted,
    kind,
    control,
    open(next) {
      if (!available) return
      setKind(next)
      setMounted(true)
      held.current?.()
      held.current = holdActAsClients(accounts.map(account => account.did))
      for (const account of accounts) load(account.did)
      // The list mounts on first open; open it once that render is in.
      setTimeout(() => control.open())
    },
    release() {
      held.current?.()
      held.current = undefined
    },
  }
}

/** Act as on a post (like, repost): PA-6, PA-7. */
export function useActAsPost(post: ActAsPost) {
  const accounts = useOtherAccounts()
  // A visitor-form restored view writes no like or repost, as stock.
  const hidden = useRestoredActionsHidden(post)
  const available = accounts.length > 0 && !hidden
  return useControl(accounts, available, did => {
    void loadActAsPost(did, {uri: post.uri, cid: post.cid})
  })
}

/** Act as on a profile (follow): PA-8. */
export function useActAsProfile(subject: string) {
  const accounts = useOtherAccounts(subject)
  return useControl(accounts, accounts.length > 0, did => {
    void loadActAsProfile(did, subject)
  })
}

/** The account list for a post, mounted on first open. */
export function ActAsPostDialog({
  actAs,
  post,
}: {
  actAs: ActAsControl
  post: ActAsPost
}) {
  const {t: l} = useLingui()
  if (!actAs.mounted) return null
  return (
    <ActAsDialog
      actAs={actAs}
      subject={post.uri}
      target={post}
      title={actAs.kind === 'repost' ? l`Repost as…` : l`Like as…`}
    />
  )
}

/** The account list for a profile, mounted on first open. */
export function ActAsFollowDialog({
  actAs,
  did,
  handle,
}: {
  actAs: ActAsControl
  did: string
  handle: string
}) {
  const {t: l} = useLingui()
  if (!actAs.mounted) return null
  const name = sanitizeHandle(handle, '@')
  return (
    <ActAsDialog
      actAs={actAs}
      subject={did}
      target={did}
      title={l`Follow ${name} as…`}
    />
  )
}

function ActAsDialog({
  actAs,
  subject,
  target,
  title,
}: {
  actAs: ActAsControl
  subject: string
  target: ActAsPost | string
  title: string
}) {
  const {t: l} = useLingui()
  const t = useTheme()
  return (
    <Dialog.Outer
      control={actAs.control}
      onClose={actAs.release}
      nativeOptions={{preventExpansion: true}}>
      <Dialog.Handle />
      <Dialog.ScrollableInner
        label={l`Choose an account to act as`}
        style={web({maxWidth: 400})}>
        <View style={[a.gap_md]}>
          <Text style={[a.text_xl, a.font_bold]}>{title}</Text>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>
              Only the account you choose acts. This account’s likes, reposts
              and follows don’t change.
            </Trans>
          </Text>
          <View style={[a.gap_xs]}>
            {actAs.accounts.map(account => (
              <AccountRow
                key={account.did}
                account={account}
                kind={actAs.kind}
                subject={subject}
                target={target}
              />
            ))}
          </View>
          <Button
            label={l`Done`}
            onPress={() => actAs.control.close()}
            size="large"
            color="secondary">
            <ButtonText>
              <Trans>Done</Trans>
            </ButtonText>
          </Button>
        </View>
        <Dialog.Close />
      </Dialog.ScrollableInner>
    </Dialog.Outer>
  )
}

/** Whether `entry` holds `kind`'s record (or one being written). */
function isOn(entry: ActAsEntry | undefined, kind: ActAsKind): boolean {
  if (entry?.status !== 'ready') return false
  if (kind === 'like') return !!entry.like
  if (kind === 'repost') return !!entry.repost
  return !!entry.following
}

function AccountRow({
  account,
  kind,
  subject,
  target,
}: {
  account: Account
  kind: ActAsKind
  subject: string
  target: ActAsPost | string
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const entry = useActAs(account.did, subject)
  const handle = sanitizeHandle(account.handle, '@')
  const on = isOn(entry, kind)
  const ready = entry?.status === 'ready'

  const label = (() => {
    if (kind === 'like')
      return on ? l`Undo like as ${handle}` : l`Like as ${handle}`
    if (kind === 'repost') {
      return on ? l`Undo repost as ${handle}` : l`Repost as ${handle}`
    }
    return on ? l`Unfollow as ${handle}` : l`Follow as ${handle}`
  })()

  const state = (() => {
    if (!entry || entry.status === 'loading') return null
    if (entry.status === 'error') return l`Couldn’t load`
    if (entry.status === 'refused') {
      return entry.reason === 'blocked' ? l`Blocked` : l`Can’t see this post`
    }
    if (kind === 'like') return on ? l`Liked` : l`Like`
    if (kind === 'repost') return on ? l`Reposted` : l`Repost`
    return on ? l`Following` : l`Follow`
  })()

  const onPress = () => {
    toggleActAs(account.did, kind, target).catch((error: unknown) => {
      if (error instanceof ActAsRefusedError) {
        Toast.show(error.message, {type: 'warning'})
        return
      }
      logger.warn('act as: the write failed', {kind, safeMessage: error})
      Toast.show(l`That didn’t go through as ${handle}. Try again.`, {
        type: 'error',
      })
    })
  }

  const Icon =
    kind === 'like'
      ? HeartIcon
      : kind === 'repost'
        ? RepostIcon
        : PersonPlusIcon
  const activeColor =
    kind === 'like'
      ? t.palette.pink
      : kind === 'repost'
        ? t.palette.positive_500
        : t.palette.primary_500

  return (
    <Button
      testID={`actAs-${kind}-${account.handle}`}
      label={label}
      disabled={!ready}
      onPress={onPress}
      style={[a.justify_start, a.px_md, a.py_sm, a.gap_md, a.rounded_md]}
      size="large"
      color="secondary">
      <Text
        emoji
        style={[a.flex_1, a.text_md, a.font_semi_bold]}
        numberOfLines={1}>
        {handle}
      </Text>
      {!entry || entry.status === 'loading' ? (
        <ActivityIndicator size="small" />
      ) : (
        <View style={[a.flex_row, a.align_center, a.gap_xs]}>
          {ready ? (
            <Icon
              size="sm"
              fill={on ? activeColor : t.atoms.text_contrast_medium.color}
            />
          ) : null}
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>{state}</Text>
        </View>
      )}
    </Button>
  )
}

/**
 * "Like as..." and "Repost as..." in the post menu (PA-7), for the web
 * and, since a long press on repost already quotes, for repost on native.
 */
export function ActAsPostMenuItems({actAs}: {actAs: ActAsControl}) {
  const {t: l} = useLingui()
  if (!actAs.available) return null
  return (
    <>
      <Menu.Group>
        <Menu.Item
          testID="postDropdownLikeAsBtn"
          label={l`Like as…`}
          onPress={() => actAs.open('like')}>
          <Menu.ItemText>{l`Like as…`}</Menu.ItemText>
          <Menu.ItemIcon icon={HeartIcon} position="right" />
        </Menu.Item>
        <Menu.Item
          testID="postDropdownRepostAsBtn"
          label={l`Repost as…`}
          onPress={() => actAs.open('repost')}>
          <Menu.ItemText>{l`Repost as…`}</Menu.ItemText>
          <Menu.ItemIcon icon={RepostIcon} position="right" />
        </Menu.Item>
      </Menu.Group>
      <Menu.Divider />
    </>
  )
}

/** "Follow as..." in the profile menu (PA-8). */
export function ActAsFollowMenuItem({actAs}: {actAs: ActAsControl}) {
  const {t: l} = useLingui()
  if (!actAs.available) return null
  return (
    <Menu.Item
      testID="profileHeaderDropdownFollowAsBtn"
      label={l`Follow as…`}
      onPress={() => actAs.open('follow')}>
      <Menu.ItemText>
        <Trans>Follow as…</Trans>
      </Menu.ItemText>
      <Menu.ItemIcon icon={PersonPlusIcon} />
    </Menu.Item>
  )
}
