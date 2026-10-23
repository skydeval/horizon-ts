import {useEffect, useState, useSyncExternalStore} from 'react'
import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'
import {useQueryClient} from '@tanstack/react-query'

import {atoms as a, useTheme} from '#/alf'
import * as Skeleton from '#/components/Skeleton'
import {restartPrivateQuery} from '#/horizon/private/api/transient'
import {
  answeredSince,
  isOwnPrivateUri,
  subscribeRegistry,
} from '#/horizon/private/known'
import {useServedSince, useSlotFloor} from '#/horizon/private/load-gate'
import {useIsMember} from '#/horizon/private/membership'
import {
  fromQuoteData,
  isQuoteView,
  isUnavailableQuote,
  privateQuoteQueryKey,
  usePrivateQuoteQuery,
} from '#/horizon/private/quotes/cache'
import {QUOTE_DEADLINE_MS} from '#/horizon/private/quotes/resolve'
import {toQuoteEmbed} from '#/horizon/private/render/quote-embed'
import {StandIn} from '#/horizon/private/render/StandIn'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {healthEnvironment} from '#/horizon/routing/health'
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
  if (!isMember) return <StandIn variant="quote" />
  return <MemberQuote uri={uri} render={render} />
}

/**
 * A member's quote slot (prism busy design 6.3, 4.1). A view renders as
 * today, the quiet card's value as the quiet card, `null` as the stand-in.
 * When the slot is gated (its floor, `useSlotFloor`), another author's quote
 * shows content only once served since the floor, and any verdict since it
 * ends the wait; until then the skeleton while it is read, for at most
 * {@link QUOTE_DEADLINE_MS} from the mount or from the stamp that raised the
 * floor, then the quiet card while the read goes on. An error with no data
 * is the quiet card, never the stand-in. The reader's own quotes are never
 * gated; they paint with "Syncing" on their own meta row.
 */
function MemberQuote({
  uri,
  render,
}: {
  uri: string
  render: (quote: EmbedType<'post'>) => React.ReactNode
}) {
  const qc = useQueryClient()
  const did = useCurrentClients()?.did
  const own = !!did && isOwnPrivateUri(uri, did)
  const slotFloor = useSlotFloor(uri)
  const floor = own ? undefined : slotFloor
  const {data, isFetching, isLoading, error} = usePrivateQuoteQuery(
    uri,
    true,
    floor,
  )
  const served = useServedSince(uri, floor)
  const answered = useAnsweredSince(uri, floor)
  const capped = useSkeletonCap(floor, isFetching)
  const retry = () => void restartPrivateQuery(qc, privateQuoteQueryKey(uri))
  const quiet = <StandIn variant="quote" look="unavailable" onRetry={retry} />

  if (floor !== undefined && !served && !(answered && !isQuoteView(data))) {
    // Gated: nothing shown from before the floor.
    return isFetching && !capped ? <QuotePlaceholder /> : quiet
  }
  if (data === undefined) {
    if (error) return isFetching && !capped ? <QuotePlaceholder /> : quiet
    return isLoading && !capped ? <QuotePlaceholder /> : quiet
  }
  if (isUnavailableQuote(data)) return quiet
  const post = fromQuoteData(data)
  if (!post) return <StandIn variant="quote" />
  return render(toQuoteEmbed(post))
}

/**
 * Whether the skeleton has shown for {@link QUOTE_DEADLINE_MS} since the
 * mount or since the floor last rose (BR11-N8), while a read runs.
 */
function useSkeletonCap(floor: number | undefined, fetching: boolean) {
  const [capped, setCapped] = useState(false)
  useEffect(() => {
    setCapped(false)
    if (!fetching) return
    const env = healthEnvironment()
    const timer = env.setTimeout(() => setCapped(true), QUOTE_DEADLINE_MS)
    return () => env.clearTimeout(timer)
  }, [floor, fetching])
  return capped
}

/** A 2xx since `floor` served the quote or gave it a verdict (BR12-N6). */
function useAnsweredSince(uri: string, floor: number | undefined) {
  const did = useCurrentClients()?.did
  return useSyncExternalStore(subscribeRegistry, () =>
    floor === undefined || !did ? true : answeredSince(did, uri, floor),
  )
}
