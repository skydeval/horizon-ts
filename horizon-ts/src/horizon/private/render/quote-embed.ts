/*
 * A resolved private post as the stock parsed quote embed. Kept apart from
 * `PrivateQuote.tsx` so the conversion is pure and loads without the UI.
 */

import {type app} from '#/lexicons'
import {type EmbedType} from '#/types/bsky/post'

/**
 * A private post as the stock parsed quote embed, for `QuoteEmbed`. The post
 * is an adapted one (`toPostView`): its record, and any private post its
 * embed quotes, are already converted, and its labels carry its self-labels.
 */
export function toQuoteEmbed(
  post: app.bsky.feed.defs.PostView,
): EmbedType<'post'> {
  return {
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
    },
  }
}
