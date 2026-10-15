/*
 * The AppView switcher: prism shown greyed out (always connected), and the
 * public AppView, Bluesky's or a custom one.
 *
 * Adapted from the Witchsky client (MIT),
 * src/screens/Login/components/AppServerDialog.tsx (the dialog and the quiet
 * App server button; validation is in `appview-validation.ts`). Applying a
 * change reloads the page; an OAuth account is not re-authorized, because
 * `transition:generic` covers any AppView.
 */

import {useState} from 'react'
import {Keyboard, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {logger} from '#/logger'
import {useSession} from '#/state/session'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import * as TextField from '#/components/forms/TextField'
import {TinyChevronBottom_Stroke2_Corner0_Rounded as TinyChevronIcon} from '#/components/icons/Chevron'
import {
  Earth_Stroke2_Corner2_Rounded as EarthIcon,
  Globe_Stroke2_Corner0_Rounded as GlobeIcon,
} from '#/components/icons/Globe'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {openInPlaceSignIn} from '#/horizon/auth/in-place-store'
import {PRODUCT_NAME} from '#/horizon/branding'
import {validatePublicAppview} from '#/horizon/routing/appview-validation'
import {PRISM_URL} from '#/horizon/routing/prism'
import {
  type PublicAppviewChoice,
  usePublicAppviewChoice,
  writePublicAppviewChoice,
} from '#/horizon/routing/public-appview'
import {isOauthAccount} from '#/horizon/session/accounts'
import {restoreOAuthSession} from '#/horizon/session/oauth-transport'

function reloadApp() {
  if (IS_WEB && typeof window !== 'undefined') {
    window.location.reload()
  }
}

/**
 * Whether the current OAuth grant covers proxying to any AppView. A
 * `transition:generic` grant does; only a future granular grant would not.
 */
async function grantCoversAnyAppView(did: string) {
  try {
    const session = await restoreOAuthSession(did, false)
    const {scope} = await session.getTokenInfo(false)
    return scope.split(' ').includes('transition:generic')
  } catch (e) {
    logger.warn('appview switcher: reading the grant failed', {
      message: e instanceof Error ? e.message : String(e),
    })
    return true
  }
}

function AppViewSwitcherInner({control}: {control: Dialog.DialogControlProps}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const stored = usePublicAppviewChoice()
  const [preset, setPreset] = useState<'bluesky' | 'custom'>(
    stored ? 'custom' : 'bluesky',
  )
  const [address, setAddress] = useState(stored?.url ?? '')
  const [error, setError] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)

  const apply = async (choice: PublicAppviewChoice | undefined) => {
    writePublicAppviewChoice(choice)
    if (
      currentAccount &&
      isOauthAccount(currentAccount) &&
      !(await grantCoversAnyAppView(currentAccount.did))
    ) {
      control.close(() => openInPlaceSignIn(currentAccount))
      return
    }
    reloadApp()
  }

  const onPressSave = async () => {
    Keyboard.dismiss()
    setError('')
    if (preset === 'bluesky') {
      if (!stored) {
        control.close()
        return
      }
      await apply(undefined)
      return
    }
    setIsProcessing(true)
    const result = await validatePublicAppview(address)
    setIsProcessing(false)
    if (result.ok) {
      if (
        stored?.did === result.choice.did &&
        stored.url === result.choice.url
      ) {
        control.close()
        return
      }
      await apply(result.choice)
      return
    }
    switch (result.reason) {
      case 'empty':
        setError(l`Enter the address of an AppView.`)
        break
      case 'invalid':
        setError(l`That doesn’t look like a web address.`)
        break
      case 'prism':
        setError(
          l`This is ${PRODUCT_NAME}’s own server. It is always connected and can’t be the public AppView.`,
        )
        break
      case 'pds':
        setError(l`This is a PDS, not an AppView.`)
        break
      case 'not-found':
        setError(
          l`Couldn’t find an AppView at this address. Check the address and try again.`,
        )
        break
    }
  }

  return (
    <Dialog.ScrollableInner label={l`App servers`} style={web({maxWidth: 420})}>
      <View style={[a.gap_lg]}>
        <Text style={[a.text_2xl, a.font_bold]}>
          <Trans>App servers</Trans>
        </Text>

        <View
          accessibilityState={{disabled: true}}
          style={[
            a.p_md,
            a.rounded_md,
            a.border,
            a.gap_xs,
            t.atoms.border_contrast_low,
            t.atoms.bg_contrast_25,
            {opacity: 0.6},
          ]}>
          <Text style={[a.text_md, a.font_semi_bold]}>
            <Trans>{PRODUCT_NAME} network</Trans>
          </Text>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            {new URL(PRISM_URL).host}
          </Text>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>
              Always connected. Private posts, polls and Thread Lens use it.
            </Trans>
          </Text>
        </View>

        <View style={[a.gap_sm]}>
          <Text style={[a.text_md, a.font_semi_bold]}>
            <Trans>Public AppView</Trans>
          </Text>
          <SegmentedControl.Root
            type="tabs"
            label={l`Public AppView`}
            value={preset}
            onChange={value => {
              setPreset(value)
              setError('')
            }}>
            <SegmentedControl.Item
              testID="publicAppviewBlueskyBtn"
              value="bluesky"
              label={l`Bluesky`}>
              <SegmentedControl.ItemText>{l`Bluesky`}</SegmentedControl.ItemText>
            </SegmentedControl.Item>
            <SegmentedControl.Item
              testID="publicAppviewCustomBtn"
              value="custom"
              label={l`Custom`}>
              <SegmentedControl.ItemText>{l`Custom`}</SegmentedControl.ItemText>
            </SegmentedControl.Item>
          </SegmentedControl.Root>
          {preset === 'custom' && (
            <View>
              <TextField.LabelText>
                <Trans>AppView address</Trans>
              </TextField.LabelText>
              <TextField.Root isInvalid={!!error}>
                <TextField.Icon icon={GlobeIcon} />
                <Dialog.Input
                  testID="publicAppviewAddressInput"
                  label={l`AppView address`}
                  placeholder="api.example.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  value={address}
                  onChangeText={value => {
                    setAddress(value)
                    if (error) setError('')
                  }}
                  onSubmitEditing={() => void onPressSave()}
                />
              </TextField.Root>
            </View>
          )}
          {error ? <Admonition type="error">{error}</Admonition> : null}
          <Text
            style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
            <Trans>
              The public AppView provides posts, feeds, profiles, search and
              notifications. Changing it reloads the app.
            </Trans>
          </Text>
        </View>

        <Button
          testID="publicAppviewSaveBtn"
          label={l`Save`}
          color="primary"
          size="large"
          disabled={isProcessing}
          onPress={() => void onPressSave()}>
          <ButtonText>
            <Trans>Save</Trans>
          </ButtonText>
          {isProcessing && <ButtonIcon icon={Loader} />}
        </Button>
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

/**
 * The switcher dialog.
 */
export function AppViewSwitcherDialog({
  control,
}: {
  control: Dialog.DialogControlProps
}) {
  return (
    <Dialog.Outer control={control}>
      <Dialog.Handle />
      <AppViewSwitcherInner control={control} />
    </Dialog.Outer>
  )
}

/**
 * The Settings row, **App servers**.
 */
export function AppViewSettingsItem() {
  const {t: l} = useLingui()
  const control = Dialog.useDialogControl()
  return (
    <>
      <SettingsList.PressableItem
        label={l`App servers`}
        onPress={() => control.open()}>
        <SettingsList.ItemIcon icon={EarthIcon} />
        <SettingsList.ItemText>
          <Trans>App servers</Trans>
        </SettingsList.ItemText>
        <SettingsList.Chevron />
      </SettingsList.PressableItem>
      <AppViewSwitcherDialog control={control} />
    </>
  )
}

/**
 * The quiet **App server** button under the OAuth tab of the sign-in form, so
 * signed-out visitors can change the public AppView too.
 */
export function AppViewButton() {
  const t = useTheme()
  const {t: l} = useLingui()
  const control = Dialog.useDialogControl()
  return (
    <>
      <Button
        testID="appServerButton"
        label={l`App server`}
        accessibilityHint={l`Opens a dialog to choose the AppView used for posts, feeds and profiles`}
        size="small"
        color="secondary"
        variant="ghost"
        onPress={() => {
          Keyboard.dismiss()
          control.open()
        }}>
        <ButtonText style={[t.atoms.text_contrast_medium, a.font_normal]}>
          <Trans>App server</Trans>
        </ButtonText>
        <TinyChevronIcon width={8} style={[t.atoms.text_contrast_medium]} />
      </Button>
      <AppViewSwitcherDialog control={control} />
    </>
  )
}
