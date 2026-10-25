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
 *
 * System accounts (system accounts design 8.1, SA-H4, SA-20): the rows are
 * the current account's registered system accounts, never the other
 * switcher accounts. Opening the list reads nothing; a row's own state is
 * read when it gets focus (web) or is pressed in (native), and its client
 * is held from then. A row is enabled while unloaded, and a press waits for
 * its one read. An account that needs a sign-in here is an enabled "Sign in
 * as @lala on this device" button.
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
import {IS_WEB} from '#/env'
import {useRestoredActionsHidden} from '#/horizon/refract/visitor'
import {ACT_AS_CONTROLS} from '#/horizon/switches'
import {AddSystemAccountDialog} from '#/horizon/system-accounts/AddSystemAccountDialog'
import {
  type RowState,
  useSystemAccountRows,
} from '#/horizon/system-accounts/hooks'
import {
  type ActAsEntry,
  type ActAsKind,
  type ActAsPost,
  ActAsRefusedError,
  getActAs,
  holdActAsClients,
  loadActAsPost,
  loadActAsProfile,
  toggleActAs,
  useActAs,
} from './act-as'

type Account = {did: string; handle: string; state: RowState}

/** What a hook site holds: whether to offer act-as, and its list. */
export type ActAsControl = {
  available: boolean
  accounts: Account[]
  /** The list has been opened once (it is mounted from then on). */
  mounted: boolean
  kind: ActAsKind
  control: Dialog.DialogControlProps
  open: (kind: ActAsKind) => void
  /**
   * Read one account's state and hold its client until the list closes
   * (SA-20): on a row's focus or press. Resolves once read.
   */
  prepare: (did: string) => Promise<void>
  /** The list closed: its accounts' clients are let go. */
  release: () => void
  /** The current account, whose list the rows are. */
  registrar: string | undefined
}

/**
 * The current account's system accounts (8.1), leaving out `exclude` (a
 * profile cannot be followed by itself). Never another switcher account.
 */
function useOtherAccounts(exclude?: string): {
  accounts: Account[]
  registrar: string | undefined
} {
  const {accounts, currentAccount, hasSession} = useSession()
  const rows = useSystemAccountRows(currentAccount?.did, accounts)
  if (!ACT_AS_CONTROLS || !hasSession || !currentAccount) {
    return {accounts: [], registrar: undefined}
  }
  return {
    registrar: currentAccount.did,
    accounts: rows
      .filter(row => row.did !== exclude && row.state !== 'adding')
      .map(row => ({
        did: row.did,
        handle: row.handle ?? row.did,
        state: row.state,
      })),
  }
}

function useControl(
  {accounts, registrar}: {accounts: Account[]; registrar: string | undefined},
  available: boolean,
  load: (did: string) => Promise<void>,
): ActAsControl {
  const control = Dialog.useDialogControl()
  const [mounted, setMounted] = useState(false)
  const [kind, setKind] = useState<ActAsKind>('like')
  const held = useRef(new Map<string, () => void>())
  const reads = useRef(new Map<string, Promise<void>>())
  const releaseAll = () => {
    held.current.forEach(release => release())
    held.current.clear()
    reads.current.clear()
  }
  // A host unmounting with the list open lets its clients go too.
  useEffect(() => {
    const holds = held.current
    return () => {
      holds.forEach(release => release())
      holds.clear()
    }
  }, [])
  return {
    available,
    accounts,
    mounted,
    kind,
    control,
    registrar,
    open(next) {
      if (!available) return
      setKind(next)
      setMounted(true)
      // Nothing is read on open (SA-20): no burst across every account.
      releaseAll()
      // The list mounts on first open; open it once that render is in.
      setTimeout(() => control.open())
    },
    prepare(did) {
      const running = reads.current.get(did)
      if (running) return running
      if (!held.current.has(did)) {
        held.current.set(did, holdActAsClients([did]))
      }
      const read = load(did)
      reads.current.set(did, read)
      return read
    },
    release() {
      releaseAll()
    },
  }
}

