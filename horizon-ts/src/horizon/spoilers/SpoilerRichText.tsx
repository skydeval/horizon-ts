/*
 * Post text with spoiler facets (spoilers design, 6.2 to 6.6), rendered in
 * place of the stock `RichText` body by hook Spoil 1. Plain parts and
 * revealed parts go through the stock `RichText`, nested, so links,
 * mentions and tags render as stock.
 */

import {
  type StyleProp,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native'
import {type RichText as RichTextAPI} from '@bsky/sdk/richtext'

import {isRTLText} from '#/lib/strings/text-direction'
import {android, flatten} from '#/alf'
import {RichText, type RichTextProps} from '#/components/RichText'
import {Text} from '#/components/Typography'
import {IS_NATIVE} from '#/env'
import {ContentWarningLine, useCwLineStrings} from './ContentWarningLine'
import {cwLineRunLabel} from './cw-line'
import {InlineSpoiler, type NestedRichTextProps} from './InlineSpoiler'
import {
  buildSpoilerLayout,
  COMPACT_MAX_LINES,
  type SpoilerPart,
  suffixInLastRun,
} from './layout'
import {SpoilerArrow, SpoilerDrawerBody, SpoilerLabelRow} from './SpoilerDrawer'
import {useSpoilerReveal} from './state'

const WORD_WRAP = {wordWrap: 1}

const TEXT_STYLE_KEYS = new Set([
  'color',
  'letterSpacing',
  'lineHeight',
  'writingDirection',
  'includeFontPadding',
  'verticalAlign',
  'userSelect',
  'wordBreak',
  'whiteSpace',
  'overflowWrap',
])

/**
 * A column's runs take the caller's text style (font, colour, line height,
 * alignment); the column's `View` takes the rest (flex, margins, padding),
 * so spacing is not repeated per run.
 */
function splitStyle(style: StyleProp<TextStyle>): {
  text: TextStyle
  view: ViewStyle
} {
  const text: TextStyle & Record<string, unknown> = {}
  const view: ViewStyle & Record<string, unknown> = {}
  for (const [key, value] of Object.entries(flatten(style))) {
    if (
      key.startsWith('font') ||
      key.startsWith('text') ||
      TEXT_STYLE_KEYS.has(key)
    ) {
      text[key] = value
    } else {
      view[key] = value
    }
  }
  return {text, view}
}

export function SpoilerRichText({
  richText,
  testID,
  style,
  numberOfLines,
  disableLinks,
  selectable,
  enableTags = false,
  authorHandle,
  onLinkPress,
  interactiveStyle,
  onLayout,
  onTextLayout,
  shouldProxyLinks,
  suffix,
  suffixOffset = 0,
  disableMentionFacetValidation,
}: Omit<RichTextProps, 'value' | 'emojiMultiplier'> & {
  richText: RichTextAPI
}) {
  const reveal = useSpoilerReveal(richText.text)
  const compact =
    numberOfLines !== undefined && numberOfLines <= COMPACT_MAX_LINES
  const layout = buildSpoilerLayout(richText, {compact})

  // As the stock root: right-aligned RTL text on native.
  const rtl: TextStyle | null =
    IS_NATIVE && isRTLText(richText.text) ? {textAlign: 'right'} : null
  const suffixStyles =
    suffix && suffixOffset
      ? android({paddingBottom: suffixOffset, marginBottom: -suffixOffset})
      : null
  const split = layout.column ? splitStyle(style) : undefined
  const runStyle: StyleProp<TextStyle> = split
    ? [split.text, rtl]
    : [style, rtl]
  const nested: NestedRichTextProps = {
    style: runStyle,
    selectable,
    enableTags,
    authorHandle,
    disableLinks,
    onLinkPress,
    interactiveStyle,
    shouldProxyLinks,
    disableMentionFacetValidation,
  }

  const cwLineStrings = useCwLineStrings()
  /*
   * On native, a run's text that holds the CW line is read as "Content
   * warning:" and the line (nested texts have no labels of their own).
   */
  const runLabel = (parts: SpoilerPart[]) =>
    IS_NATIVE
      ? cwLineRunLabel(parts, cwLineStrings.spoken, part =>
          part.kind === 'spoiler' && !reveal.isRevealed(part.id)
            ? part.cw
              ? cwLineStrings.coveredCw
              : cwLineStrings.coveredSpoiler
            : undefined,
        )
      : undefined

  const renderParts = (parts: SpoilerPart[]) =>
    parts.map((part, i) =>
      part.kind === 'plain' && part.cwLine ? (
        <ContentWarningLine key={i} richText={part.richText} nested={nested} />
      ) : part.kind === 'plain' ? (
        <RichText
          key={i}
          value={part.richText}
          emojiMultiplier={1}
          {...nested}
        />
      ) : (
        <InlineSpoiler
          key={i}
          richText={part.richText}
          revealed={reveal.isRevealed(part.id)}
          onReveal={() => reveal.reveal(part.id)}
          nested={nested}
          cw={part.cw}
        />
      ),
    )
  const suffixNodes = suffix ? <> {suffix}</> : null

  if (!layout.column) {
    const run = layout.items[0]
    return (
      <Text
        emoji
        selectable={selectable}
        testID={testID}
        style={[runStyle, suffixStyles]}
        numberOfLines={numberOfLines}
        onLayout={onLayout}
        onTextLayout={onTextLayout}
        accessibilityLabel={
          run?.kind === 'run' ? runLabel(run.parts) : undefined
        }
        accessibilityHint=""
        dataSet={WORD_WRAP}>
        {run?.kind === 'run' ? renderParts(run.parts) : null}
        {suffixNodes}
      </Text>
    )
  }

  // The drawers that hold a content warning's body, for their arrows.
  const cwDrawers = new Set(
    layout.items.flatMap(item =>
      item.kind === 'drawer' && item.cw ? [item.id] : [],
    ),
  )
  const lastIndex = layout.items.length - 1
  const suffixInRun = suffixInLastRun(layout)
  const firstRunIndex = layout.items.findIndex(item => item.kind === 'run')
  /*
   * A block spoiler needs a column. No caller nests post text with lines in
   * a `Text`: the one sentence that does (notifications) flattens its line
   * breaks, and compact renderings have no blocks.
   */
  // oxlint-disable-next-line bsky-internal/avoid-unwrapped-text
  return (
    <View style={split?.view} onLayout={onLayout}>
      {layout.items.map((item, index) => {
        if (item.kind === 'run') {
          const isFirst = index === firstRunIndex
          const withSuffix = suffixInRun && index === lastIndex
          return (
            <Text
              key={index}
              emoji
              selectable={selectable}
              testID={isFirst ? testID : undefined}
              style={[runStyle, withSuffix && suffixStyles]}
              numberOfLines={numberOfLines}
              onTextLayout={isFirst ? onTextLayout : undefined}
              accessibilityLabel={runLabel([...item.parts, ...item.tail])}
              accessibilityHint=""
              dataSet={WORD_WRAP}>
              {renderParts(item.parts)}
              {item.arrowFor !== undefined ? (
                <SpoilerArrow
                  open={reveal.isOpen(item.arrowFor)}
                  onToggle={() => {
                    if (item.arrowFor !== undefined)
                      reveal.toggle(item.arrowFor)
                  }}
                  style={runStyle}
                  cw={cwDrawers.has(item.arrowFor)}
                />
              ) : null}
              {renderParts(item.tail)}
              {withSuffix ? suffixNodes : null}
            </Text>
          )
        }
        return (
          <View key={index}>
            {item.label ? (
              <SpoilerLabelRow
                open={reveal.isOpen(item.id)}
                onToggle={() => reveal.toggle(item.id)}
                cw={item.cw}
              />
            ) : null}
            <SpoilerDrawerBody open={reveal.isOpen(item.id)}>
              <Text
                emoji
                selectable={selectable}
                style={runStyle}
                dataSet={WORD_WRAP}>
                {renderParts(item.parts)}
              </Text>
            </SpoilerDrawerBody>
          </View>
        )
      })}
      {suffix && !suffixInRun ? (
        <Text style={[runStyle, suffixStyles]}>{suffix}</Text>
      ) : null}
    </View>
  )
}
