/*
 * The hover card's identity lines (Phase 5 design 6.2, B-9, ID-19). The card
 * stays headed with the account (its stock name and avatar), never with
 * whoever fronts now, since it opens from a post's author line and must not
 * head a post by Wren with "Sparrow&" (P5R1-N3). Below the handle: the
 * account's pronouns, the system badge (text here, not a button: the card
 * closes on leave), and a labelled "Fronting now" line with the engaging
 * members. Read fresh on mount, following a kept signed-out schedule
 * (`hover`, 4.5, P5R6-N5).
 */

import {Fragment} from 'react'
import {View} from 'react-native'
import {type ModerationDecision} from '@bsky/sdk/moderation'
import {Trans, useLingui} from '@lingui/react/macro'

import {forceLTR} from '#/lib/strings/bidi'
import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {formatSets} from '#/horizon/identity/format'
import {memberName, MemberSwatch} from '#/horizon/identity/FronterName'
import {PluralBadge, useHeaderFronters} from '#/horizon/identity/ProfileIdentity'
import {PronounsText} from '#/horizon/identity/PronounsText'
import {PRONOUNS} from '#/horizon/switches'

export function HoverCardIdentity({
  profile,
  moderation,
}: {
  profile: {did: string; pronouns?: string}
  moderation: ModerationDecision
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {profile: plural, fronters} = useHeaderFronters(profile.did, 'hover')
  const hidden = !!moderation.ui('displayName').blur
  const words = (fronters ?? []).map(fronter => {
    const pronouns = PRONOUNS ? formatSets(fronter.member.pronouns) : ''
    return pronouns ? `${memberName(fronter)}, ${pronouns}` : memberName(fronter)
  })
  return (
    <View style={[a.gap_xs, a.pb_sm]}>
      <PronounsText did={profile.did} fallback={profile.pronouns} mode="hover" />
      {plural.isSystem ? (
        <PluralBadge
          did={profile.did}
          profile={plural}
          moderation={moderation}
          pressable={false}
        />
      ) : null}
      {plural.isSystem && fronters && !hidden ? (
        <View
          testID="hoverFrontingNow"
          accessible
          accessibilityLabel={l`Fronting now: ${words.join('. ')}`}
          accessibilityHint=""
          style={[a.flex_row, a.flex_wrap, a.align_center]}>
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Fronting now:</Trans>{' '}
          </Text>
          {fronters.map((fronter, i) => (
            <Fragment key={fronter.rkey}>
              {i > 0 ? (
                <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                  {', '}
                </Text>
              ) : null}
              <MemberSwatch color={fronter.member.color} />
              <Text emoji style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
                {forceLTR(memberName(fronter))}
              </Text>
            </Fragment>
          ))}
        </View>
      ) : null}
    </View>
  )
}
