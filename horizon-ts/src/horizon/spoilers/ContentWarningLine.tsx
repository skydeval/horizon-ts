/*
 * The CW line of a whole-post content warning, drawn as a warning (2J
 * follow-up, `cw-line.ts`): "CW:" and the line, in the medium weight and
 * colour of the "Content warning" label row and covers, inside the run's
 * text. The prefix is never part of the stored text, and it is not
 * selectable, so copying the drawn text leaves it out.
 *
 * Screen readers hear "Content warning:" in place of "CW:": on web a hidden
 * span reads it and the drawn prefix is hidden; on native nested texts have
 * no labels of their own, so the run's text takes the label
 * (`cwLineRunLabel`).
 */

import {type TextStyle} from 'react-native'
import {type RichText as RichTextAPI} from '@bsky/sdk/richtext'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme, web} from '#/alf'
import {RichText} from '#/components/RichText'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {type NestedRichTextProps} from './InlineSpoiler'

/**
 * Read by screen readers on web, not drawn.
 */
const SPOKEN_ONLY: TextStyle = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  opacity: 0,
}

export function useCwLineStrings() {
  const {t: l} = useLingui()
  return {
    prefix: l({
      message: 'CW:',
      comment:
        'Drawn before the content warning line of a post, the short form of "Content warning:"',
    }),
    spoken: l({
      message: 'Content warning:',
      comment:
        'What a screen reader reads before the content warning line of a post, in place of "CW:"',
    }),
    coveredCw: l({
      message: 'Content warning',
      comment:
        'Screen reader label of the covered body of a post behind a content warning',
    }),
    coveredSpoiler: l({
      message: 'Spoiler',
      comment: 'Screen reader label of covered spoiler text in a post',
    }),
  }
}

export function ContentWarningLine({
  richText,
  nested,
}: {
  richText: RichTextAPI
  nested: NestedRichTextProps
}) {
  const t = useTheme()
  const {prefix, spoken} = useCwLineStrings()
  const style = [nested.style, a.font_medium, t.atoms.text_contrast_medium]
  return (
    <>
      <Text
        style={[style, a.font_semi_bold, web({userSelect: 'none'})]}
        aria-hidden={IS_WEB ? true : undefined}>
        {prefix}{' '}
      </Text>
      {IS_WEB ? (
        <Text style={[SPOKEN_ONLY, web({userSelect: 'none'})]}>{spoken} </Text>
      ) : null}
      <RichText
        value={richText}
        emojiMultiplier={1}
        {...nested}
        style={style}
      />
    </>
  )
}
