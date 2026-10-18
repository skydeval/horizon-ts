/*
 * Post text for a place that draws it plainly and reads it in a label: the
 * video grid card (spoilers design, 6.8). Each spoiler becomes a placeholder,
 * and a content warning's body another (2J design, 6.9). A CW line reads
 * "CW: " and the line, as it is drawn (2J follow-up, `cw-line.ts`).
 */

import {RichText as RichTextAPI} from '@bsky/sdk/richtext'
import {t} from '@lingui/core/macro'

import {type app} from '#/lexicons'
import {cwLineEndOf, withContentWarningRecord} from './cw-line'
import {rendersSpoilers, visibleSpoilerText} from './layout'

const decoder = new TextDecoder()

/**
 * The record's text, or, when it has spoiler facets and the switch is on,
 * the text without its markers and with "[spoiler]" in place of each
 * spoiler ("[content warning]" for a content warning's body), and with
 * "CW: " before a CW line.
 */
export function spoilerSafeText(record: app.bsky.feed.post.Main): string {
  const richText = withContentWarningRecord(
    new RichTextAPI({text: record.text, facets: record.facets}),
    record,
  )
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
  text += decoder.decode(bytes.slice(cursor))
  if (cwLineEndOf(richText, bytes, spans) === undefined) return text
  return `${cwLinePrefix()} ${text}`
}

/**
 * The "CW:" drawn before a CW line.
 */
export function cwLinePrefix(): string {
  return t({
    message: 'CW:',
    comment:
      'Drawn before the content warning line of a post, the short form of "Content warning:"',
  })
}
