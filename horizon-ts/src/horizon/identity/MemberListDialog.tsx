/*
 * A plural system's member list (Phase 5 design 6.2, B-8), opened from the
 * system badge: every member in list order (ascending rkey, which with TIDs
 * is creation order, 4.2 item 5), with avatar, emoji, colour swatch, name,
 * pronouns, roles, member types, age presentation, proxy note and
 * description; members in front are marked. Read-only; on one's own
 * system an "Edit" button closes it and opens Edit Profile on the Plurality
 * tab (`onEdit`, 6.2), and "Change front" closes it and opens the front
 * switcher (`onChangeFront`, 7.3).
 *
 * Moderation is the account's (U-8, 6.2): names go through
 * `sanitizeDisplayName` with the account's `displayName` moderation, and
 * images take the account's avatar moderation. Descriptions are plain text.
 */

import {View} from 'react-native'
import {type ModerationDecision} from '@bsky/sdk/moderation'
import {Trans, useLingui} from '@lingui/react/macro'

import {forceLTR} from '#/lib/strings/bidi'
import {sanitizeDisplayName} from '#/lib/strings/display-names'
import {UserAvatar} from '#/view/com/util/UserAvatar'
import {atoms as a, useTheme, web} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {Text} from '#/components/Typography'
import {formatSets} from '#/horizon/identity/format'
import {MemberSwatch} from '#/horizon/identity/FronterName'
import {type PluralProfile} from '#/horizon/identity/hooks'
import {memberImageUrl} from '#/horizon/identity/images'
import {isEngaging, type PluralMember} from '#/horizon/identity/parse'
import {PRONOUNS} from '#/horizon/switches'

export function MemberListDialog({
  control,
  did,
  profile,
  moderation,
  onEdit,
  onChangeFront,
}: {
  control: Dialog.DialogControlProps
  did: string
  profile: PluralProfile
  moderation: ModerationDecision
  /** One's own system only: opens Edit Profile on the Plurality tab. */
  onEdit?: () => void
  /** One's own system only: opens the front switcher (7.3). */
  onChangeFront?: () => void
}) {
  return (
    <Dialog.Outer control={control}>
      <Dialog.Handle />
      <MemberListInner
        did={did}
        profile={profile}
        moderation={moderation}
        onEdit={onEdit}
        onChangeFront={onChangeFront}
      />
    </Dialog.Outer>
  )
}

