/*
 * An inline spoiler (spoilers design, 6.4, 6.7): a solid bar in the text
 * colour over the words, in their normal space, that a press, Enter or Space
 * reveals in place. Revealed, it is the part's text, links included, on a
 * light background. There is no re-hide.
 */

import {useState} from 'react'
import {type GestureResponderEvent} from 'react-native'
import {type RichText as RichTextAPI} from '@bsky/sdk/richtext'
import {useLingui} from '@lingui/react/macro'

import {useHaptics} from '#/lib/haptics'
import {flatten, useTheme, web} from '#/alf'
import {RichText, type RichTextProps} from '#/components/RichText'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'

/**
 * What a nested part takes from the caller of `RichText` (6.3, styles of
 * nested parts).
 */
export type NestedRichTextProps = Pick<
  RichTextProps,
  | 'style'
  | 'selectable'
  | 'enableTags'
  | 'authorHandle'
  | 'disableLinks'
  | 'onLinkPress'
  | 'interactiveStyle'
  | 'shouldProxyLinks'
  | 'disableMentionFacetValidation'
>

type KeyEvent = {
  key: string
  preventDefault: () => void
  stopPropagation: () => void
}

/**
 * Web `onKeyDown` for a spoiler control: Enter or Space acts, and the key
 * goes no further, so an enclosing `Pressable` (a feed row, the reply
 * preview) does not press on the keyup.
 */
export function onSpoilerKey(action: () => void) {
  return (e: KeyEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    action()
  }
}

/**
 * A press on a spoiler control: on web, no enclosing anchor follows it.
 */
export function onSpoilerPress(action: () => void) {
  return (e: GestureResponderEvent) => {
    if (IS_WEB) e.preventDefault()
    action()
  }
}

export function InlineSpoiler({
  richText,
  revealed,
  onReveal,
  nested,
}: {
  richText: RichTextAPI
  revealed: boolean
  onReveal: () => void
  nested: NestedRichTextProps
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const haptics = useHaptics()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const {style} = nested

  if (revealed) {
    return (
      <Text
        emoji
        style={[style, t.atoms.bg_contrast_25]}
        {...web({focusable: false})}>
        <RichText value={richText} emojiMultiplier={1} {...nested} />
      </Text>
    )
  }

  const reveal = () => {
    haptics.tap()
    onReveal()
  }
  const barColor = flatten(style).color ?? t.atoms.text.color
  return (
    <Text
      emoji
      style={[
        style,
        {backgroundColor: barColor, color: 'transparent'},
        web({userSelect: 'none', cursor: 'pointer'}),
        hovered && {opacity: 0.8},
        focused && web({boxShadow: `0 0 0 2px ${t.palette.primary_500}`}),
      ]}
      accessibilityRole="button"
      accessibilityLabel={
        IS_WEB
          ? l({
              message: 'Spoiler, tap to reveal',
              comment:
                'Screen reader label of covered spoiler text in a post, on web',
            })
          : l({
              message: 'Spoiler',
              comment: 'Screen reader label of covered spoiler text in a post',
            })
      }
      accessibilityHint={l({
        message: 'Tap to reveal',
        comment: 'Screen reader hint of covered spoiler text in a post',
      })}
      onPress={onSpoilerPress(reveal)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      {...web({
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onKeyDown: onSpoilerKey(reveal),
      })}>
      {richText.text}
    </Text>
  )
}
