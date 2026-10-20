import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import * as Skeleton from '#/components/Skeleton'
import {useIsMember} from '#/horizon/private/membership'
import {usePrivateQuoteQuery} from '#/horizon/private/quotes/cache'
import {toQuoteEmbed} from '#/horizon/private/render/quote-embed'
import {StandIn} from '#/horizon/private/render/StandIn'
import {type EmbedType} from '#/types/bsky/post'

/**
 * The quote card's space while its post is read: the stock card's border,
 * padding and meta row, with two quiet lines for its text.
 */
export function QuotePlaceholder() {
  const t = useTheme()
  const {t: l} = useLingui()
  return (
    <View
      testID="privateQuotePlaceholder"
      accessibilityRole="progressbar"
      accessibilityLabel={l`Loading quoted post`}
      accessibilityHint={l`The quoted post appears here once it loads`}
      style={[
        a.mt_sm,
        a.p_md,
        a.gap_sm,
        a.rounded_md,
        a.border,
        t.atoms.border_contrast_low,
      ]}>
      <Skeleton.Row style={[a.align_center, a.gap_xs]}>
        <Skeleton.Circle size={16} blend />
        <Skeleton.Text blend style={[a.text_sm, {width: 140}]} />
      </Skeleton.Row>
      <Skeleton.Col style={[a.gap_2xs]}>
        <Skeleton.Text blend style={[a.text_md]} />
        <Skeleton.Text blend style={[a.text_md, {width: '60%'}]} />
      </Skeleton.Col>
    </View>
  )
}

/**
 * A quoted private post (6.7). A member reads it from the quote cache, which
 * the page fetch filled in the same fetch as the quoting post
 * (`quotes/resolve.ts`), or else through a read of its own, with the card's
 * space held meanwhile. It renders through the stock `QuoteEmbed`, passed in
 * as `render` so this module does not import it (it must stay in
 * `Embed/index.tsx`). A reader who may not view it, or who is not a
 * signed-in member, sees the stand-in; no private request is made for a
 * non-member.
 */
export function PrivateQuote({
  uri,
  render,
}: {
  uri: string
  render: (quote: EmbedType<'post'>) => React.ReactNode
}) {
  const isMember = useIsMember()
  const {data: post, isLoading} = usePrivateQuoteQuery(uri, isMember)
  if (!isMember) return <StandIn variant="quote" />
  if (isLoading) return <QuotePlaceholder />
  if (!post) return <StandIn variant="quote" />
  return render(toQuoteEmbed(post))
}
