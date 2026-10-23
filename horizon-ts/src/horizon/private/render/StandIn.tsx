import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {OUTER_SPACE} from '#/screens/PostThread/const'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Text} from '#/components/Typography'

/**
 * What a reader sees in a private post's place (6.7, prism busy design 6.2),
 * a card with the stock quote border. It names no author, shows no content
 * and is not a link. `quote` sits inside a post; `thread` takes a thread
 * item's place.
 *
 * - `audience` (the default): a lock, "Private post" and one line. A post the
 *   reader may not view, or another author's post prism left out while
 *   healthy: it says who can see the post, not that it is gone.
 * - `unavailable`: no lock, "Couldn't load right now", with Try again when
 *   `onRetry` is given. A post prism could not answer for now, a gated slot,
 *   or a screen past the wait cap. It never says the post was deleted.
 */
export function StandIn({
  variant = 'quote',
  look = 'audience',
  onRetry,
}: {
  variant?: 'quote' | 'thread'
  look?: 'audience' | 'unavailable'
  /** Try again: the owning query restarts (design 5). */
  onRetry?: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const card =
    look === 'unavailable' ? (
      <View
        testID="privatePostUnavailable"
        style={[
          a.flex_row,
          a.align_center,
          a.gap_md,
          a.p_md,
          a.rounded_md,
          a.border,
          t.atoms.border_contrast_low,
          variant === 'quote' && a.mt_sm,
        ]}>
        <View style={[a.flex_1, a.gap_2xs]}>
          <Text style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
            <Trans>Couldn’t load right now</Trans>
          </Text>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>This private post will show once it loads.</Trans>
          </Text>
        </View>
        {onRetry ? (
          <Button
            testID="privatePostUnavailableRetry"
            label={l`Try again`}
            size="small"
            color="secondary"
            onPress={onRetry}>
            <ButtonText>
              <Trans>Try again</Trans>
            </ButtonText>
          </Button>
        ) : null}
      </View>
    ) : (
      <View
        testID="privatePostStandIn"
        style={[
          a.flex_row,
          a.align_center,
          a.gap_md,
          a.p_md,
          a.rounded_md,
          a.border,
          t.atoms.border_contrast_low,
          variant === 'quote' && a.mt_sm,
        ]}>
        <LockIcon size="md" style={[t.atoms.text_contrast_medium]} />
        <View style={[a.flex_1, a.gap_2xs]}>
          <Text style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
            <Trans>Private post</Trans>
          </Text>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Only its audience can see this post.</Trans>
          </Text>
        </View>
      </View>
    )
  if (variant === 'quote') return card
  return (
    <View
      style={[
        a.mb_xs,
        {paddingHorizontal: OUTER_SPACE, paddingTop: OUTER_SPACE / 1.2},
      ]}>
      {card}
    </View>
  )
}
