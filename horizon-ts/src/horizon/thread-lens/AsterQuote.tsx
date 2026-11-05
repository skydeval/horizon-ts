/*
 * The aster action on a blocked quote card (`#viewBlocked`): the card stays
 * its plain "Blocked" for everyone; with the grant, a post's card also gets
 * the action. Its outcome is drawn in the card's place by the caller's
 * `render` (the stock quote card, links off), under a line with prism's
 * marker label and the undo action. A gap outcome shows that gap's text.
 * Read-only and never cached (`use-aster.ts`).
 */

import {View} from 'react-native'
import {type MessageDescriptor} from '@lingui/core'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {asterQuoteRecord, offersAsterQuote} from '#/horizon/thread-lens/aster'
import {
  GAP_GENERIC,
  GAP_TEXT,
  ROW_FAILED,
  STILL_UNAVAILABLE,
} from '#/horizon/thread-lens/strings'
import {useAster} from '#/horizon/thread-lens/use-aster'
import {type EmbedType} from '#/types/bsky/post'

function gapText(gap: string): MessageDescriptor {
  return (
    (GAP_TEXT as Record<string, MessageDescriptor | undefined>)[gap] ??
    GAP_GENERIC
  )
}

export function AsterQuote({
  uri,
  placeholder,
  render,
}: {
  /** The blocked quote's URI. */
  uri: string
  /** The plain "Blocked" card. */
  placeholder: React.ReactNode
  /** The quote card for an aster node. */
  render: (embed: EmbedType<'post'>) => React.ReactNode
}) {
  const t = useTheme()
  const {i18n} = useLingui()
  const {labels, state, view, run, undo} = useAster(uri, offersAsterQuote(uri))
  if (!labels) return <>{placeholder}</>

  if (view) {
    const embed = {
      type: 'post',
      view: asterQuoteRecord(view),
    } as EmbedType<'post'>
    return (
      <View style={[a.gap_xs]}>
        <View
          style={[
            a.flex_row,
            a.align_center,
            a.justify_between,
            a.gap_sm,
            a.rounded_sm,
            a.py_xs,
            a.px_sm,
            t.atoms.bg_contrast_25,
          ]}>
          <Text
            accessibilityLiveRegion="polite"
            aria-live="polite"
            style={[
              a.flex_1,
              a.text_sm,
              a.font_semi_bold,
              t.atoms.text_contrast_medium,
            ]}>
            {labels.marker}
          </Text>
          <Button
            label={labels.undo}
            size="small"
            color="secondary"
            onPress={undo}>
            <ButtonText>{labels.undo}</ButtonText>
          </Button>
        </View>
        {render(embed)}
      </View>
    )
  }

  const status =
    state.status === 'error'
      ? i18n._(ROW_FAILED)
      : state.status === 'done' && state.outcome.kind === 'gap'
        ? i18n._(gapText(state.outcome.gap))
        : state.status === 'done' && state.outcome.kind === 'none'
          ? i18n._(STILL_UNAVAILABLE)
          : undefined

  return (
    <View style={[a.gap_xs]}>
      {placeholder}
      <View style={[a.flex_row, a.align_center, a.gap_sm]}>
        <Button
          label={labels.action}
          size="small"
          color="secondary"
          disabled={state.status === 'loading'}
          onPress={run}>
          {state.status === 'loading' ? <ButtonIcon icon={Loader} /> : null}
          <ButtonText>{labels.action}</ButtonText>
        </Button>
        {status ? (
          <Text
            accessibilityLiveRegion="polite"
            aria-live="polite"
            style={[a.flex_1, a.text_sm, t.atoms.text_contrast_medium]}>
            {status}
          </Text>
        ) : null}
      </View>
    </View>
  )
}
