/*
 * The plural profile (Phase 5 design 6.2, B-8, ID-17, ID-17a, ID-18): who
 * is fronting now in the header, the system badge, the front indicator and
 * the member list. Only for an account whose system answer is a record
 * (PP-3, U-8); any other account, and every account while its answer is
 * unknown, shows as stock.
 *
 * The header swaps only child text and image URLs the stock components
 * already take (PP-14, P5R1-L3): `PluralHeaderName` is the display name's
 * text child, `usePluralHeaderImages` gives `Shell.tsx` its avatar and
 * banner. The `profile` object handed to Edit Profile, the unfollow prompt,
 * the menu and the buttons stays the account's.
 */

import {Fragment} from 'react'
import {View} from 'react-native'
import {type ModerationDecision} from '@bsky/sdk/moderation'
import {type I18n} from '@lingui/core'
import {plural} from '@lingui/core/macro'
import {Trans, useLingui} from '@lingui/react/macro'

import {HITSLOP_10} from '#/lib/constants'
import {forceLTR} from '#/lib/strings/bidi'
import {useSession} from '#/state/session'
import {atoms as a, useTheme} from '#/alf'
import {Button} from '#/components/Button'
import {useDialogControl} from '#/components/Dialog'
import {Text} from '#/components/Typography'
import {FrontSwitcherDialog} from '#/horizon/identity/edit/FrontSwitcherDialog'
import {
  formatFronterNames,
  formatFrontState,
  formatMemberLabel,
  formatSets,
} from '#/horizon/identity/format'
import {memberName, MemberSwatch} from '#/horizon/identity/FronterName'
import {
  type PluralProfile,
  type PostFronter,
  usePluralProfile,
} from '#/horizon/identity/hooks'
import {memberImageUrl} from '#/horizon/identity/images'
import {MemberListDialog} from '#/horizon/identity/MemberListDialog'
import {isEngaging, type PluralFront} from '#/horizon/identity/parse'
import {PronounsText} from '#/horizon/identity/PronounsText'
import {type ObserveMode} from '#/horizon/identity/schedule'
import {PLURAL_EDITING, PRONOUNS} from '#/horizon/switches'

/** Space, U+00B7 MIDDLE DOT, space: between the badge's parts. */
const MIDDLE_DOT = ' \u00B7 '

/**
 * The front's engaging members as the header may show them, or `null` (the
 * account as stock): the system answer must be a record, and every engaging
 * member must be answered, so two fronters never show as one while a member
 * loads (as P5R2-N5 for posts). A member missing from a complete member
 * list was deleted and is left out.
 */
export function engagingForDisplay(
  profile: PluralProfile,
): PostFronter[] | null {
  if (!profile.isSystem || !profile.front) return null
  const ids = [
    ...new Set(profile.front.members.filter(isEngaging).map(m => m.id)),
  ]
  if (ids.length === 0) return null
  const resolved = new Map(profile.engaging.map(f => [f.rkey, f]))
  const listed =
    profile.members && !profile.members.partial
      ? new Set(profile.members.members.map(m => m.rkey))
      : undefined
  const shown: PostFronter[] = []
  for (const id of ids.sort()) {
    const fronter = resolved.get(id)
    if (fronter) {
      shown.push(fronter)
      continue
    }
    if (listed && !listed.has(id)) continue
    return null
  }
  return shown.length > 0 ? shown : null
}

/** The header's fronters for `did`, read fresh as the profile does (4.5). */
export function useHeaderFronters(
  did: string | undefined,
  mode: ObserveMode = 'profile',
): {profile: PluralProfile; fronters: PostFronter[] | null} {
  const profile = usePluralProfile(did, {mode})
  return {profile, fronters: engagingForDisplay(profile)}
}

/**
 * The profile header's display name text (ID-17a): one engaging member's
 * name with `&`, or several names joined with ", " and one `&` after the
 * last (Q4); `fallback` (the stock text) otherwise, and whenever the
 * account's name is hidden by moderation.
 */
export function PluralHeaderName({
  did,
  fallback,
  moderation,
}: {
  did: string
  fallback: string
  moderation: {blur?: boolean} | undefined
}) {
  const {fronters} = useHeaderFronters(did)
  if (!fronters || moderation?.blur) return <>{fallback}</>
  return <>{forceLTR(formatFronterNames(fronters.map(memberName)))}</>
}

/**
 * The header's images (ID-18): with one engaging member, its avatar and
 * banner where it has them, else the account's; with several or none, the
 * account's. URLs only, which the stock props already take, so the
 * account's moderation applies to either (6.2).
 */
export function usePluralHeaderImages(profile: {
  did: string
  avatar?: string
  banner?: string
}): {avatar: string | undefined; banner: string | undefined} {
  const {fronters} = useHeaderFronters(profile.did)
  const single = fronters?.length === 1 ? fronters[0].member : undefined
  return {
    avatar: single?.avatar
      ? memberImageUrl(profile.did, single.avatar, 'avatar')
      : profile.avatar,
    banner: single?.banner
      ? memberImageUrl(profile.did, single.banner, 'banner')
      : profile.banner,
  }
}

