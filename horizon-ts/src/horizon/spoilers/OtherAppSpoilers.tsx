/*
 * Spoilers from other apps (change list item 2): the sync that feeds the
 * account's choice to the renderers, and the Content and media row that
 * sets it. The renderers' hook is `useOtherAppSpoilers`
 * (`other-apps-setting.ts`), kept apart so the stock `RichText` imports
 * nothing of Settings.
 */

import {useEffect} from 'react'
import {useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import * as Toggle from '#/components/forms/Toggle'
import {EyeSlash_Stroke2_Corner0_Rounded as EyeSlashIcon} from '#/components/icons/EyeSlash'
import {
  useReadingSettingsQuery,
  useSetReadingSettingsMutation,
} from '#/horizon/private/defaults/query'
import {DEFAULT_READING_SETTINGS} from '#/horizon/private/defaults/record'
import {
  otherAppSpoilersAvailable,
  setOtherAppSpoilersSetting,
} from './other-apps-setting'

function OtherAppSpoilersSyncInner() {
  const {data} = useReadingSettingsQuery()
  const value = (data ?? DEFAULT_READING_SETTINGS).otherAppSpoilers
  useEffect(() => {
    setOtherAppSpoilersSetting(value)
  }, [value])
  return null
}

/**
 * Feeds the current account's choice to the renderers. Mounted in the
 * account-keyed tree, so it follows account changes.
 */
export function OtherAppSpoilersSync() {
  if (!otherAppSpoilersAvailable()) return null
  return <OtherAppSpoilersSyncInner />
}

function OtherAppSpoilersToggleInner() {
  const {t: l} = useLingui()
  const {data} = useReadingSettingsQuery()
  const {mutate} = useSetReadingSettingsMutation()
  const reading = data ?? DEFAULT_READING_SETTINGS
  const label = l({
    message: 'Cover ||spoilers|| from other apps',
    comment:
      'Setting: text between double vertical bars in posts written in other apps is hidden behind a tap-to-reveal cover. Keep the || marks as they are.',
  })
  return (
    <Toggle.Item
      name="horizon_other_app_spoilers"
      label={label}
      value={reading.otherAppSpoilers}
      onChange={value => mutate({...reading, otherAppSpoilers: value})}>
      <SettingsList.Item>
        <SettingsList.ItemIcon icon={EyeSlashIcon} />
        <SettingsList.ItemText>{label}</SettingsList.ItemText>
        <Toggle.Platform />
      </SettingsList.Item>
    </Toggle.Item>
  )
}

/**
 * The Content and media row, per account: signed in, with the switches on.
 */
export function OtherAppSpoilersToggle() {
  const {hasSession} = useSession()
  if (!otherAppSpoilersAvailable() || !hasSession) return null
  return <OtherAppSpoilersToggleInner />
}
