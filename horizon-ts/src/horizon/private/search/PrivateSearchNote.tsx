/*
 * The private part's line above the merged search results (2H design 11.3,
 * 11.4): what was left out of it, that it is still searching, that nothing
 * matched in recent posts yet (with "Search older posts", the only way past
 * a load that found nothing), that nothing matched in the year it covers, or
 * that it failed (with a retry). Nothing once private results are listed and
 * nothing was left out.
 *
 * While prism is busy (prism busy design 4.1, 5, 10): the catching-up note
 * above it when the load gate hid private results, and "Couldn't load private
 * posts right now" with Try again once a first load has waited 30 s.
 */

import {ActivityIndicator, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Text} from '#/components/Typography'
import {type PrivateSearchState} from '#/horizon/private/search/results'
import {CatchingUpNote} from '#/horizon/private/status/CatchingUpNote'

export function PrivateSearchNote({state}: {state: PrivateSearchState}) {
  if (!state.active) return null
  return (
    <>
      <CatchingUpNote hidden={state.hidden} />
      <PrivateSearchLine state={state} />
    </>
  )
}

function PrivateSearchLine({state}: {state: PrivateSearchState}) {
  const t = useTheme()
  const {t: l} = useLingui()

  const lines: React.ReactNode[] = []
  let action: {label: string; onPress: () => void} | undefined
  let busy = false

  const handle = state.unresolvedHandle
  const q = state.q
  if (handle) {
    lines.push(l`Couldn’t find @${handle}.`)
  }
  if (state.ignoredSomething) {
    lines.push(l`Only words and the author filter apply to private posts.`)
  }
  if (q) {
    if (state.capped) {
      lines.push(l`Couldn’t load private posts right now.`)
      action = {label: l`Try again`, onPress: state.restart}
    } else if (state.error) {
      lines.push(
        l`We’re sorry, but your private search could not be completed. Please try again in a few minutes.`,
      )
      action = {label: l`Try again`, onPress: state.refetch}
    } else if (
      (state.isLoading || state.isFetchingNextPage) &&
      state.found === 0
    ) {
      busy = true
    } else if (state.found === 0 && state.hasNextPage) {
      lines.push(l`No matches in recent private posts yet.`)
      action = {label: l`Search older posts`, onPress: state.fetchNextPage}
    } else if (state.found === 0) {
      lines.push(
        <Trans>
          No private posts match “{q}”. Private search looks back one year.
        </Trans>,
      )
    }
  }

  if (lines.length === 0 && !action && !busy) return null

  return (
    <View
      testID="privateSearchNote"
      style={[
        a.flex_row,
        a.align_center,
        a.gap_sm,
        a.px_lg,
        a.py_sm,
        a.border_b,
        t.atoms.border_contrast_low,
      ]}>
      <LockIcon size="sm" style={[t.atoms.text_contrast_medium]} />
      <View style={[a.flex_1, a.gap_2xs]}>
        {busy && lines.length === 0 ? (
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Searching private posts…</Trans>
          </Text>
        ) : (
          lines.map((line, i) => (
            <Text
              key={i}
              style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
              {line}
            </Text>
          ))
        )}
      </View>
      {busy ? (
        <ActivityIndicator />
      ) : action ? (
        <Button
          label={action.label}
          size="small"
          color="secondary"
          onPress={action.onPress}>
          <ButtonText>{action.label}</ButtonText>
        </Button>
      ) : null}
    </View>
  )
}
