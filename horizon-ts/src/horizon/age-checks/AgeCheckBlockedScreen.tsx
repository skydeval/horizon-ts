/*
 * The app's blocked screen for an age check (`under13`, `parentDeclined`),
 * shown by the shell in place of Bluesky's verification screen. The way out
 * is through the store (confirm an age, or a parent's approval), then
 * "Check again"; or sign out.
 */

import {ScrollView, View} from 'react-native'
import {useSafeAreaInsets} from 'react-native-safe-area-context'
import {BottomSheetOutlet} from '@bsky.app/bottom-sheet'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession, useSessionApi} from '#/state/session'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {Loader} from '#/components/Loader'
import {Outlet as PortalOutlet} from '#/components/Portal'
import {H1, Text} from '#/components/Typography'
import {checkAgeAgain, useAgeCheck} from '#/horizon/age-checks'
import {openInStore} from '#/horizon/age-checks/store-link'

const textStyles = [a.text_md, a.leading_snug]

export function AgeCheckBlockedScreen() {
  const t = useTheme()
  const {t: l} = useLingui()
  const insets = useSafeAreaInsets()
  const check = useAgeCheck()
  const {hasSession} = useSession()
  const {logoutCurrentAccount} = useSessionApi()
  const checking = check?.checking ?? false
  const state = check?.region.name ?? ''

  return (
    <>
      <View style={[a.util_screen_outer, a.flex_1, t.atoms.bg]}>
        <ScrollView
          contentContainerStyle={[
            a.px_2xl,
            {paddingTop: insets.top + a.p_2xl.padding, paddingBottom: 100},
          ]}>
          <View style={[a.mx_auto, a.w_full, a.gap_2xl, {maxWidth: 420}]}>
            <H1 style={[a.text_3xl, a.font_bold]}>
              {check?.outcome === 'parentDeclined' ? (
                <Trans>A parent needs to approve Horizon</Trans>
              ) : (
                <Trans>Horizon is for people 13 and older</Trans>
              )}
            </H1>

            <View style={[a.gap_lg]}>
              {check?.outcome === 'parentDeclined' ? (
                <Text style={textStyles}>
                  <Trans>
                    A parent or guardian declined Horizon’s latest update in
                    Google Play. Ask them to approve it there, then check
                    again.
                  </Trans>
                </Text>
              ) : (
                <Text style={textStyles}>
                  <Trans>
                    Google Play says you’re under 13, so Horizon can’t be used
                    on this phone. If that’s wrong, update your age in Google
                    Play, then check again.
                  </Trans>
                </Text>
              )}
              <Text style={[textStyles, t.atoms.text_contrast_medium]}>
                <Trans>
                  Apps in {state} must follow the age a phone’s app store
                  reports.
                </Trans>
              </Text>
            </View>

            <View style={[a.gap_md]}>
              <Button
                label={l`Check my age again`}
                size="large"
                color="primary"
                disabled={checking}
                onPress={() => void checkAgeAgain({prompt: true})}>
                {checking && <ButtonIcon icon={Loader} />}
                <ButtonText>
                  <Trans>Check again</Trans>
                </ButtonText>
              </Button>
              <Button
                label={l`Open Horizon in Google Play`}
                size="large"
                color="secondary"
                onPress={() => void openInStore()}>
                <ButtonText>
                  <Trans>Open Google Play</Trans>
                </ButtonText>
              </Button>
              {hasSession && (
                <Button
                  label={l`Sign out`}
                  size="large"
                  color="secondary"
                  onPress={() =>
                    logoutCurrentAccount('AgeAssuranceNoAccessScreen')
                  }>
                  <ButtonText>
                    <Trans>Sign out</Trans>
                  </ButtonText>
                </Button>
              )}
            </View>
          </View>
        </ScrollView>
      </View>

      {/* Other dialogs aren't mounted while this screen is up. */}
      <BottomSheetOutlet />
      <PortalOutlet />
    </>
  )
}