function MemberListInner({
  did,
  profile,
  moderation,
  onEdit,
  onChangeFront,
}: {
  did: string
  profile: PluralProfile
  moderation: ModerationDecision
  onEdit?: () => void
  onChangeFront?: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const control = Dialog.useDialogContext()
  const list = profile.members
  const inFront = new Map<string, string | undefined>()
  for (const entry of profile.front?.members ?? []) {
    inFront.set(entry.id, isEngaging(entry) ? undefined : entry.status)
  }
  const title = profile.system?.name?.trim() || l`Members`
  return (
    <Dialog.ScrollableInner
      label={l`Members`}
      style={[web({maxWidth: 520}), a.w_full]}>
      <View style={[a.gap_lg]}>
        <View style={[a.flex_row, a.align_center, a.justify_between, a.gap_md]}>
          <Text emoji style={[a.flex_1, a.text_2xl, a.font_bold, t.atoms.text]}>
            {title}
          </Text>
          {onChangeFront ? (
            <Button
              testID="pluralMemberListChangeFront"
              size="small"
              color="secondary"
              label={l`Change who’s fronting`}
              accessibilityHint={l`Opens the front switcher`}
              onPress={() => control.close(() => onChangeFront())}>
              <ButtonText>
                <Trans>Change front</Trans>
              </ButtonText>
            </Button>
          ) : null}
          {onEdit ? (
            <Button
              testID="pluralMemberListEdit"
              size="small"
              color="secondary"
              label={l`Edit`}
              accessibilityHint={l`Opens Edit Profile on the Plurality tab`}
              onPress={() => control.close(() => onEdit())}>
              <ButtonText>{l`Edit`}</ButtonText>
            </Button>
          ) : null}
        </View>
        {profile.system?.description?.trim() ? (
          <Text emoji style={[a.text_md, t.atoms.text_contrast_medium]}>
            {profile.system.description.trim()}
          </Text>
        ) : null}
        {!list ? (
          <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
            <Trans>Members couldn’t be loaded right now.</Trans>
          </Text>
        ) : list.members.length === 0 ? (
          <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
            <Trans>No members listed.</Trans>
          </Text>
        ) : (
          <View style={[a.gap_md]}>
            {list.members.map(listed => (
              <MemberRow
                key={listed.rkey}
                did={did}
                member={listed.value}
                inFront={inFront.has(listed.rkey)}
                status={inFront.get(listed.rkey)}
                proxyName={
                  listed.value.proxy
                    ? list.members.find(m => m.rkey === listed.value.proxy?.id)
                        ?.value.displayName
                    : undefined
                }
                moderation={moderation}
              />
            ))}
            {list.partial ? (
              <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
                <Trans>And more</Trans>
              </Text>
            ) : null}
          </View>
        )}
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

function MemberRow({
  did,
  member,
  inFront,
  status,
  proxyName,
  moderation,
}: {
  did: string
  member: PluralMember
  inFront: boolean
  status: string | undefined
  proxyName: string | undefined
  moderation: ModerationDecision
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const name = sanitizeDisplayName(
    member.displayName,
    moderation.ui('displayName'),
  )
  const pronouns = PRONOUNS ? formatSets(member.pronouns) : ''
  const details = [
    member.roles.length ? l`Roles: ${member.roles.join(', ')}` : '',
    member.memberTypes.length
      ? l`Member types: ${member.memberTypes.join(', ')}`
      : '',
    member.agePresentation?.trim()
      ? l`Age presentation: ${member.agePresentation.trim()}`
      : '',
  ].filter(Boolean)
  const proxy = member.proxy
    ? [
        proxyName
          ? l`Speaks through ${sanitizeDisplayName(proxyName)}`
          : l`Speaks through another member`,
        member.proxy.note?.trim(),
      ]
        .filter(Boolean)
        .join('\u00A0\u2013 ')
    : ''
  const statusText = status?.trim()
  return (
    <View
      testID="pluralMemberRow"
      style={[a.flex_row, a.gap_md, a.align_start]}>
      <UserAvatar
        size={40}
        type="user"
        avatar={
          member.avatar
            ? memberImageUrl(did, member.avatar, 'avatar_thumbnail')
            : undefined
        }
        moderation={moderation.ui('avatar')}
      />
      <View style={[a.flex_1, a.gap_2xs]}>
        <View style={[a.flex_row, a.flex_wrap, a.align_center, a.gap_xs]}>
          <Text emoji style={[a.text_md, a.font_semi_bold, t.atoms.text]}>
            <MemberSwatch color={member.color} />
            {member.emoji?.trim() ? `${member.emoji.trim()} ` : ''}
            {forceLTR(name)}
          </Text>
          {pronouns ? (
            <Text emoji style={[a.text_md, t.atoms.text_contrast_medium]}>
              {pronouns}
            </Text>
          ) : null}
          {inFront ? (
            <View
              style={[
                a.rounded_full,
                a.px_sm,
                a.py_2xs,
                t.atoms.bg_contrast_50,
              ]}>
              <Text emoji style={[a.text_xs, a.font_semi_bold, t.atoms.text]}>
                {statusText ? (
                  <Trans>In front: {statusText}</Trans>
                ) : (
                  <Trans>In front</Trans>
                )}
              </Text>
            </View>
          ) : null}
        </View>
        {details.map(detail => (
          <Text
            key={detail}
            emoji
            style={[a.text_sm, t.atoms.text_contrast_medium]}>
            {detail}
          </Text>
        ))}
        {proxy ? (
          <Text emoji style={[a.text_sm, t.atoms.text_contrast_medium]}>
            {proxy}
          </Text>
        ) : null}
        {member.description?.trim() ? (
          <Text emoji style={[a.text_sm, t.atoms.text]}>
            {member.description.trim()}
          </Text>
        ) : null}
      </View>
    </View>
  )
}
