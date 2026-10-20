/*
 * The reply preview's text with its spoilers covered (spoilers design, 6.8),
 * drawn by hook Spoil 7 in place of the stock `Text`.
 */

import {type StyleProp, type TextStyle} from 'react-native'
import {RichText as RichTextAPI} from '@bsky/sdk/richtext'
import {useQueryClient} from '@tanstack/react-query'

import {usePostQuery} from '#/state/queries/post'
import {type ComposerOptsPostRef} from '#/state/shell/composer'
import {RichText} from '#/components/RichText'
import {Text} from '#/components/Typography'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {withContentWarningRecord} from './cw-line'
import {rendersSpoilers} from './layout'
import {withOtherAppSpoilers} from './other-apps'
import {useOtherAppSpoilersOn} from './other-apps-setting'
import {
  coversWhileLoading,
  findCachedPostRecord,
  matchingRecord,
  wholeTextSpoiler,
} from './reply-preview'

export function ReplyToText({
  replyTo,
  numberOfLines,
  style,
}: {
  replyTo: ComposerOptsPostRef
  numberOfLines?: number
  style: StyleProp<TextStyle>
}) {
  const queryClient = useQueryClient()
  const cached = findCachedPostRecord(queryClient, replyTo.uri, replyTo.text)
  const query = usePostQuery(cached ? undefined : replyTo.uri)
  const record = cached ?? matchingRecord(query.data, replyTo.text)
  const otherAppSpoilers = useOtherAppSpoilersOn()

  const stock = (
    <Text style={style} numberOfLines={numberOfLines} emoji>
      {replyTo.text}
    </Text>
  )

  if (record) {
    const richText = withOtherAppSpoilers(
      withContentWarningRecord(
        new RichTextAPI({text: record.text, facets: record.facets}),
        record,
      ),
      otherAppSpoilers,
    )
    if (!rendersSpoilers(richText)) return stock
    return (
      <RichText
        value={richText}
        style={style}
        numberOfLines={numberOfLines}
        disableLinks
      />
    )
  }

  // Not answered yet, or failed: a preview that may hold spoilers stays covered.
  if (
    query.data === undefined &&
    replyTo.text.length > 0 &&
    coversWhileLoading(replyTo.text, isPrivatePostUri(replyTo.uri))
  ) {
    return (
      <RichText
        value={wholeTextSpoiler(replyTo.text)}
        style={style}
        numberOfLines={numberOfLines}
        disableLinks
      />
    )
  }
  return stock
}
