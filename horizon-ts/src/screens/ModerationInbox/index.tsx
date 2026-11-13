import {useCallback, useEffect, useRef, useState} from 'react'
import {type ListRenderItemInfo, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'
import {
  type RouteProp,
  useFocusEffect,
  useNavigation,
  useRoute,
} from '@react-navigation/native'

import {
  type CommonNavigatorParams,
  type NavigationProp,
} from '#/lib/routes/types'
import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {
  useModerationInboxAccountStatusQuery,
  useModerationInboxActionedSubjectsQuery,
  useModerationInboxReportsQuery,
  useModerationInboxUnreadCountQuery,
  useUpdateModerationInboxSeenMutation,
} from '#/state/queries/moderation-inbox'
import {Pager, type PagerRef} from '#/view/com/pager/Pager'
import {TabBar} from '#/view/com/pager/TabBar'
import {EmptyState} from '#/view/com/util/EmptyState'
import {List} from '#/view/com/util/List'
import {NotFoundScreen} from '#/view/screens/NotFound'
import {atoms as a, useTheme} from '#/alf'
import {ButtonIcon} from '#/components/Button'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import {Inbox_Stroke2_Corner2_Rounded_Large as InboxIcon} from '#/components/icons/Inbox'
import {SettingsGear2_Stroke2_Corner0_Rounded as SettingsIcon} from '#/components/icons/Settings'
import * as Layout from '#/components/Layout'
import {createStaticClick, Link, SimpleInlineLinkText} from '#/components/Link'
import {ListFooter} from '#/components/Lists'
import {Loader} from '#/components/Loader'
import {useAnalytics} from '#/analytics'
// HORIZON: the operator's cairn instance's reports
import {
  useCairnInboxReportsQuery,
  useCairnInboxUnreadReportsQuery,
  useMarkCairnReportsSeenMutation,
} from '#/horizon/cairn/inbox'
import {useCairnPrimaryLabeler} from '#/horizon/cairn/primary-labeler'
import {isKryphocronReport} from '#/horizon/report/kryphocron-report'
import {type tools} from '#/lexicons'
import {AccountStatus} from './components/AccountStatus'
import {FilterMenu} from './components/FilterMenu'
import {type ActionedSubject} from './components/hooks/useActionedSubjectLabels'
import {YourAccountRow} from './components/YourAccountRow'
import {YourReportRow} from './components/YourReportRow'

type ReportFilter = 'all' | 'pending' | 'resolved' | 'unread'
type InboxReport = tools.ozone.inbox.listReports.$OutputBody['reports'][number]
// HORIZON: which of the user's reports Your reports shows
type ReportScope = 'public' | 'private'

/** HORIZON: reports from two moderation services, newest first. */
function mergeReports(first: InboxReport[], second: InboxReport[]) {
  if (!second.length) return first
  return [...first, ...second].sort(
    (x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt),
  )
}

export function ModerationInboxScreen() {
  const {t: l} = useLingui()
  const ax = useAnalytics()
  const navigation =
    useNavigation<NavigationProp<CommonNavigatorParams, 'ModerationInbox'>>()
  const route = useRoute<RouteProp<CommonNavigatorParams, 'ModerationInbox'>>()
  const routeTab = route.params?.tab ?? 'reports'
  const initialPage = routeTab === 'account' ? 1 : 0
  const pagerRef = useRef<PagerRef>(null)
  const currentPage = useRef(initialPage)

  useEffect(() => {
    const page = routeTab === 'account' ? 1 : 0
    if (currentPage.current !== page) {
      currentPage.current = page
      pagerRef.current?.setPage(page)
    }
  }, [routeTab])

  const onPageSelected = (index: number) => {
    currentPage.current = index
    navigation.setParams({tab: index === 1 ? 'account' : 'reports'})
  }

  const isEnabled = ax.features.enabled(ax.features.ModerationInboxEnable)
  const unreadCountQuery = useModerationInboxUnreadCountQuery(isEnabled)
  const unreadCounts = unreadCountQuery.data?.unreadCounts
  // HORIZON: the cairn instance's unread reports count too
  const cairnUnread = useCairnInboxUnreadReportsQuery()

  useFocusEffect(
    useCallback(() => {
      if (isEnabled) {
        ax.metric('moderation:inbox:view', {tab: routeTab})
      }
    }, [ax, isEnabled, routeTab]),
  )

  if (!isEnabled) {
    return <NotFoundScreen />
  }

  return (
    <Layout.Screen testID="moderationInboxScreen">
      <Pager
        ref={pagerRef}
        testID="moderationInboxPager"
        initialPage={initialPage}
        onPageSelected={onPageSelected}
        renderTabBar={props => (
          <Layout.Center>
            <Layout.Header.Outer noBottomBorder>
              <Layout.Header.BackButton />
              <Layout.Header.Content align="left">
                <Layout.Header.TitleText>
                  <Trans>Moderation inbox</Trans>
                </Layout.Header.TitleText>
              </Layout.Header.Content>
              <Layout.Header.Slot>
                <Link
                  testID="moderationInboxSettingsBtn"
                  to={{screen: 'ModerationInboxSettings'}}
                  label={l`Moderation inbox settings`}
                  size="small"
                  variant="ghost"
                  color="secondary"
                  shape="round"
                  style={[a.justify_center]}>
                  <ButtonIcon icon={SettingsIcon} size="lg" />
                </Link>
              </Layout.Header.Slot>
            </Layout.Header.Outer>
            <TabBar
              testID="moderationInboxTabs"
              items={[l`Your reports`, l`Your account`]}
              unread={[
                (unreadCounts?.reports ?? 0) + (cairnUnread.data ?? 0) > 0,
                (unreadCounts?.subjects ?? 0) +
                  (unreadCounts?.accountStatus ?? 0) >
                  0,
              ]}
              align="left"
              {...props}
            />
          </Layout.Center>
        )}>
        <YourReports />
        <YourAccount />
      </Pager>
    </Layout.Screen>
  )
}

function YourReports() {
  const t = useTheme()
  const {t: l} = useLingui()
  const ax = useAnalytics()

  const [isPTRing, setIsPTRing] = useState(false)
  const [filter, setFilter] = useState<ReportFilter>('all')
  const reportsQuery = useModerationInboxReportsQuery(filter)
  const unreadCountQuery = useModerationInboxUnreadCountQuery()
  const markSeen = useUpdateModerationInboxSeenMutation()
  /*
   * HORIZON: with an operator cairn instance, Public (Bluesky's reports and
   * cairn's public ones) and Private (cairn's reports on kryphocron posts)
   * (start)
   */
  const cairnPrimary = useCairnPrimaryLabeler()
  const [scope, setScope] = useState<ReportScope>('public')
  const cairnQuery = useCairnInboxReportsQuery(filter)
  const cairnUnread = useCairnInboxUnreadReportsQuery()
  const markCairnSeen = useMarkCairnReportsSeenMutation()
  const showPrivate = !!cairnPrimary && scope === 'private'
  const cairnReports = cairnPrimary
    ? (cairnQuery.data?.pages.flatMap(page => page.reports) ?? [])
    : []
  const bskyReports =
    reportsQuery.data?.pages.flatMap(page => page.reports) ?? []
  const reports = showPrivate
    ? cairnReports.filter(isKryphocronReport)
    : mergeReports(
        bskyReports,
        cairnReports.filter(report => !isKryphocronReport(report)),
      )
  const listQuery = showPrivate ? cairnQuery : reportsQuery
  const hasUnread =
    (unreadCountQuery.data?.unreadCounts.reports ?? 0) > 0 ||
    (cairnUnread.data ?? 0) > 0
  const isLoading =
    listQuery.isLoading || (!!cairnPrimary && cairnQuery.isLoading)
  const isEmpty =
    listQuery.data !== undefined && reports.length === 0 && !listQuery.error
  const hideFilterMenu = isEmpty && filter === 'all' && !cairnPrimary

  const onRefresh = async () => {
    setIsPTRing(true)
    try {
      await Promise.all([
        reportsQuery.refetch(),
        unreadCountQuery.refetch(),
        ...(cairnPrimary ? [cairnQuery.refetch(), cairnUnread.refetch()] : []),
      ])
    } catch (err) {
      logger.error('Failed to refresh moderation inbox reports', {error: err})
    } finally {
      setIsPTRing(false)
    }
  }

  const onEndReached = async () => {
    const queries = showPrivate
      ? [cairnQuery]
      : cairnPrimary
        ? [reportsQuery, cairnQuery]
        : [reportsQuery]
    try {
      await Promise.all(
        queries
          .filter(
            query =>
              !query.isFetchingNextPage && query.hasNextPage && !query.error,
          )
          .map(query => query.fetchNextPage()),
      )
    } catch (err) {
      logger.error('Failed to load more moderation inbox reports', {
        error: err,
      })
    }
  }
  // HORIZON: Public and Private (end)

  const listHeader = (
    <Layout.Center>
      {/* HORIZON: Public and Private under Your reports (start) */}
      {cairnPrimary ? (
        <View style={[a.px_lg, a.pt_md]}>
          <SegmentedControl.Root
            type="tabs"
            label={l`Which reports`}
            value={scope}
            onChange={setScope}>
            <SegmentedControl.Item
              testID="moderationInboxPublicReports"
              value="public"
              label={l`Public`}>
              <SegmentedControl.ItemText>{l`Public`}</SegmentedControl.ItemText>
            </SegmentedControl.Item>
            <SegmentedControl.Item
              testID="moderationInboxPrivateReports"
              value="private"
              label={l`Private`}>
              <SegmentedControl.ItemText>
                {l`Private`}
              </SegmentedControl.ItemText>
            </SegmentedControl.Item>
          </SegmentedControl.Root>
        </View>
      ) : null}
      {/* HORIZON: Public and Private under Your reports (end) */}
      <View
        style={[
          a.flex_row,
          a.align_center,
          a.justify_between,
          a.gap_lg,
          a.px_lg,
          a.py_sm,
          a.border_b,
          t.atoms.border_contrast_low,
          {minHeight: 48},
        ]}>
        <FilterMenu tab="reports" filter={filter} setFilter={setFilter} />
        {hasUnread ? (
          <SimpleInlineLinkText
            label={l`Mark all reports as read`}
            style={[a.text_md, t.atoms.text]}
            {...createStaticClick(() => {
              ax.metric('moderation:inbox:markAllAsRead', {tab: 'reports'})
              markSeen.mutate({sections: ['reports']})
              // HORIZON: and the cairn instance's
              if (cairnPrimary) markCairnSeen.mutate()
            })}>
            <Trans>Mark all as read</Trans>
          </SimpleInlineLinkText>
        ) : undefined}
      </View>
    </Layout.Center>
  )

  return (
    <List
      data={reports}
      // HORIZON: ids are per moderation service
      keyExtractor={(report: InboxReport) => `${report.src}:${report.id}`}
      refreshing={isPTRing}
      onRefresh={() => void onRefresh()}
      renderItem={({item}: ListRenderItemInfo<InboxReport>) => (
        <YourReportRow report={item} />
      )}
      ListHeaderComponent={hideFilterMenu || isLoading ? undefined : listHeader}
      ListEmptyComponent={
        isLoading ? (
          <View style={[a.flex_1, a.align_center, a.justify_center]}>
            <Loader size="xl" />
          </View>
        ) : isEmpty ? (
          <InboxEmptyState
            message={
              filter !== 'all'
                ? l`No reports match this filter`
                : showPrivate
                  ? l`Nothing reported here yet`
                  : l`You haven’t reported anything yet`
            }
          />
        ) : undefined
      }
      contentContainerStyle={isEmpty || isLoading ? a.flex_grow : undefined}
      ListFooterComponent={
        <ListFooter
          style={a.border_t_0}
          isFetchingNextPage={listQuery.isFetchingNextPage}
          hasNextPage={listQuery.hasNextPage}
          error={cleanError(listQuery.error)}
          onRetry={listQuery.fetchNextPage}
        />
      }
      onEndReached={() => void onEndReached()}
      onEndReachedThreshold={4}
      desktopFixedHeight
      sideBorders={false}
    />
  )
}

function YourAccount() {
  const t = useTheme()
  const {t: l} = useLingui()
  const ax = useAnalytics()

  const [isPTRing, setIsPTRing] = useState(false)
  const [filter, setFilter] = useState<ReportFilter>('all')
  const actionedSubjectsQuery = useModerationInboxActionedSubjectsQuery(filter)
  const accountStatusQuery = useModerationInboxAccountStatusQuery()
  const unreadCountQuery = useModerationInboxUnreadCountQuery()
  const markSeen = useUpdateModerationInboxSeenMutation()
  const accountStanding = getKnownAccountStanding(
    accountStatusQuery.data?.standing,
  )
  const subjects =
    actionedSubjectsQuery.data?.pages.flatMap(page => page.subjects) ?? []
  const isLoading = actionedSubjectsQuery.isLoading
  const isEmpty =
    actionedSubjectsQuery.data !== undefined &&
    subjects.length === 0 &&
    !actionedSubjectsQuery.error
  const hideFilterMenu = isEmpty && filter === 'all'
  const unreadCounts = unreadCountQuery.data?.unreadCounts
  const hasUnread =
    (unreadCounts?.subjects ?? 0) + (unreadCounts?.accountStatus ?? 0) > 0

  const onRefresh = async () => {
    setIsPTRing(true)
    try {
      await Promise.all([
        actionedSubjectsQuery.refetch(),
        accountStatusQuery.refetch(),
        unreadCountQuery.refetch(),
      ])
    } catch (err) {
      logger.error('Failed to refresh moderation inbox account', {error: err})
    } finally {
      setIsPTRing(false)
    }
  }

  const onEndReached = async () => {
    if (
      actionedSubjectsQuery.isFetchingNextPage ||
      !actionedSubjectsQuery.hasNextPage ||
      actionedSubjectsQuery.error
    ) {
      return
    }
    try {
      await actionedSubjectsQuery.fetchNextPage()
    } catch (err) {
      logger.error('Failed to load more moderation inbox actions', {
        error: err,
      })
    }
  }

  const listHeader = (
    <Layout.Center>
      {!hideFilterMenu ? (
        <View
          style={[
            a.flex_row,
            a.align_center,
            a.justify_between,
            a.gap_lg,
            a.px_lg,
            a.py_sm,
            a.border_b,
            t.atoms.border_contrast_low,
            {minHeight: 48},
          ]}>
          <FilterMenu tab="account" filter={filter} setFilter={setFilter} />
          {hasUnread ? (
            <SimpleInlineLinkText
              label={l`Mark all actions as read`}
              style={[a.text_md, t.atoms.text]}
              {...createStaticClick(() => {
                ax.metric('moderation:inbox:markAllAsRead', {tab: 'account'})
                markSeen.mutate({sections: ['subjects', 'accountStatus']})
              })}>
              <Trans>Mark all as read</Trans>
            </SimpleInlineLinkText>
          ) : undefined}
        </View>
      ) : undefined}
      {accountStanding ? <AccountStatus status={accountStanding} /> : undefined}
    </Layout.Center>
  )

  return (
    <List
      data={subjects}
      keyExtractor={getActionedSubjectKey}
      refreshing={isPTRing}
      onRefresh={() => void onRefresh()}
      renderItem={({item}: ListRenderItemInfo<ActionedSubject>) => (
        <Layout.Center>
          <YourAccountRow item={item} unread={!item.isRead} />
        </Layout.Center>
      )}
      ListHeaderComponent={listHeader}
      ListEmptyComponent={
        isLoading ? (
          <View style={[a.flex_1, a.align_center, a.justify_center]}>
            <Loader size="xl" />
          </View>
        ) : isEmpty ? (
          <InboxEmptyState
            message={
              filter === 'all'
                ? l`No actions against you`
                : l`No actions match this filter`
            }
          />
        ) : undefined
      }
      contentContainerStyle={isEmpty || isLoading ? a.flex_grow : undefined}
      ListFooterComponent={
        <ListFooter
          style={a.border_t_0}
          isFetchingNextPage={actionedSubjectsQuery.isFetchingNextPage}
          hasNextPage={actionedSubjectsQuery.hasNextPage}
          error={cleanError(actionedSubjectsQuery.error)}
          onRetry={actionedSubjectsQuery.fetchNextPage}
        />
      }
      onEndReached={() => void onEndReached()}
      onEndReachedThreshold={4}
      desktopFixedHeight
      sideBorders={false}
    />
  )
}

function InboxEmptyState({message}: {message: string}) {
  const t = useTheme()

  return (
    <EmptyState
      icon={InboxIcon}
      iconSize="4xl"
      iconColor={t.atoms.text_contrast_medium.color}
      message={message}
      textStyle={[t.atoms.text_contrast_medium, a.font_medium]}
      style={[a.flex_1, a.justify_center]}
    />
  )
}

function getActionedSubjectKey(item: ActionedSubject) {
  if ('did' in item.subject) return item.subject.did
  if ('uri' in item.subject) return item.subject.uri
  return `${item.src}:${item.latestAction?.id ?? item.createdAt}`
}

function getKnownAccountStanding(standing?: string) {
  switch (standing) {
    case 'good':
    case 'warning':
    case 'atRisk':
      return standing
    default:
      return undefined
  }
}
