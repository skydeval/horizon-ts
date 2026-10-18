/*
 * Post text for a place that draws it plainly and reads it in a label: the
 * video grid card (spoilers design, 6.8). Each spoiler becomes a placeholder,
 * and a content warning's body another (2J design, 6.9).
 */

import {RichText as RichTextAPI} from '@bsky/sdk/richtext'
import {t} from '@lingui/core/macro'

import {type app} from '#/lexicons'
import {rendersSpoilers, visibleSpoilerText} from './layout'

const decoder = new TextDecoder()

/**
 * The record's text, or, when it has spoiler facets and the switch is on,
 * the text without its markers and with "[spoiler]" in place of each
 * spoiler ("[content warning]" for a content warning's body).
 */
export function spoilerSafeText(record: app.bsky.feed.post.Main): string {
  const richText = new RichTextAPI({text: record.text, facets: record.facets})
  if (!rendersSpoilers(richText)) return record.text
  const {bytes, spans} = visibleSpoilerText(richText)
  const placeholder = t({
    message: '[spoiler]',
    comment: 'Stands in for hidden spoiler text in a video card',
  })
  const cwPlaceholder = t({
    message: '[content warning]',
    comment:
      'Stands in for the hidden body of a post behind a content warning, in a video card',
  })
  let text = ''
  let cursor = 0
  for (const span of spans) {
    text +=
      decoder.decode(bytes.slice(cursor, span.start)) +
      (span.cw ? cwPlaceholder : placeholder)
    cursor = span.end
  }
  return text + decoder.decode(bytes.slice(cursor))
}
