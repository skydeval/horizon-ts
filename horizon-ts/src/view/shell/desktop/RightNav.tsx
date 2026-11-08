import {useEffect, useState} from 'react'
import {View} from 'react-native'
import {msg} from '@lingui/core/macro'
import {useLingui} from '@lingui/react'
import {Trans} from '@lingui/react/macro'
import {useNavigation} from '@react-navigation/native'

import {useSession} from '#/state/session'
import {useLogoVariant} from '#/view/icons/useLogoVariant'
import {DesktopFeeds} from '#/view/shell/desktop/Feeds'
import {DesktopSearch} from '#/view/shell/desktop/Search'
import {SidebarTrendingTopics} from '#/view/shell/desktop/SidebarTrendingTopics'
import {
  atoms as a,
  useGutters,
  useLayoutBreakpoints,
  useTheme,
  web,
} from '#/alf'
import {AppLanguageDropdown} from '#/components/AppLanguageDropdown'
import {useDialogControl} from '#/components/Dialog'
import {useInteractionState} from '#/components/hooks/useInteractionState'
import {CENTER_COLUMN_OFFSET} from '#/components/Layout'
import {InlineLinkText} from '#/components/Link'
import {ProgressGuideList} from '#/components/ProgressGuide/List'
import {Text} from '#/components/Typography'
import {SidebarLiveEventFeedsBanner} from '#/features/liveEvents/components/SidebarLiveEventFeedsBanner'
// HORIZON: the rail scrolls as a whole under cards (Phase 3, rail fix)
import {useActiveBackdrop} from '#/horizon/backdrops/active'
// HORIZON: frosted rail cards over the backdrop (Phase 3)
import {
  RAIL_CARD_ROOM,
  RAIL_SCROLL_STYLE,
  RailCard,
} from '#/horizon/backdrops/RailCard'
// HORIZON: Horizon's own feedback form
import {FeedbackDialog} from '#/horizon/feedback/FeedbackDialog'
// HORIZON: Horizon's own support, privacy and terms pages
import {
  HORIZON_PRIVACY_URL,
  HORIZON_SUPPORT_URL,
  HORIZON_TERMS_URL,
} from '#/horizon/support/links'

/** Looks like the footer's links, but is a button: it opens a dialog. */
function FeedbackTextButton({
  label,
  onPress,
}: {
  label: string
  onPress: () => void
}) {
  const t = useTheme()
  const {state: interacted, onIn, onOut} = useInteractionState()
  return (
    <Text
      testID="rightNavFeedback"
      role="button"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint=""
      tabIndex={0}
      onPress={onPress}
      onFocus={onIn}
      onBlur={onOut}
      {...web({
        onMouseEnter: onIn,
        onMouseLeave: onOut,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onPress()
          }
        },
      })}
      style={[
        t.atoms.text_contrast_medium,
        web({cursor: 'pointer'}),
        interacted &&
          web({
            outline: 0,
            textDecorationLine: 'underline',
          }),
      ]}>
      {label}
    </Text>
  )
}

function useWebQueryParams() {
  const navigation = useNavigation()
  const [params, setParams] = useState<Record<string, string>>({})

  useEffect(() => {
    return navigation.addListener('state', e => {
      try {
        const {state} = e.data
        const lastRoute = state.routes[state.routes.length - 1]
        setParams(lastRoute.params)
      } catch (err) {}
    })
  }, [navigation, setParams])

  return params
}

