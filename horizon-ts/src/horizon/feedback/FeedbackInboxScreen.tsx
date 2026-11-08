/*
 * Settings > Feedback: the reports people sent, newest first, for the
 * accounts on the push service's admin list. Each shows its kind, sender,
 * time, text and any technical details, with Mark done / Reopen.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {
  type CommonNavigatorParams,
  type NativeStackScreenProps,
} from '#/lib/routes/types'
import {useProfileQuery} from '#/state/queries/profile'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {atoms as a, useTheme} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import * as Layout from '#/components/Layout'
import {InlineLinkText} from '#/components/Link'
import {Loader} from '#/components/Loader'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {type FeedbackReport} from '#/horizon/feedback/api'
import {
  type FeedbackFilter,
  useFeedbackAdminQuery,
  useFeedbackInboxQuery,
  useMarkFeedbackMutation,
} from '#/horizon/feedback/queries'

type Props = NativeStackScreenProps<CommonNavigatorParams, 'FeedbackInbox'>
export function FeedbackInboxScreen({}: Props) {
  const t = useTheme()
  const {t: l} = useLingui()
  const [filter, setFilter] = useState<FeedbackFilter>('open')
  const admin = useFeedbackAdminQuery()
  const inbox = useFeedbackInboxQuery(filter)
  const reports = inbox.data?.pages.flatMap(page => page.reports) ?? []

  return (
    <Layout.Screen>
      <Layout.Header.Outer>
        <Layout.Header.BackButton />
        <Layout.Header.Content>
          <Layout.Header.TitleText>
            <Trans>Feedback</Trans>
          </Layout.Header.TitleText>
        </Layout.Header.Content>
        <Layout.Header.Slot />
      </Layout.Header.Outer>
      <Layout.Content>
        <SettingsList.Container>
          {admin.data === false ? (
            <View style={[a.px_xl, a.pt_md]}>
              <Admonition type="info">
                <Trans>Only Horizon’s team can read feedback.</Trans>
              </Admonition>
            </View>
          ) : (
            <View style={[a.px_xl, a.pt_md, a.gap_lg]}>
              <SegmentedControl.Root
                type="tabs"
                label={l`Which feedback to show`}
                value={filter}
                onChange={setFilter}>
                <SegmentedControl.Item
                  testID="feedbackFilterOpen"
                  value="open"
                  label={l({message: 'Open', comment: 'Feedback not yet handled'})}>
                  <SegmentedControl.ItemText>
                    {l({message: 'Open', comment: 'Feedback not yet handled'})}
                  </SegmentedControl.ItemText>
                </SegmentedControl.Item>
                <SegmentedControl.Item
                  testID="feedbackFilterDone"
                  value="done"
                  label={l({message: 'Done', comment: 'Feedback handled'})}>
                  <SegmentedControl.ItemText>
                    {l({message: 'Done', comment: 'Feedback handled'})}
                  </SegmentedControl.ItemText>
                </SegmentedControl.Item>
                <SegmentedControl.Item
                  testID="feedbackFilterAll"
                  value="all"
                  label={l({message: 'All', comment: 'All feedback'})}>
                  <SegmentedControl.ItemText>
                    {l({message: 'All', comment: 'All feedback'})}
                  </SegmentedControl.ItemText>
                </SegmentedControl.Item>
              </SegmentedControl.Root>

              {inbox.isLoading ? (
                <View style={[a.align_center, a.py_xl]}>
                  <Loader size="lg" />
                </View>
              ) : inbox.isError ? (
                <Admonition type="error">
                  <Trans>Feedback couldn’t be loaded.</Trans>
                </Admonition>
              ) : reports.length === 0 ? (
                <Text
                  style={[
                    a.text_md,
                    a.leading_snug,
                    a.py_lg,
                    t.atoms.text_contrast_medium,
                  ]}>
                  {filter === 'open' ? (
                    <Trans>Nothing open. All caught up.</Trans>
                  ) : (
                    <Trans>No feedback here yet.</Trans>
                  )}
                </Text>
              ) : (
                <View style={[a.gap_md, a.pb_xl]}>
                  {reports.map(report => (
                    <ReportCard key={report.id} report={report} />
                  ))}
                  {inbox.hasNextPage ? (
                    <Button
                      testID="feedbackLoadMore"
                      label={l`Load more feedback`}
                      color="secondary"
                      size="small"
                      style={[a.self_center]}
                      disabled={inbox.isFetchingNextPage}
                      onPress={() => void inbox.fetchNextPage()}>
                      <ButtonText>
                        <Trans>Load more</Trans>
                      </ButtonText>
                      {inbox.isFetchingNextPage ? (
                        <ButtonIcon icon={Loader} />
                      ) : null}
                    </Button>
                  ) : null}
                </View>
              )}
            </View>
          )}
        </SettingsList.Container>
      </Layout.Content>
    </Layout.Screen>
  )
}

function ReportCard({report}: {report: FeedbackReport}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const {data: profile} = useProfileQuery({did: report.did})
  const mark = useMarkFeedbackMutation()
  const sender = profile?.handle ? `@${profile.handle}` : report.did
  const kind =
    report.kind === 'bug'
      ? l({message: 'Bug', comment: 'Feedback kind: something broken'})
      : report.kind === 'idea'
        ? l({message: 'Idea', comment: 'Feedback kind: a suggestion'})
        : l({message: 'Other', comment: 'Feedback kind: anything else'})
  const when = i18n.date(new Date(report.createdAt), {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const details = Object.entries(report.details ?? {})

  const onToggle = () => {
    mark.mutate(
      {id: report.id, done: !report.done},
      {
        onError: () =>
          Toast.show(l`That change couldn’t be saved`, {type: 'error'}),
      },
    )
  }

  return (
    <View
      testID="feedbackReport"
      style={[
        a.p_md,
        a.gap_sm,
        a.rounded_md,
        a.border,
        t.atoms.border_contrast_low,
        report.done && {opacity: 0.7},
      ]}>
      <View style={[a.flex_row, a.flex_wrap, a.align_center, a.gap_xs]}>
        <Text style={[a.text_sm, a.font_semi_bold]}>{kind}</Text>
        <Text style={[a.text_sm, t.atoms.text_contrast_low]}>{' ∙ '}</Text>
        <InlineLinkText
          label={sender}
          to={`/profile/${report.did}`}
          style={[a.text_sm]}>
          {sender}
        </InlineLinkText>
        <Text style={[a.text_sm, t.atoms.text_contrast_low]}>{' ∙ '}</Text>
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>{when}</Text>
        {report.done ? (
          <>
            <Text style={[a.text_sm, t.atoms.text_contrast_low]}>{' ∙ '}</Text>
            <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
              <Trans>Done</Trans>
            </Text>
          </>
        ) : null}
      </View>
      <Text emoji selectable style={[a.text_md, a.leading_snug]}>
        {report.text}
      </Text>
      {details.length > 0 ? (
        <View style={[a.gap_2xs]}>
          {details.map(([key, value]) => (
            <Text
              key={key}
              selectable
              style={[a.text_xs, a.leading_snug, t.atoms.text_contrast_medium]}>
              {key}: {value}
            </Text>
          ))}
        </View>
      ) : null}
      <Button
        testID="feedbackToggleDone"
        label={report.done ? l`Reopen this feedback` : l`Mark this feedback done`}
        color="secondary"
        size="small"
        style={[a.self_start]}
        disabled={mark.isPending}
        onPress={onToggle}>
        <ButtonText>
          {report.done ? <Trans>Reopen</Trans> : <Trans>Mark done</Trans>}
        </ButtonText>
      </Button>
    </View>
  )
}
