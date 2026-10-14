import {useMemo} from 'react'
// HORIZON: the commissioned illustration is not covered by MIT and was removed, with its RNImage and Image imports
import {View} from 'react-native'
import Animated, {FadeIn, FadeOut} from 'react-native-reanimated'
import {msg} from '@lingui/core/macro'
import {useLingui} from '@lingui/react'
import {Trans} from '@lingui/react/macro'

import {useHaptics} from '#/lib/haptics'
import {Logo} from '#/view/icons/Logo'
import {Logotype} from '#/view/icons/Logotype'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
// HORIZON: the commissioned illustration is not covered by MIT and was removed

export const SplashScreen = ({
  onPressSignin,
  onPressCreateAccount,
}: {
  onPressSignin: () => void
  onPressCreateAccount: () => void
}) => {
  const t = useTheme()
  const {_} = useLingui()
  const isDarkMode = t.name !== 'light'

  const haptics = useHaptics()

  const styles = useMemo(() => {
    const logoFill = isDarkMode ? 'white' : t.palette.primary_500
    return {
      logoFill,
      logoShadow: isDarkMode
        ? [
            {
              shadowColor: logoFill,
              shadowRadius: 8,
              shadowOpacity: 0.5,
              shadowOffset: {
                width: 0,
                height: 0,
              },
            },
          ]
        : [],
    }
  }, [t, isDarkMode])

  return (
    <>
      {/* HORIZON: the commissioned illustration is not covered by MIT and was removed */}
      <Animated.View
        entering={FadeIn.duration(90)}
        exiting={FadeOut.duration(90)}
        style={[a.flex_1]}>
        <View
          style={[a.justify_center, a.align_center, {gap: 6, paddingTop: 46}]}>
          <Logo width={76} fill={styles.logoFill} style={styles.logoShadow} />
          <Logotype
            width={91}
            fill={styles.logoFill}
            style={styles.logoShadow}
          />
        </View>

        <View style={[a.flex_1]} />

        <View
          testID="signinOrCreateAccount"
          style={[a.px_5xl, a.gap_md, a.pb_sm]}>
          <Button
            testID="createAccountButton"
            onPress={() => {
              onPressCreateAccount()
              haptics.tap()
            }}
            label={_(msg`Create new account`)}
            accessibilityHint={_(
              msg`Opens flow to create a new Bluesky account`,
            )}
            size="large"
            color={isDarkMode ? 'secondary_inverted' : 'secondary'}
            style={[
              {
                shadowColor: t.palette.black,
                shadowRadius: 8,
                shadowOpacity: 0.1,
                shadowOffset: {
                  width: 0,
                  height: 5,
                },
                elevation: 16,
              },
            ]}>
            <ButtonText>
              <Trans>Create account</Trans>
            </ButtonText>
          </Button>

          <Button
            testID="signInButton"
            onPress={() => {
              onPressSignin()
              haptics.tap()
            }}
            label={_(msg`Sign in`)}
            accessibilityHint={_(
              msg`Opens flow to sign in to your existing Bluesky account`,
            )}
            size="large"
            hoverStyle={{opacity: 0.5}}>
            <ButtonText style={{color: 'white'}}>
              <Trans>Sign in</Trans>
            </ButtonText>
          </Button>
        </View>
      </Animated.View>
    </>
  )
}