/** Act as on a post (like, repost): PA-6, PA-7. */
export function useActAsPost(post: ActAsPost) {
  const others = useOtherAccounts()
  // A visitor-form restored view writes no like or repost, as stock.
  const hidden = useRestoredActionsHidden(post)
  const available = others.accounts.length > 0 && !hidden
  return useControl(others, available, did =>
    loadActAsPost(did, {uri: post.uri, cid: post.cid}),
  )
}

/** Act as on a profile (follow): PA-8. */
export function useActAsProfile(subject: string) {
  const others = useOtherAccounts(subject)
  return useControl(others, others.accounts.length > 0, did =>
    loadActAsProfile(did, subject),
  )
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
  const reverifyControl = Dialog.useDialogControl()
  const [reverify, setReverify] = useState<Account>()
  return (
    <>
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
              {actAs.accounts.map(account =>
                account.state === 'ready' ? (
                  <AccountRow
                    key={account.did}
                    account={account}
                    kind={actAs.kind}
                    subject={subject}
                    target={target}
                    prepare={actAs.prepare}
                  />
                ) : (
                  <SignInRow
                    key={account.did}
                    account={account}
                    onPress={() => {
                      setReverify(account)
                      actAs.control.close(() => reverifyControl.open())
                    }}
                  />
                ),
              )}
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
      {reverify && actAs.registrar ? (
        <AddSystemAccountDialog
          control={reverifyControl}
          registrar={actAs.registrar}
          reverify={{did: reverify.did, handle: reverify.handle}}
        />
      ) : null}
    </>
  )
}

/** A listed account that needs a sign-in here (8.1): an enabled button. */
function SignInRow({
  account,
  onPress,
}: {
  account: Account
  onPress: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const handle = sanitizeHandle(account.handle, '@')
  const label =
    account.state === 'signInAgain'
      ? l`Sign in again as ${handle}`
      : l`Sign in as ${handle} on this device`
  return (
    <Button
      testID={`actAsSignIn-${account.handle}`}
      label={label}
      accessibilityHint={l`Opens your server’s sign-in`}
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
      <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
        {account.state === 'signInAgain' ? (
          <Trans>Sign in again</Trans>
        ) : (
          <Trans>Sign in on this device</Trans>
        )}
      </Text>
    </Button>
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
  prepare,
}: {
  account: Account
  kind: ActAsKind
  subject: string
  target: ActAsPost | string
  prepare: (did: string) => Promise<void>
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const entry = useActAs(account.did, subject)
  const handle = sanitizeHandle(account.handle, '@')
  const on = isOn(entry, kind)
  const ready = entry?.status === 'ready'
  const [waiting, setWaiting] = useState(false)
  // Unloaded or loading: enabled, so focus or a press can start the read.
  const loading = !entry || entry.status === 'loading'

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

  const act = () => {
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

  // SA-20: the read starts on focus (web) or press-in (native), one row only.
  const start = () => void prepare(account.did)
  const onPress = async () => {
    if (ready) {
      act()
      return
    }
    // A press waits for this row's one read, then acts (SAR2-N9).
    setWaiting(true)
    try {
      await prepare(account.did)
    } finally {
      setWaiting(false)
    }
    if (getActAs(account.did, subject)?.status === 'ready') act()
  }

  return (
    <Button
      testID={`actAs-${kind}-${account.handle}`}
      label={label}
      // Disabled only once loaded, for the reasons it was before (8.1).
      disabled={!loading && !ready}
      onFocus={IS_WEB ? start : undefined}
      onPressIn={IS_WEB ? undefined : start}
      onPress={() => void onPress()}
      style={[a.justify_start, a.px_md, a.py_sm, a.gap_md, a.rounded_md]}
      size="large"
      color="secondary">
      <Text
        emoji
        style={[a.flex_1, a.text_md, a.font_semi_bold]}
        numberOfLines={1}>
        {handle}
      </Text>
      {waiting || entry?.status === 'loading' ? (
        <ActivityIndicator
          size="small"
          accessibilityLabel={l`Checking ${handle}…`}
          accessibilityHint=""
        />
      ) : !entry ? null : (
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