export function DesktopRightNav({routeName}: {routeName: string}) {
  const t = useTheme()
  const {_} = useLingui()
  const {hasSession} = useSession()
  // HORIZON: Horizon's own feedback form
  const feedbackControl = useDialogControl()
  const logoVariant = useLogoVariant()
  const gutters = useGutters(['base', 0, 'base', 'wide'])
  const isSearchScreen = routeName === 'Search'
  const isMessagesRelatedScreen = routeName.startsWith('Messages')
  const webqueryParams = useWebQueryParams()
  const searchQuery = webqueryParams?.q
  const showExploreScreenDuplicatedContent =
    !isSearchScreen || (isSearchScreen && !!searchQuery)
  const {rightNavVisible, centerColumnOffset, leftNavMinimal} =
    useLayoutBreakpoints()
  // HORIZON: cards drawn (Phase 3, rail fix)
  const hasCards = useActiveBackdrop() !== null

  if (!rightNavVisible || isMessagesRelatedScreen) {
    return null
  }

  const width = centerColumnOffset ? 250 : 300

  return (
    <View
      style={[
        gutters,
        a.gap_lg,
        a.pr_2xs,
        web({
          position: 'fixed',
          left: '50%',
          transform: [
            {
              translateX: 300 + (centerColumnOffset ? CENTER_COLUMN_OFFSET : 0),
            },
            ...a.scrollbar_offset.transform,
          ],
          /**
           * Compensate for the right padding above (2px) to retain intended width.
           */
          width: width + gutters.paddingLeft + 2,
          maxHeight: '100vh',
        }),
        // HORIZON: the rail's own scroll under cards (Phase 3, rail fix)
        hasCards && web(RAIL_SCROLL_STYLE),
        // HORIZON: room on the right for the cards' outset edges, content unmoved (change list 2)
        hasCards &&
          web({
            paddingRight: 2 + RAIL_CARD_ROOM,
            width: width + gutters.paddingLeft + 2 + RAIL_CARD_ROOM,
          }),
      ]}>
      {/* HORIZON: the search card (Phase 3, BD-7) */}
      {!isSearchScreen && (
        <RailCard>
          <DesktopSearch />
        </RailCard>
      )}

      {hasSession && (
        <>
          <DesktopFeeds />
          <ProgressGuideList />
        </>
      )}

      {showExploreScreenDuplicatedContent && <SidebarLiveEventFeedsBanner />}
      {showExploreScreenDuplicatedContent && <SidebarTrendingTopics />}

      {/* HORIZON: start of the footer card (Phase 3, BD-8) */}
      <RailCard variant="footer">
        <Text style={[a.leading_snug, t.atoms.text_contrast_low]}>
          {hasSession && (
            <>
              {/* HORIZON: opens Horizon's own feedback form */}
              <FeedbackTextButton
                label={_(msg`Feedback`)}
                onPress={() => feedbackControl.open()}
              />
              <Text style={[t.atoms.text_contrast_low]}>{' ∙ '}</Text>
            </>
          )}
          <InlineLinkText
            // HORIZON: Horizon's own privacy policy
            to={HORIZON_PRIVACY_URL}
            style={[t.atoms.text_contrast_medium]}
            label={_(msg`Privacy`)}>
            {_(msg`Privacy`)}
          </InlineLinkText>
          <Text style={[t.atoms.text_contrast_low]}>{' ∙ '}</Text>
          <InlineLinkText
            // HORIZON: Horizon's own terms
            to={HORIZON_TERMS_URL}
            style={[t.atoms.text_contrast_medium]}
            label={_(msg`Terms`)}>
            {_(msg`Terms`)}
          </InlineLinkText>
          <Text style={[t.atoms.text_contrast_low]}>{' ∙ '}</Text>
          <InlineLinkText
            label={_(msg`Help`)}
            // HORIZON: Horizon's own support page
            to={HORIZON_SUPPORT_URL}
            style={[t.atoms.text_contrast_medium]}>
            {_(msg`Help`)}
          </InlineLinkText>
        </Text>
        {/* HORIZON: end of the footer card (Phase 3, BD-8) */}
      </RailCard>
      {hasSession && <FeedbackDialog control={feedbackControl} />}

      {logoVariant === 'kawaii' && (
        <Text style={[t.atoms.text_contrast_medium, {marginTop: 12}]}>
          <Trans>
            Logo by{' '}
            <InlineLinkText
              label={_(msg`Logo by @sawaratsuki.bsky.social`)}
              to="/profile/sawaratsuki.bsky.social">
              @sawaratsuki.bsky.social
            </InlineLinkText>
          </Trans>
        </Text>
      )}

      {!hasSession && leftNavMinimal && (
        <View style={[a.w_full, {height: 32}]}>
          <AppLanguageDropdown />
        </View>
      )}
    </View>
  )
}
