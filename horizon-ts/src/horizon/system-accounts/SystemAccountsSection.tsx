/*
 * Edit Profile, Plurality tab, "System accounts" (system accounts design
 * 4.1, 4.2, 4.5, 4.6, 5.4.1): the current account's list, each row with its
 * state on this device in text (never colour alone), "Add an account",
 * re-verify, remove, and the registered account's own status. Shown whether
 * or not a plural system is set up (SA-1). Rows read no profile through the
 * current account (SA-19): handles come from the add or the DID document,
 * looked up one row at a time.
 */

import {useEffect, useRef, useState, useSyncExternalStore} from 'react'
import {AccessibilityInfo, findNodeHandle, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {UserAvatar} from '#/view/com/util/UserAvatar'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {PlusLarge_Stroke2_Corner0_Rounded as PlusIcon} from '#/components/icons/Plus'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {HIT_44} from '#/horizon/identity/edit/fields'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {servesFeature, subscribePrismFeatures} from '#/horizon/routing/features'
import {SYSTEM_ACCOUNTS} from '#/horizon/switches'
import {AddSystemAccountDialog} from './AddSystemAccountDialog'
import {
  type RowState,
  type SystemAccountRow,
  useRowHandles,
  useSystemAccountRows,
} from './hooks'
import {MAX_SYSTEM_ACCOUNTS, useCachedLists} from './list-store'
import {systemAccountsStubActive} from './prism'
import {removeSystemAccount} from './register'
import {RemoveSystemAccountDialog} from './RemoveSystemAccountDialog'
import {readList, useListLoadState} from './sync'
import {SystemAccountStatus} from './SystemAccountStatus'
import {accountName, StatusMessageText} from './ui'

let focusRequested = false

/**
 * "Manage system accounts..." (4.1): the next time the section mounts, it
 * scrolls to and focuses its heading.
 */
export function requestSystemAccountsFocus() {
  focusRequested = true
}

type Focusable = React.ComponentRef<typeof View>

/** On web the element itself; on native the view behind it. */
type DomLike = {focus?: () => void; scrollIntoView?: () => void}

function focusView(view: Focusable | null | undefined) {
  if (!view) return
  if (IS_WEB) {
    ;(view as unknown as DomLike).focus?.()
    return
  }
  const tag = findNodeHandle(view)
  if (tag) AccessibilityInfo.setAccessibilityFocus(tag)
}

function useServed(did: string): boolean {
  return useSyncExternalStore(
    subscribePrismFeatures,
    () =>
      systemAccountsStubActive() ||
      servesFeature('account.systemAccounts', did),
  )
}

export function SystemAccountsSection({did}: {did: string}) {
  if (!SYSTEM_ACCOUNTS) return null
  return <Section did={did} />
}

function Section({did}: {did: string}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {accounts, currentAccount} = useSession()
  const rows = useSystemAccountRows(did, accounts)
  useRowHandles(rows)
  const load = useListLoadState(did)
  // Not listed, or prism answered 501 MethodNotImplemented (its reply).
  const served = useServed(did) && load !== 'unavailable'
  // From the store's snapshot, so it updates (a plain read would be memoised).
  const hasCache = !!useCachedLists()[did]
  const addControl = Dialog.useDialogControl()
  const reverifyControl = Dialog.useDialogControl()
  const removeControl = Dialog.useDialogControl()
  const [reverify, setReverify] = useState<SystemAccountRow>()
  const [removing, setRemoving] = useState<SystemAccountRow>()
  const rowRefs = useRef(new Map<string, Focusable>())
  const headingRef = useRef<Focusable>(null)
  const addRef = useRef<Focusable>(null)
  const pendingFocus = useRef<string | undefined>(undefined)
  const current = accountName(currentAccount?.handle, did)
  const full = rows.length >= MAX_SYSTEM_ACCOUNTS

  // Read in the background on tab open, when stale (5.5).
  useEffect(() => {
    const clients = getCurrentClients()
    if (clients?.did === did) void readList(did, clients.pdsClient)
  }, [did])

  useEffect(() => {
    if (!focusRequested) return
    focusRequested = false
    const heading = headingRef.current
    if (IS_WEB) (heading as unknown as DomLike | null)?.scrollIntoView?.()
    focusView(heading)
  }, [])

  // Focus lands on a row once it renders (after an add or a rollback).
  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    const view = rowRefs.current.get(target)
    if (!view) return
    pendingFocus.current = undefined
    focusView(view)
  })

  const retry = () => {
    const clients = getCurrentClients()
    if (clients?.did === did)
      void readList(did, clients.pdsClient, {force: true})
  }

  const onRemove = async (row: SystemAccountRow) => {
    const index = rows.findIndex(r => r.did === row.did)
    const next = rows[index + 1] ?? rows[index - 1]
    const result = await removeSystemAccount(did, row.did, row.handle)
    if (result === 'removed') {
      if (next) {
        pendingFocus.current = next.did
        focusView(rowRefs.current.get(next.did))
      } else {
        focusView(addRef.current)
      }
    } else {
      // The rollback: focus to the restored row (4.6).
      pendingFocus.current = row.did
    }
  }

  return (
    <View style={[a.gap_sm]} testID="systemAccountsSection">
      <View
        ref={headingRef}
        {...(IS_WEB ? {tabIndex: -1} : {})}
        accessible={!IS_WEB}>
        <Text accessibilityRole="header" style={[a.text_lg, a.font_semi_bold]}>
          <Trans>System accounts</Trans>
        </Text>
      </View>
      <Text style={[a.text_md, a.leading_snug, t.atoms.text_contrast_medium]}>
        <Trans>
          Other accounts that belong to your system. You can post, like, repost
          and follow as them from {current} without switching. Nobody else can
          see this list.
        </Trans>
      </Text>
      {rows.length > 0 ? (
        <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
          <Trans>Each device signs in to them separately.</Trans>
        </Text>
      ) : null}

      {!served && !hasCache ? (
        <StatusMessageText testID="systemAccountsUnavailable">
          {l`System accounts aren’t available right now.`}
        </StatusMessageText>
      ) : null}
      {served && load === 'error' && !hasCache ? (
        <View style={[a.gap_sm]}>
          <StatusMessageText testID="systemAccountsLoadError">
            {l`Couldn’t load your system accounts.`}
          </StatusMessageText>
          <View style={[a.flex_row]}>
            <Button
              label={l`Try loading your system accounts again`}
              onPress={retry}
              size="small"
              color="secondary"
              hitSlop={HIT_44}>
              <ButtonText>
                <Trans>Try again</Trans>
              </ButtonText>
            </Button>
          </View>
        </View>
      ) : null}

      {rows.map(row => (
        <AccountRow
          key={row.did}
          row={row}
          refFor={view => {
            if (view) rowRefs.current.set(row.did, view)
            else rowRefs.current.delete(row.did)
          }}
          onSignIn={() => {
            setReverify(row)
            reverifyControl.open()
          }}
          onRemove={() => {
            setRemoving(row)
            removeControl.open()
          }}
        />
      ))}

      <View style={[a.flex_row, a.align_center, a.gap_sm, a.flex_wrap]}>
        <Button
          ref={addRef}
          testID="systemAccountsAdd"
          label={l`Add an account`}
          onPress={() => addControl.open()}
          disabled={full || !served}
          size="small"
          color="primary"
          hitSlop={HIT_44}>
          <ButtonIcon icon={PlusIcon} />
          <ButtonText>
            <Trans>Add an account</Trans>
          </ButtonText>
        </Button>
        {full ? (
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Up to 31 system accounts</Trans>
          </Text>
        ) : null}
      </View>

      <SystemAccountStatus did={did} served={served} />

      <AddSystemAccountDialog
        control={addControl}
        registrar={did}
        onDone={added => {
          pendingFocus.current = added
          focusView(rowRefs.current.get(added))
        }}
      />
      {reverify ? (
        <AddSystemAccountDialog
          control={reverifyControl}
          registrar={did}
          reverify={{did: reverify.did, handle: reverify.handle}}
          onDone={signedIn => focusView(rowRefs.current.get(signedIn))}
        />
      ) : null}
      {removing ? (
        <RemoveSystemAccountDialog
          control={removeControl}
          lala={accountName(removing.handle, removing.did)}
          current={current}
          onConfirm={() => void onRemove(removing)}
        />
      ) : null}
    </View>
  )
}

