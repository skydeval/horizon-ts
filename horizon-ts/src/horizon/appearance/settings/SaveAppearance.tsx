/*
 * "Save my appearance" (appearance storage choice design, section 2): a
 * radio group per account, hidden when signed out. Members of a prism that
 * lists `private.appearance` see three rows; everyone else (non-members,
 * removed members, and members until prism lists the feature) sees two. The
 * radio shows a choice not yet landed at once, and its row says "Moving..."
 * until the choice lands and its record step is done. The migration,
 * removal and too-large notes leave a line here until dismissed. Web
 * only: the app keeps its appearance on the device (`sync-platform.ts`).
 */

import {useSyncExternalStore} from 'react'
import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Toggle from '#/components/forms/Toggle'
import {FloppyDisk_Stroke2_Corner0_Rounded as SaveIcon} from '#/components/icons/FloppyDisk'
import {Text} from '#/components/Typography'
import {
  type AppearanceStore,
  parseStore,
} from '#/horizon/appearance/device-value'
import {
  migrationNoteText,
  removalNoteText,
  takenNoteText,
  tooLargeNoteText,
} from '#/horizon/appearance/notices'
import {offersPrivateAppearance} from '#/horizon/appearance/prism'
import {
  chooseAppearanceStore,
  dismissAppearanceNote,
  useAppearanceState,
} from '#/horizon/appearance/store'
import {appearanceSyncs} from '#/horizon/appearance/sync-platform'
import {PRODUCT_NAME} from '#/horizon/branding'
import {subscribePrismFeatures} from '#/horizon/routing/features'
import {subscribeMembership} from '#/horizon/routing/membership'

function subscribeAnswers(listener: () => void) {
  const offMembership = subscribeMembership(listener)
  const offFeatures = subscribePrismFeatures(listener)
  return () => {
    offMembership()
    offFeatures()
  }
}

/** Whether "Private, synced" is offered to `did`, kept current. */
function useOffersPrivate(did: string | undefined): boolean {
  return useSyncExternalStore(subscribeAnswers, () =>
    offersPrivateAppearance(did),
  )
}

export function SaveAppearanceGroup() {
  const t = useTheme()
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const {device} = useAppearanceState()
  const offersPrivate = useOffersPrivate(did)
  if (!did || !appearanceSyncs()) return null
  const copy = device.accounts[did]
  const shown = copy?.pending?.store ?? copy?.store ?? null
  // A remembered `private` with the feature unlisted shows as resolving.
  const value = shown === 'private' && !offersPrivate ? null : shown
  const moving = !!copy && (copy.pending?.store !== undefined || copy.recordDue)

  const rows: {store: AppearanceStore; label: string; description: string}[] = [
    ...(offersPrivate
      ? [
          {
            store: 'private' as const,
            label: l`Private, synced`,
            description: l`${PRODUCT_NAME} keeps it for you and syncs it across your devices. It isn’t in your public account.`,
          },
        ]
      : []),
    {
      store: 'public',
      label: l`Public, in my account`,
      description: l`Saved in your account’s public data. Other apps can read it.`,
    },
    {
      store: 'device',
      label: l`This device only`,
      description: l`Not saved anywhere else. Your other devices keep their own.`,
    },
  ]

  const line = copy?.noted
    ? migrationNoteText()
    : copy?.removalLine
      ? copy.removalTaken
        ? takenNoteText()
        : removalNoteText()
      : copy?.tooLargeLine
        ? tooLargeNoteText()
        : null

  return (
    <SettingsList.Group contentContainerStyle={[a.gap_sm]} iconInset={false}>
      <SettingsList.ItemIcon icon={SaveIcon} />
      <SettingsList.ItemText>{l`Save my appearance`}</SettingsList.ItemText>
      <Toggle.Group
        type="radio"
        label={l`Save my appearance`}
        values={value ? [value] : []}
        onChange={values => {
          const next = parseStore(values[0])
          if (next) chooseAppearanceStore(did, next)
        }}>
        <View style={[a.w_full, a.gap_sm]}>
          {rows.map(row => (
            <Toggle.Item
              key={row.store}
              label={row.label}
              name={row.store}
              style={[a.w_full, a.flex_row, a.align_start, a.py_xs, a.gap_sm]}>
              <Toggle.Radio />
              <View style={[a.flex_1, a.gap_2xs]}>
                <Toggle.LabelText style={[t.atoms.text, a.text_md]}>
                  {row.label}
                </Toggle.LabelText>
                <Text
                  style={[
                    a.text_sm,
                    a.leading_snug,
                    t.atoms.text_contrast_medium,
                  ]}>
                  {row.description}
                </Text>
                {moving && value === row.store && (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[a.text_sm, t.atoms.text_contrast_medium]}>
                    {l({message: 'Moving…', context: 'appearance storage'})}
                  </Text>
                )}
              </View>
            </Toggle.Item>
          ))}
        </View>
      </Toggle.Group>
      {line !== null && (
        <View style={[a.w_full, a.gap_xs]}>
          <Text style={[a.text_sm, a.leading_snug, t.atoms.text]}>{line}</Text>
          <View style={[a.flex_row]}>
            <Button
              label={l`Dismiss`}
              size="tiny"
              color="secondary"
              onPress={() => dismissAppearanceNote(did)}>
              <ButtonText>{l`Dismiss`}</ButtonText>
            </Button>
          </View>
        </View>
      )}
    </SettingsList.Group>
  )
}
