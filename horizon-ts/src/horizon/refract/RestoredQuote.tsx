/*
 * The quote slot (refract client design 4.4, RF-B6a). While Refract is
 * active, the record embed's `post_not_found` branch and the
 * `recordWithMedia` record render `RestoredQuoteSlot` in place of stock's
 * "Deleted" box:
 *
 * - while an answer is pending, `QuotePlaceholder` ("Loading quoted post"),
 *   up to the background deadline counted from the ask; for an author
 *   already stock-served or "not restored", stock's "Deleted" at once. A
 *   restored quote never shows "Deleted" first.
 * - a returned post renders as a `viewRecord` built from it, through the
 *   stock `QuoteEmbed` and its moderation (passed in as `render`, so this
 *   module doesn't import it).
 * - "Deleted" needs a definitive answer; "Blocked" shows for an author in
 *   the reader's own block set, an author whose profile in the answer has a
 *   block flag, or a URI `withheld` as `blocked`.
 * - after a transient failure, the deadline, an "unresolved" author or
 *   `unavailable`, a quote-sized "Couldn’t load right now" with Try again (a
 *   foreground ask). It never claims a deletion it can't confirm.
 */

import {useEffect, useState, useSyncExternalStore} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import {Text} from '#/components/Typography'
import {QuotePlaceholder} from '#/horizon/private/render/PrivateQuote'
import {authorOfUri} from '#/horizon/refract/answer'
import {REFRACT_TIMING} from '#/horizon/refract/api'
import {
  askSlot,
  refractStateVersion,
  refractUriState,
  subscribeRefractState,
} from '#/horizon/refract/fill'
import {refractActive} from '#/horizon/refract/gate'
import {readRestored} from '#/horizon/refract/marker'
import {
  quoteStatusOf,
  type RestoredQuoteStatus,
} from '#/horizon/refract/quote-status'
import {
  readRestoredPost,
  restoredStoreVersion,
  subscribeRestoredStore,
} from '#/horizon/refract/store'
import {type app} from '#/lexicons'
import {type EmbedType} from '#/types/bsky/post'

type PostView = app.bsky.feed.defs.PostView

const quoteEmbeds = new WeakMap<PostView, EmbedType<'post'>>()

/** A restored post as the stock parsed quote embed, one per store object. */
export function toRestoredQuoteEmbed(post: PostView): EmbedType<'post'> {
  const cached = quoteEmbeds.get(post)
  if (cached) return cached
  const marker = readRestored(post)
  const embed: EmbedType<'post'> = {
    type: 'post',
    view: {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: post.uri,
      cid: post.cid,
      author: post.author,
      value: post.record,
      labels: post.labels,
      indexedAt: post.indexedAt,
      embeds: post.embed ? [post.embed] : undefined,
      likeCount: post.likeCount,
      replyCount: post.replyCount,
      repostCount: post.repostCount,
      quoteCount: post.quoteCount,
      ...(marker ? {restored: (post as {restored?: unknown}).restored} : {}),
    },
  }
  quoteEmbeds.set(post, embed)
  return embed
}

/** Whether the quote slot replaces stock's "Deleted" box for `uri`. */
export function restoredQuoteSlotActive(uri: string): boolean {
  return refractActive() && !!authorOfUri(uri)
}

/** The slot's status, re-rendering on store and answer changes. */
export function useRestoredPost(uri: string): {
  status: RestoredQuoteStatus
  retry: () => void
} {
  const storeVersion = useSyncExternalStore(subscribeRestoredStore, () =>
    restoredStoreVersion([uri]),
  )
  const answerVersion = useSyncExternalStore(
    subscribeRefractState,
    refractStateVersion,
  )
  const [attempt, setAttempt] = useState(0)
  const key = `${uri} ${attempt}`
  // The ask this key made has answered, or its deadline passed.
  const [doneFor, setDoneFor] = useState<string | undefined>(undefined)
  const [timedOutFor, setTimedOutFor] = useState<string | undefined>(undefined)

  useEffect(() => {
    let mounted = true
    const timer = setTimeout(() => {
      if (mounted) setTimedOutFor(key)
    }, REFRACT_TIMING.backgroundDeadlineMs)
    if (!readRestoredPost(uri)) {
      // The card is on screen: its ask goes within the frame (askSlot `now`).
      askSlot(uri, {
        foreground: attempt > 0,
        now: true,
        live: () => mounted,
      }).then(
        () => {
          if (mounted) setDoneFor(key)
        },
        () => {
          if (mounted) setTimedOutFor(key)
        },
      )
    }
    return () => {
      mounted = false
      clearTimeout(timer)
    }
  }, [uri, attempt, key])

  // The versions are read so the status follows the store and the answers.
  void storeVersion
  void answerVersion
  const deadlinePassed = timedOutFor === key
  // Try again shows the placeholder until its own ask answers.
  const retrying = attempt > 0 && doneFor !== key && !deadlinePassed
  const status: RestoredQuoteStatus = retrying
    ? readRestoredPost(uri)
      ? quoteStatusOf(uri, readRestoredPost(uri), undefined, false)
      : {kind: 'loading'}
    : quoteStatusOf(
        uri,
        readRestoredPost(uri),
        refractUriState(uri),
        deadlinePassed,
      )
  return {status, retry: () => setAttempt(n => n + 1)}
}

/** "Couldn’t load right now" with Try again, in the quote card's space. */
function QuoteUnavailable({onRetry}: {onRetry: () => void}) {
  const t = useTheme()
  const {t: l} = useLingui()
  return (
    <View
      testID="restoredQuoteUnavailable"
      style={[
        a.flex_row,
        a.align_center,
        a.gap_md,
        a.p_md,
        a.mt_sm,
        a.rounded_md,
        a.border,
        t.atoms.border_contrast_low,
      ]}>
      <View style={[a.flex_1]}>
        <Text style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
          <Trans>Couldn’t load right now</Trans>
        </Text>
      </View>
      <Button
        testID="restoredQuoteRetry"
        label={l`Try again`}
        size="small"
        color="secondary"
        onPress={onRetry}>
        <ButtonText>
          <Trans>Try again</Trans>
        </ButtonText>
      </Button>
    </View>
  )
}

/**
 * The quote slot. `render` draws a quote through the stock `QuoteEmbed`;
 * `placeholder` draws stock's "Deleted" or "Blocked" box.
 */
export function RestoredQuoteSlot({
  uri,
  render,
  placeholder,
}: {
  uri: string
  render: (quote: EmbedType<'post'>) => React.ReactNode
  placeholder: (kind: 'deleted' | 'blocked') => React.ReactNode
}) {
  const {status, retry} = useRestoredPost(uri)
  switch (status.kind) {
    case 'loading':
      return <QuotePlaceholder />
    case 'post':
      return render(toRestoredQuoteEmbed(status.post))
    case 'deleted':
      return placeholder('deleted')
    case 'blocked':
      return placeholder('blocked')
    case 'unavailable':
      return <QuoteUnavailable onRetry={retry} />
  }
}