/**
 * The member count the badge shows: the self-reported `memberCount` when
 * set, else the number of member records (PL "Member count").
 */
function useMemberCountText(profile: PluralProfile): string | undefined {
  const {t: l} = useLingui()
  const reported = profile.system?.memberCount?.trim()
  if (reported) {
    return /^\d+$/.test(reported)
      ? plural(Number(reported), {one: '# member', other: '# members'})
      : l`Members: ${reported}`
  }
  const list = profile.members
  if (!list || list.members.length === 0) return undefined
  const count = list.members.length
  return list.partial
    ? plural(count, {one: '# member and more', other: '# members and more'})
    : plural(count, {one: '# member', other: '# members'})
}

/**
 * The system badge under the handle: the system's name, else its
 * collective noun, else "Plural system", and the member count. Pressing it
 * opens the member list, unless `pressable` is false (the hover card).
 */
export function PluralBadge({
  did,
  profile,
  moderation,
  pressable = true,
}: {
  did: string
  profile: PluralProfile
  moderation: ModerationDecision
  pressable?: boolean
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const control = useDialogControl()
  const count = useMemberCountText(profile)
  if (!profile.isSystem) return null
  const name =
    profile.system?.name?.trim() ||
    profile.system?.collectiveNoun?.trim() ||
    l`Plural system`
  const text = count ? `${name}${MIDDLE_DOT}${count}` : name
  const chip = (
    <View
      style={[
        a.flex_row,
        a.align_center,
        a.rounded_full,
        a.px_sm,
        a.py_xs,
        t.atoms.bg_contrast_50,
      ]}>
      <Text emoji style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
        {text}
      </Text>
    </View>
  )
  if (!pressable) {
    return (
      <View testID="pluralBadge" style={[a.flex_row]}>
        {chip}
      </View>
    )
  }
  return (
    <>
      <Button
        testID="pluralBadge"
        label={l`${text}. Show members`}
        accessibilityHint={l`Opens the list of this system’s members`}
        hitSlop={HITSLOP_10}
        onPress={() => control.open()}
        style={[a.self_start]}>
        {chip}
      </Button>
      <MemberListDialog
        control={control}
        did={did}
        profile={profile}
        moderation={moderation}
      />
    </>
  )
}

/** A front state's label: a known value translated, any other as typed. */
function frontStateText(i18n: I18n, state: string | undefined) {
  const formatted = formatFrontState(state)
  if (formatted === undefined) return undefined
  return typeof formatted === 'string' ? formatted : i18n._(formatted)
}

/** One member in the indicator: emoji, name, pronouns, status if not engaging. */
type IndicatorMember = {fronter: PostFronter; status: string | undefined}

/**
 * The front's members the indicator lists: every front member whose record
 * is known, except the header's single fronter (6.2); with several engaging,
 * the header keeps the account's pronouns and each member's show here.
 */
function indicatorMembers(
  profile: PluralProfile,
  front: PluralFront,
  header: PostFronter[] | null,
): IndicatorMember[] {
  const byRkey = new Map<string, PostFronter>()
  for (const fronter of profile.engaging) byRkey.set(fronter.rkey, fronter)
  for (const listed of profile.members?.members ?? []) {
    if (!byRkey.has(listed.rkey)) {
      byRkey.set(listed.rkey, {rkey: listed.rkey, member: listed.value})
    }
  }
  const skip = header?.length === 1 ? header[0].rkey : undefined
  const seen = new Set<string>()
  const out: IndicatorMember[] = []
  // Member-list order, ascending rkey, as everywhere else (4.2 item 5).
  const entries = [...front.members].sort((x, y) =>
    x.id < y.id ? -1 : x.id > y.id ? 1 : 0,
  )
  for (const entry of entries) {
    if (entry.id === skip || seen.has(entry.id)) continue
    seen.add(entry.id)
    const fronter = byRkey.get(entry.id)
    if (!fronter) continue
    out.push({
      fronter,
      status: isEngaging(entry) ? undefined : entry.status?.trim(),
    })
  }
  return out
}

/**
 * The front indicator beside the badge: the state, the members in front
 * other than the header's (with emoji, name, pronouns, and status when not
 * engaging), and the comment. "Nobody fronting" for an empty front; absent
 * when there is no front record or the answer is unknown (PL "Front
 * states"). With `onPress` (one's own profile, 7.3) it is a button that
 * opens the front switcher, and a missing front reads "Set front".
 */
export function FrontIndicator({
  profile,
  header,
  onPress,
}: {
  profile: PluralProfile
  header: PostFronter[] | null
  /** Opens the front switcher; one's own profile only. */
  onPress?: () => void
}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const front = profile.front
  if (!profile.isSystem) return null
  if (front === null && onPress) {
    return (
      <Button
        testID="setFrontButton"
        label={l`Set front`}
        accessibilityHint={l`Opens the front switcher`}
        hitSlop={HITSLOP_10}
        onPress={onPress}
        style={[a.self_start]}>
        <Text style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
          <Trans>Set front</Trans>
        </Text>
      </Button>
    )
  }
  if (!front) return null
  const state = frontStateText(i18n, front.state)
  const comment = front.comment?.trim()
  const nobody = front.members.length === 0
  const members = nobody ? [] : indicatorMembers(profile, front, header)
  if (!nobody && !state && !comment && members.length === 0) return null

  const words = members.map(({fronter, status}) => {
    const pronouns = formatSets(fronter.member.pronouns)
    return [memberName(fronter), pronouns, status].filter(Boolean).join(', ')
  })
  const label = [
    nobody
      ? l`Front: nobody fronting`
      : state
        ? l`Front: ${state}`
        : l`Front`,
    ...words,
    comment,
  ]
    .filter(Boolean)
    .join('. ')

  const content = (
    <View
      testID="frontIndicator"
      accessible={!onPress}
      accessibilityLabel={label}
      accessibilityHint=""
      style={[a.flex_row, a.flex_wrap, a.align_center, a.gap_xs]}>
      {nobody ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>Nobody fronting</Trans>
        </Text>
      ) : state ? (
        <Text emoji style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
          {state}
        </Text>
      ) : null}
      {members.map(({fronter, status}, i) => {
        const pronouns = formatSets(fronter.member.pronouns)
        return (
          <Fragment key={fronter.rkey}>
            {i > 0 || nobody || state ? (
              <Text style={[a.text_sm, t.atoms.text_contrast_low]}>
                {'\u00B7'}
              </Text>
            ) : null}
            <View style={[a.flex_row, a.align_center]}>
              <MemberSwatch color={fronter.member.color} />
              <Text emoji style={[a.text_sm, t.atoms.text]}>
                {forceLTR(formatMemberLabel(fronter.member))}
              </Text>
              {pronouns || status ? (
                <Text emoji style={[a.text_sm, t.atoms.text_contrast_medium]}>
                  {' '}
                  {[pronouns, status].filter(Boolean).join(', ')}
                </Text>
              ) : null}
            </View>
          </Fragment>
        )
      })}
      {comment ? (
        <Text
          emoji
          style={[a.w_full, a.text_sm, a.italic, t.atoms.text_contrast_medium]}>
          {comment}
        </Text>
      ) : null}
    </View>
  )
  if (!onPress) return content
  return (
    <Button
      testID="frontIndicatorButton"
      label={label}
      accessibilityHint={l`Opens the front switcher`}
      hitSlop={HITSLOP_10}
      onPress={onPress}
      style={[a.self_start]}>
      {content}
    </Button>
  )
}

