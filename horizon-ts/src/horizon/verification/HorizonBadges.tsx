/*
 * The badges prism lists for an account, after its name. Each is named for
 * screen readers; on the interactive line each is a button that opens a
 * dialog saying what the badge means and who gave it.
 */

import {type Insets, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {getUserDisplayName} from '#/lib/getUserDisplayName'
import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {useProfileQuery} from '#/state/queries/profile'
import {atoms as a, useBreakpoints, useTheme, web} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {useDialogControl} from '#/components/Dialog'
import * as ProfileCard from '#/components/ProfileCard'
import {Text} from '#/components/Typography'
import type * as bsky from '#/types/bsky'
import {BadgeIcon} from './BadgeIcon'
import {type HeldBadge, type ShownBadge} from './badges'

export function HorizonBadges({
  badges,
  profile,
  width,
  interactive,
  hitSlop,
}: {
  badges: ShownBadge[]
  profile: bsky.profile.AnyProfileView
  width: number
  interactive: boolean
  hitSlop?: Insets
}) {
  return (
    <>
      {badges.map(shown =>
        interactive ? (
          <BadgeButton
            key={shown.badge.id}
            shown={shown}
            profile={profile}
            width={width}
            hitSlop={hitSlop}
          />
        ) : (
          <StillBadge key={shown.badge.id} shown={shown} width={width} />
        ),
      )}
    </>
  )
}

function StillBadge({shown, width}: {shown: ShownBadge; width: number}) {
  const {t: l} = useLingui()
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={l`${shown.badge.name} badge`}
      accessibilityHint={shown.badge.description}
      style={{width, height: width}}>
      <BadgeIcon
        light={shown.badge.design}
        dark={shown.badge.dark}
        width={width}
      />
    </View>
  )
}

function BadgeButton({
  shown,
  profile,
  width,
  hitSlop,
}: {
  shown: ShownBadge
  profile: bsky.profile.AnyProfileView
  width: number
  hitSlop?: Insets
}) {
  const {t: l} = useLingui()
  const control = useDialogControl()
  return (
    <>
      <Button
        label={l`${shown.badge.name} badge`}
        accessibilityHint={l`Shows what this badge means and who gave it`}
        hitSlop={hitSlop}
        onPress={evt => {
          evt.preventDefault()
          control.open()
        }}>
        {({hovered}) => (
          <View
            style={[
              a.transition_transform,
              {
                width,
                height: width,
                transform: [{scale: hovered ? 1.1 : 1}],
              },
            ]}>
            <BadgeIcon
              light={shown.badge.design}
              dark={shown.badge.dark}
              width={width}
            />
          </View>
        )}
      </Button>
      <BadgeDialog control={control} shown={shown} profile={profile} />
    </>
  )
}

function BadgeDialog({
  control,
  shown,
  profile,
}: {
  control: Dialog.DialogControlProps
  shown: ShownBadge
  profile: bsky.profile.AnyProfileView
}) {
  return (
    <Dialog.Outer control={control} nativeOptions={{preventExpansion: true}}>
      <Dialog.Handle />
      <BadgeDialogInner control={control} shown={shown} profile={profile} />
    </Dialog.Outer>
  )
}

function BadgeDialogInner({
  control,
  shown: {badge, awards},
  profile,
}: {
  control: Dialog.DialogControlProps
  shown: ShownBadge
  profile: bsky.profile.AnyProfileView
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {gtMobile} = useBreakpoints()
  const userName = getUserDisplayName(profile)

  return (
    <Dialog.ScrollableInner
      label={l`${userName}’s ${badge.name} badge`}
      style={[
        a.w_full,
        gtMobile && web({width: 'auto', maxWidth: 400, minWidth: 200}),
      ]}>
      <View style={[a.gap_md, a.pb_lg]}>
        <View style={[a.flex_row, a.align_center, a.gap_sm, a.pr_4xl]}>
          <BadgeIcon light={badge.design} dark={badge.dark} width={32} />
          <Text
            role="heading"
            aria-level={2}
            style={[a.flex_1, a.text_2xl, a.font_semi_bold, a.leading_tight]}>
            {badge.name}
          </Text>
        </View>
        {badge.description ? (
          <Text emoji style={[a.text_md, a.leading_snug]}>
            {badge.description}
          </Text>
        ) : null}
      </View>

      <View style={[a.pb_xl, a.gap_md]}>
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>Given by:</Trans>
        </Text>
        <View style={[a.gap_lg]}>
          {awards.map(award => (
            <IssuerCard key={award.uri} award={award} outer={control} />
          ))}
        </View>
      </View>

      <View
        style={[
          a.w_full,
          a.gap_sm,
          gtMobile ? [a.flex_row, a.justify_end] : [a.flex_col],
        ]}>
        <Button
          label={l`Close dialog`}
          size="small"
          color="primary"
          onPress={() => control.close()}>
          <ButtonText>
            <Trans>Close</Trans>
          </ButtonText>
        </Button>
      </View>

      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

function IssuerCard({
  award,
  outer,
}: {
  award: HeldBadge
  outer: Dialog.DialogControlProps
}) {
  const t = useTheme()
  const {i18n} = useLingui()
  const moderationOpts = useModerationOpts()
  const {data: issuer, error} = useProfileQuery({did: award.issuer})
  const date = award.createdAt ? new Date(award.createdAt) : undefined
  const given =
    date && !Number.isNaN(date.getTime())
      ? i18n.date(date, {dateStyle: 'long'})
      : undefined

  return (
    <ProfileCard.Outer>
      <ProfileCard.Header>
        {error ? (
          <>
            <ProfileCard.AvatarPlaceholder />
            <View style={[a.flex_1]}>
              <Text
                style={[a.text_md, a.font_semi_bold, a.leading_snug]}
                numberOfLines={1}>
                <Trans>Unknown verifier</Trans>
              </Text>
              <Text
                style={[a.leading_snug, t.atoms.text_contrast_medium]}
                numberOfLines={1}>
                {award.issuer}
              </Text>
            </View>
          </>
        ) : issuer && moderationOpts ? (
          <ProfileCard.Link
            profile={issuer}
            style={[a.flex_row, a.align_center, a.gap_sm, a.flex_1]}
            onPress={() => outer.close()}>
            <ProfileCard.Avatar
              profile={issuer}
              moderationOpts={moderationOpts}
              disabledPreview
            />
            <View style={[a.flex_1]}>
              <ProfileCard.Name
                profile={issuer}
                moderationOpts={moderationOpts}
              />
              {given ? (
                <Text
                  style={[a.leading_snug, t.atoms.text_contrast_medium]}
                  numberOfLines={1}>
                  {given}
                </Text>
              ) : null}
            </View>
          </ProfileCard.Link>
        ) : (
          <>
            <ProfileCard.AvatarPlaceholder />
            <ProfileCard.NameAndHandlePlaceholder />
          </>
        )}
      </ProfileCard.Header>
    </ProfileCard.Outer>
  )
}
