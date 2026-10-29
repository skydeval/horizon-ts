import {View} from 'react-native'
import Animated from 'react-native-reanimated'
import {useSafeAreaInsets} from 'react-native-safe-area-context'
import {msg} from '@lingui/core/macro'
import {useLingui} from '@lingui/react'
import {useNavigation} from '@react-navigation/native'

import {HITSLOP_10} from '#/lib/constants'
import {PressableScale} from '#/lib/custom-animations/PressableScale'
import {useHaptics} from '#/lib/haptics'
import {type NavigationProp} from '#/lib/routes/types'
import {emitSoftReset} from '#/state/events'
import {useSession} from '#/state/session'
import {useShellHeaderLayout} from '#/state/shell/shell-layout'
import {useHomeHeaderTransform} from '#/view/com/util/MainScrollProvider'
import {Logo} from '#/view/icons/Logo'
import {atoms as a, useTheme} from '#/alf'
import {ButtonIcon} from '#/components/Button'
import {Hashtag_Stroke2_Corner0_Rounded as FeedsIcon} from '#/components/icons/Hashtag'
import * as Layout from '#/components/Layout'
import {Link} from '#/components/Link'
import {useAnalytics} from '#/analytics'
import {IS_DEV, IS_LIQUID_GLASS} from '#/env'
// HORIZON: the halo on a bare window, in the app (Android app)
import {BarHaloScope} from '#/horizon/backdrops/BarHalo'
// HORIZON: the logo's shade on a bare window (Phase 3)
import {BarShade} from '#/horizon/backdrops/BarShade'
// HORIZON: the inner row's sticky value under the window (Phase 3)
import {horizonInnerHeaderSticky} from '#/horizon/backdrops/frame'
// HORIZON: the Home header's compact frame window (Phase 3)
import {FrameWindow} from '#/horizon/backdrops/FrameWindow'

export function HomeHeaderLayoutMobile({
  children,
}: {
  children: React.ReactNode
  tabBarAnchor: React.ReactElement | null | undefined
}) {
  const t = useTheme()
  const {_} = useLingui()
  const ax = useAnalytics()
  const {onLayout} = useShellHeaderLayout()
  const insets = useSafeAreaInsets()
  const headerMinimalShellTransform = useHomeHeaderTransform()
  const {hasSession} = useSession()
  const haptics = useHaptics()
  const {navigate} = useNavigation<NavigationProp>()

  return (
    <Animated.View
      style={[
        a.fixed,
        a.z_10,
        t.atoms.bg,
        {
          top: 0,
          left: 0,
          right: 0,
        },
        IS_LIQUID_GLASS && {paddingTop: insets.top},
        headerMinimalShellTransform,
      ]}
      onLayout={onLayout}>
      {/* HORIZON: the logo row and feed tabs on one window (Phase 3, BD-12) */}
      <FrameWindow kind="homeHeader" />
      {/* HORIZON: the halo on a bare window, in the app (Android app) */}
      <BarHaloScope piece="homeHeader">
        {/* HORIZON: not sticky, so the row shows the wrapper's window (Phase 3, BD-13) */}
        <Layout.Header.Outer noBottomBorder sticky={horizonInnerHeaderSticky()}>
          <Layout.Header.Slot>
            <Layout.Header.MenuButton />
          </Layout.Header.Slot>

          <View style={[a.flex_1, a.align_center]}>
            <PressableScale
              targetScale={0.9}
              onPress={() => {
                if (IS_DEV) {
                  navigate('Debug')
                } else {
                  haptics.tap()
                  emitSoftReset()
                }
              }}>
              {/* HORIZON: the logo's shade on a bare window (Phase 3) */}
              <BarShade kind="logo" />
              <Logo width={30} />
            </PressableScale>
          </View>

          <Layout.Header.Slot>
            {hasSession && (
              <Link
                testID="viewHeaderHomeFeedPrefsBtn"
                to={{screen: 'Feeds'}}
                hitSlop={HITSLOP_10}
                label={_(msg`View your feeds and explore more`)}
                size="small"
                variant="ghost"
                color="secondary"
                shape="square"
                onPress={() => {
                  ax.metric('nav:click', {item: 'feeds', surface: 'topBar'})
                }}
                style={[
                  a.justify_center,
                  {marginRight: -Layout.BUTTON_VISUAL_ALIGNMENT_OFFSET},
                  a.bg_transparent,
                ]}>
                <ButtonIcon icon={FeedsIcon} size="lg" />
              </Link>
            )}
          </Layout.Header.Slot>
        </Layout.Header.Outer>
        {children}
      </BarHaloScope>
    </Animated.View>
  )
}
