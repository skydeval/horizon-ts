/*
 * The Thread Lens item of the thread options menu (Phase 4 design 4.1, 4.4;
 * hook TH-3): after the "Reply sorting" group, a divider, a group and one
 * item "Thread Lens" with an on/off pill toggle in its right slot, as
 * Horizon 1.0 had it. No label heading. Absent signed out, when the lens is
 * not served to the account (3.2), and on a private thread screen.
 *
 * The menu's content is portalled to the root on native ("Dialogs are
 * portal-ed to root", `Menu/index.tsx`), out of the screen's thread
 * context, so the state is read by `useThreadLensMenuItem` in
 * `HeaderDropdown` itself, inside the screen, and the element it returns
 * carries it as props. The anchor comes from the thread context's query
 * key, which carries it under both the stock and the lens key, so no prop
 * is added to `HeaderDropdown`.
 */

import {AccessibilityInfo, View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {usePostThreadContext} from '#/state/queries/usePostThread/context'
import {useSession} from '#/state/session'
import {useTheme} from '#/alf'
import * as Menu from '#/components/Menu'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {THREAD_LENS} from '#/horizon/switches'
import {useLensServed} from '#/horizon/thread-lens/availability'
import {
  setThreadLensPreference,
  useThreadLensPreference,
} from '#/horizon/thread-lens/preference'
import {
  ANNOUNCE_OFF,
  ANNOUNCE_ON,
  CONTROL_NAME,
} from '#/horizon/thread-lens/strings'

/** The anchor a thread query key carries (stock or lens). */
export function anchorOfThreadKey(key: readonly unknown[] | undefined) {
  const params = key?.[1]
  if (typeof params !== 'object' || params === null) return undefined
  const anchor = (params as {anchor?: unknown}).anchor
  return typeof anchor === 'string' ? anchor : undefined
}

/**
 * The menu item for the thread screen it is called on, or `null` when it is
 * absent. Called in `HeaderDropdown`'s render, outside the menu's portal.
 */
export function useThreadLensMenuItem(): React.ReactNode {
  const context = usePostThreadContext()
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  // Every store read runs on every render (rules of hooks).
  const served = useLensServed(did)
  const on = useThreadLensPreference(did)
  const anchor = anchorOfThreadKey(context?.postThreadQueryKey)
  if (!THREAD_LENS || !did || !served || !anchor || isPrivatePostUri(anchor)) {
    return null
  }
  return <ThreadLensMenuItem did={did} on={on} />
}

function ThreadLensMenuItem({did, on}: {did: string; on: boolean}) {
  const {i18n} = useLingui()
  const name = i18n._(CONTROL_NAME)
  return (
    <>
      <Menu.Divider />
      <Menu.Group>
        <Menu.Item
          label={name}
          accessibilityRole="switch"
          accessibilityState={{checked: on}}
          onPress={() => {
            setThreadLensPreference(did, !on)
            AccessibilityInfo.announceForAccessibility(
              i18n._(on ? ANNOUNCE_OFF : ANNOUNCE_ON),
            )
          }}>
          <Menu.ItemText>{name}</Menu.ItemText>
          <PillToggle enabled={on} />
        </Menu.Item>
      </Menu.Group>
    </>
  )
}

/** Horizon 1.0's pill toggle, set apart from the radio circles above it. */
function PillToggle({enabled}: {enabled: boolean}) {
  const t = useTheme()
  return (
    <View
      style={[
        {
          width: 36,
          height: 20,
          borderRadius: 10,
          padding: 2,
          justifyContent: 'center',
        },
        enabled
          ? {backgroundColor: t.palette.primary_500}
          : {backgroundColor: t.atoms.bg_contrast_100.backgroundColor},
      ]}>
      <View
        style={[
          {
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: t.palette.white,
          },
          enabled ? {alignSelf: 'flex-end'} : {alignSelf: 'flex-start'},
        ]}
      />
    </View>
  )
}
