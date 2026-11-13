/*
 * The Thread Lens group of Settings > Thread preferences (Phase 4 design
 * 4.1, 4.4; hook TH-9): after the "Tree view" group, a group titled "Thread
 * Lens" with one stock switch labelled "Thread Lens" (the same controls as
 * the tree-view switch, which carry the switch role and state) and one line
 * of explanation. Absent signed out and when the lens is not served to the
 * account (3.2). It writes the same device value as the menu item.
 */

import {AccessibilityInfo} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {atoms as a} from '#/alf'
import * as Toggle from '#/components/forms/Toggle'
import {Eye_Stroke2_Corner0_Rounded as EyeIcon} from '#/components/icons/Eye'
import {MagnifyingGlass_Stroke2_Corner0_Rounded as LensIcon} from '#/components/icons/MagnifyingGlass'
import {useAsterLabels} from '#/horizon/routing/aster'
import {ASTER, THREAD_LENS} from '#/horizon/switches'
import {
  setAsterPreference,
  useAsterPreference,
} from '#/horizon/thread-lens/aster-preference'
import {useLensServed} from '#/horizon/thread-lens/availability'
import {
  setThreadLensPreference,
  useThreadLensPreference,
} from '#/horizon/thread-lens/preference'
import {
  ANNOUNCE_OFF,
  ANNOUNCE_ON,
  CONTROL_EXPLANATION,
  CONTROL_NAME,
  switchOff,
  switchOn,
} from '#/horizon/thread-lens/strings'

/** The settings group, or nothing. */
export function ThreadLensSettingsGroup() {
  const {i18n} = useLingui()
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  // Every store read runs on every render (rules of hooks).
  const served = useLensServed(did)
  const on = useThreadLensPreference(did)
  if (!THREAD_LENS || !did || !served) return <AsterSettingsGroup did={did} />
  const name = i18n._(CONTROL_NAME)
  return (
    <>
      <SettingsList.Group>
        <SettingsList.ItemIcon icon={LensIcon} />
        <SettingsList.ItemText>{name}</SettingsList.ItemText>
        <Toggle.Item
          type="checkbox"
          name="thread-lens"
          label={name}
          value={on}
          onChange={value => {
            setThreadLensPreference(did, value)
            AccessibilityInfo.announceForAccessibility(
              i18n._(value ? ANNOUNCE_ON : ANNOUNCE_OFF),
            )
          }}
          style={[a.w_full, a.gap_md]}>
          <Toggle.LabelText style={[a.flex_1]}>
            {i18n._(CONTROL_EXPLANATION)}
          </Toggle.LabelText>
          <Toggle.Platform />
        </Toggle.Item>
      </SettingsList.Group>
      <AsterSettingsGroup did={did} />
    </>
  )
}

/**
 * The aster switch, under the lens group, for an account prism grants
 * aster; named by prism. Off until turned on. Writes the same device value
 * as the thread menu's item.
 */
function AsterSettingsGroup({did}: {did: string | undefined}) {
  const {i18n} = useLingui()
  // Every store read runs on every render (rules of hooks).
  const labels = useAsterLabels(did)
  const on = useAsterPreference(did)
  if (!ASTER || !did || !labels) return null
  const name = labels.setting
  return (
    <SettingsList.Group>
      <SettingsList.ItemIcon icon={EyeIcon} />
      <Toggle.Item
        type="checkbox"
        name="thread-aster"
        label={name}
        value={on}
        onChange={value => {
          setAsterPreference(did, value)
          AccessibilityInfo.announceForAccessibility(
            i18n._(value ? switchOn(name) : switchOff(name)),
          )
        }}
        style={[a.w_full, a.gap_md]}>
        <Toggle.LabelText style={[a.flex_1]}>{name}</Toggle.LabelText>
        <Toggle.Platform />
      </Toggle.Item>
    </SettingsList.Group>
  )
}
