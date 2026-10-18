import {View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {OUTER_SPACE} from '#/screens/PostThread/const'
import {atoms as a, useTheme} from '#/alf'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Text} from '#/components/Typography'

/**
 * What a reader who may not view a private post sees in its place (6.7): a
 * card with the stock quote border, a lock, "Private post" and one line. It
 * names no author, shows no content and is not a link. `quote` sits inside a
 * post; `thread` takes a thread item's place.
 */
export function StandIn({variant = 'quote'}: {variant?: 'quote' | 'thread'}) {
  const t = useTheme()
  const card = (
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