function useStatusText(state: RowState): string {
  const {t: l} = useLingui()
  switch (state) {
    case 'ready':
      return l`Ready on this device`
    case 'signIn':
      return l`Sign in on this device`
    case 'signInAgain':
      return l`Sign in again`
    case 'adding':
      return l`Adding…`
  }
}

function AccountRow({
  row,
  refFor,
  onSignIn,
  onRemove,
}: {
  row: SystemAccountRow
  refFor: (view: Focusable | null) => void
  onSignIn: () => void
  onRemove: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const name = accountName(row.handle, row.did)
  const status = useStatusText(row.state)
  const needsSignIn = row.state === 'signIn' || row.state === 'signInAgain'
  const groupLabel = [name, row.displayName, status].filter(Boolean).join(', ')
  return (
    <View
      ref={refFor}
      testID={`systemAccountsRow-${row.did}`}
      // Web: a labelled group. Native: not `accessible`, so its texts and
      // buttons stay separate and focusable (4.6).
      {...(IS_WEB
        ? {role: 'group' as const, 'aria-label': groupLabel, tabIndex: -1}
        : {accessible: false})}
      style={[
        a.flex_row,
        a.align_center,
        a.gap_md,
        a.py_sm,
        a.border_b,
        t.atoms.border_contrast_low,
      ]}>
      {row.avatar ? (
        <UserAvatar type="user" size={32} avatar={row.avatar} />
      ) : null}
      <View style={[a.flex_1, a.gap_2xs]}>
        <Text emoji numberOfLines={1} style={[a.text_md, a.font_semi_bold]}>
          {name}
        </Text>
        {row.displayName ? (
          <Text emoji numberOfLines={1} style={[a.text_sm]}>
            {row.displayName}
          </Text>
        ) : null}
        <Text
          testID={`systemAccountsRowStatus-${row.did}`}
          style={[a.text_sm, t.atoms.text_contrast_medium]}>
          {status}
        </Text>
      </View>
      {needsSignIn ? (
        <Button
          testID={`systemAccountsSignIn-${row.did}`}
          label={
            row.state === 'signInAgain'
              ? l`Sign in again as ${name}`
              : l`Sign in as ${name} on this device`
          }
          accessibilityHint={l`Opens your server’s sign-in`}
          onPress={onSignIn}
          size="small"
          color="primary"
          hitSlop={HIT_44}>
          <ButtonText>
            {row.state === 'signInAgain' ? (
              <Trans>Sign in again</Trans>
            ) : (
              <Trans>Sign in</Trans>
            )}
          </ButtonText>
        </Button>
      ) : null}
      {row.state !== 'adding' ? (
        <Button
          testID={`systemAccountsRemove-${row.did}`}
          label={l`Remove ${name} from system accounts`}
          onPress={onRemove}
          size="small"
          color="secondary"
          hitSlop={HIT_44}>
          <ButtonText>
            <Trans>Remove</Trans>
          </ButtonText>
        </Button>
      ) : null}
    </View>
  )
}