/**
 * Under the profile header's handle (ID-17): the pronouns (with one engaging
 * member, its pronouns in the account's place, 6.1), the system badge and
 * the front indicator.
 */
export function ProfileHeaderIdentity({
  profile,
  moderation,
}: {
  profile: {did: string; pronouns?: string}
  moderation: ModerationDecision
}) {
  const {profile: plural, fronters} = useHeaderFronters(profile.did)
  const {currentAccount} = useSession()
  const frontSwitcher = useDialogControl()
  // One's own front opens 5C's switcher (7.3); everyone else's is text.
  const own = PLURAL_EDITING && currentAccount?.did === profile.did
  const single = fronters?.length === 1 ? fronters[0] : undefined
  const singlePronouns =
    single && PRONOUNS ? formatSets(single.member.pronouns) : ''
  return (
    <>
      {single ? (
        singlePronouns ? (
          <ProfilePronounsLine text={singlePronouns} />
        ) : null
      ) : (
        <PronounsText
          did={profile.did}
          fallback={profile.pronouns}
          mode="profile"
        />
      )}
      {plural.isSystem ? (
        <View style={[a.flex_row, a.flex_wrap, a.align_center, a.gap_sm]}>
          <PluralBadge
            did={profile.did}
            profile={plural}
            moderation={moderation}
          />
          <FrontIndicator
            profile={plural}
            header={fronters}
            onPress={own ? () => frontSwitcher.open() : undefined}
          />
          {own ? (
            <FrontSwitcherDialog control={frontSwitcher} did={profile.did} />
          ) : null}
        </View>
      ) : null}
    </>
  )
}

/** A member's pronouns in the header's pronouns line. */
function ProfilePronounsLine({text}: {text: string}) {
  const t = useTheme()
  return (
    <Text
      emoji
      testID="profilePronouns"
      style={[a.text_md, a.leading_snug, t.atoms.text_contrast_medium]}>
      {text}
    </Text>
  )
}
