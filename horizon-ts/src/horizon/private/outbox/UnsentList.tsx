/*
 * The Unsent section (2K design 8.4): the current account's outbox entries
 * that are `failed` or `undecided`, and the records another tab is running
 * ("Posting in another tab..."). On this device only; opening it is one of
 * the account's next uses (PA-28 step 5). Each row has the first line of its
 * text, when it was pressed, its state and 8.4's buttons, with Remove from
 * this device (SQ-19, built on its default).
 */

import {useEffect} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {outboxNextUse} from '#/horizon/private/outbox'
import {useUnsent} from '#/horizon/private/outbox/hooks'
import {OutboxActions} from '#/horizon/private/outbox/OutboxActions'

function firstLine(text: string): string {
  const line = text.split('\n').find(part => part.trim().length > 0) ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

export function UnsentList({
  did,
  beforeCompose,
}: {
  did: string
  /** Runs `open` once the dialog holding the list is closed (Edit). */
  beforeCompose?: (open: () => void) => void
}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const views = useUnsent(did)

  useEffect(() => {
    void outboxNextUse(did)
  }, [did])

  if (views.length === 0) return null
  return (
    <View testID="unsentList" style={[a.gap_md]}>
      <View style={[a.gap_xs]}>
        <Text style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
          <Trans>Unsent</Trans>
        </Text>
        <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
          <Trans>
            Private posts that weren’t posted, or were only partly posted.
            They’re kept only on this device.
          </Trans>
        </Text>
      </View>
      {views.map(view => {
        const text = view.record.posts[0]?.text ?? ''
        return (
          <View
            key={view.record.id}
            testID="unsentRow"
            style={[
              a.gap_xs,
              a.p_md,
              a.rounded_md,
              a.border,
              t.atoms.border_contrast_low,
            ]}>
            <Text emoji style={[a.text_sm, t.atoms.text]} numberOfLines={2}>
              {firstLine(text) || l`(No text)`}
            </Text>
            <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>
              {i18n.date(new Date(view.record.pressedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </Text>
            <OutboxActions view={view} inUnsent beforeCompose={beforeCompose} />
          </View>
        )
      })}
    </View>
  )
}
