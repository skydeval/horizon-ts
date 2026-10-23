import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'
import {type QueryKey, useQueryClient} from '@tanstack/react-query'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import {Text} from '#/components/Typography'
import {restartPrivateQuery} from '#/horizon/private/api/transient'

/**
 * A private list's quiet row (prism busy design 5, 6.2): "Couldn't load right
 * now" with Try again, in place of the skeleton once a list with nothing to
 * show has waited 30 s, or of its error while retries go on. No lock; it
 * never says anything was deleted. Try again restarts the list's query at
 * once (`restartPrivateQuery`), bypassing the retry's sleep.
 */
export function ListUnavailable({
  queryKey,
  onRetry,
}: {
  /** The list's query, restarted by Try again. */
  queryKey?: QueryKey
  /** Try again's own action, in place of the restart. */
  onRetry?: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const queryClient = useQueryClient()
  const retry =
    onRetry ??
    (queryKey
      ? () => void restartPrivateQuery(queryClient, queryKey)
      : undefined)
  return (
    <View style={[a.px_lg, a.py_lg]}>
      <View
        testID="privateListUnavailable"
        style={[
          a.flex_row,
          a.align_center,
          a.gap_md,
          a.p_md,
          a.rounded_md,
          a.border,
          t.atoms.border_contrast_low,
        ]}>
        <View style={[a.flex_1, a.gap_2xs]}>
          <Text style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
            <Trans>Couldn’t load right now</Trans>
          </Text>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Private posts will show once they load.</Trans>
          </Text>
        </View>
        {retry ? (
          <Button
            testID="privateListUnavailableRetry"
            label={l`Try again`}
            size="small"
            color="secondary"
            onPress={retry}>
            <ButtonText>
              <Trans>Try again</Trans>
            </ButtonText>
          </Button>
        ) : null}
      </View>
    </View>
  )
}
