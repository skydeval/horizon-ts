/*
 * The identity hooks (Phase 5 design 5.2, 5.3, B-5), each subscribing
 * through query observers (P4 TL-34) and registering its keys with
 * `schedule.ts` while mounted, so an unknown is asked again on PP-23's
 * cadence while it is on screen. No query observer is created for a key a
 * hook does not need (`useQueries` with an empty list): outside a scope,
 * for another DID, or with the switch off (P5R2-N12).
 *
 * - `usePronouns(did, fallback)`: three states (PP-8). A record shows its
 *   sets (empty sets: nothing, and no fallback); a proven none shows the
 *   stock short field the caller passes; unknown shows nothing, never the
 *   short field.
 * - `usePostFronters(authorDid)`: a post's fronters from its scope, or
 *   `null` to show the account as stock: until the author's system answer
 *   is a record and every named member has answered; a member answered
 *   none is left out, one still unknown holds the whole line (P5R2-N5).
 *   Never the front (U-6).
 * - `useFronterAvatar(profile)`: the single fronter's avatar, for the stock
 *   avatar's `avatar` prop.
 * - `usePluralProfile(did)`: system, member list, front and the engaging
 *   members.
 */

import {useEffect, useState} from 'react'
import {useQueries, useQueryClient} from '@tanstack/react-query'

import {formatPronouns} from '#/horizon/identity/format'
import {readFronters} from '#/horizon/identity/fronters'
import {memberImageUrl} from '#/horizon/identity/images'
import {
  isEngaging,
  type PluralFront,
  type PluralMember,
  type PluralSystem,
} from '#/horizon/identity/parse'
import {
  type IdentityAnswer,
  identityAnswerFromState,
  type IdentityArgs,
  identityCapEndsAt,
  type IdentityData,
  type IdentityKind,
  identityQueryOptions,
  type MemberList,
  observeIdentity,
} from '#/horizon/identity/queries'
import {type ObserveMode} from '#/horizon/identity/schedule'
import {usePostFrontersScope} from '#/horizon/identity/scope'
import {PLURAL_DISPLAY, PRONOUNS} from '#/horizon/switches'

/** One entry a hook reads. */
type Spec = {
  [K in IdentityKind]: {kind: K; args: IdentityArgs[K]}
}[IdentityKind]

type Read = {
  /** The answer shown now, `undefined` for unknown. */
  answer: IdentityData[IdentityKind] | undefined
  capEndsAt: number | undefined
}

/**
 * Read `specs` through query observers and observe them while mounted.
 * `now` is passed in so a re-render at a cap recomputes.
 */
function useIdentityReads(specs: Spec[], mode: ObserveMode): Read[] {
  const queryClient = useQueryClient()
  const results = useQueries({
    queries: specs.map(spec => ({
      ...identityQueryOptions(spec.kind, spec.args as never),
      enabled: false,
    })),
  })
  const hash = JSON.stringify(specs)
  useEffect(() => {
    const keys = JSON.parse(hash) as Spec[]
    if (keys.length === 0) return
    const stops = keys.map(spec =>
      observeIdentity(queryClient, spec.kind, spec.args as never, mode),
    )
    return () => stops.forEach(stop => stop())
  }, [queryClient, hash, mode])

  const capEnds = specs.map((spec, i) =>
    identityCapEndsAt(spec.kind, results[i]),
  )
  const tick = useCapTick(capEnds)
  const now = Math.max(Date.now(), tick)
  return specs.map((spec, i) => ({
    answer: identityAnswerFromState(spec.kind, results[i], now),
    capEndsAt: capEnds[i],
  }))
}

/**
 * Re-render when the soonest future cap passes, so a failing entry's cached
 * answer stops showing on time. Returns the time of the last re-render it
 * caused (0 before any).
 */
function useCapTick(capEnds: (number | undefined)[]): number {
  const [tick, setTick] = useState(0)
  const now = Date.now()
  let soonest = Number.POSITIVE_INFINITY
  for (const at of capEnds) {
    if (at !== undefined && at > now && at < soonest) soonest = at
  }
  const next = soonest === Number.POSITIVE_INFINITY ? 0 : soonest
  useEffect(() => {
    if (next === 0) return
    const timer = setTimeout(() => setTick(Date.now()), next - Date.now() + 1)
    return () => clearTimeout(timer)
  }, [next])
  return tick
}

/** Where a pronouns text comes from. */
export type PronounsSource = 'record' | 'stock' | 'none'

export type PronounsResult = {
  /** The text to show; `''` shows nothing. */
  text: string
  /** The sets shown, each its forms as written (`[]` for stock or none). */
  sets: string[][]
  source: PronounsSource
}

const NO_PRONOUNS: PronounsResult = {text: '', sets: [], source: 'none'}

/**
 * The pronouns to show from an answer (PP-8, PP-9): a record by its
 * `displayMode`, empty sets showing nothing and no fallback; a proven none
 * the stock short field; unknown nothing.
 */
export function pronounsFromAnswer(
  answer: IdentityData['pronouns'] | undefined,
  fallback: string | undefined,
): PronounsResult {
  if (!answer) return NO_PRONOUNS
  if (answer.kind === 'none') {
    const stock = fallback?.trim()
    return stock ? {text: stock, sets: [], source: 'stock'} : NO_PRONOUNS
  }
  const text = formatPronouns(answer.value)
  if (!text) return NO_PRONOUNS
  const sets =
    answer.value.displayMode === 'firstOnly'
      ? answer.value.sets.slice(0, 1)
      : answer.value.sets
  return {text, sets, source: 'record'}
}

/**
 * The pronouns for `did` (5.2). `fallback` is Bluesky's short `pronouns`
 * field from the view the caller already has (no fetch). `mode`: the
 * profile and the hover card read fresh (4.5).
 */
export function usePronouns(
  did: string | undefined,
  fallback?: string,
  {mode = 'post'}: {mode?: ObserveMode} = {},
): PronounsResult {
  const specs: Spec[] = PRONOUNS && did ? [{kind: 'pronouns', args: {did}}] : []
  const [read] = useIdentityReads(specs, mode)
  if (!read) return NO_PRONOUNS
  return pronounsFromAnswer(
    read.answer as IdentityData['pronouns'] | undefined,
    fallback,
  )
}

/** One fronter of a post: its rkey and member record. */
export type PostFronter = {rkey: string; member: PluralMember}

/**
 * A post's fronters from its answers (5.3), or `null` to show the account
 * as stock: the system answer must be a record and every named member must
 * have answered; a member answered none is left out, one unknown holds the
 * whole line; none left gives `null`. `rkeys` are in display order.
 */
export function resolvePostFronters(
  system: IdentityAnswer<PluralSystem> | undefined,
  members: readonly {
    rkey: string
    answer: IdentityAnswer<PluralMember> | undefined
  }[],
): PostFronter[] | null {
  if (!system || system.kind !== 'record') return null
  const fronters: PostFronter[] = []
  for (const {rkey, answer} of members) {
    if (!answer) return null
    if (answer.kind === 'record') fronters.push({rkey, member: answer.value})
  }
  return fronters.length > 0 ? fronters : null
}

/**
 * The fronters of the post in scope when it is drawing `authorDid`, or
 * `null` (show the account exactly as stock).
 */
export function usePostFronters(
  authorDid: string | undefined,
): PostFronter[] | null {
  const scope = usePostFrontersScope(authorDid)
  const rkeys = PLURAL_DISPLAY && scope ? readFronters(scope.record) : null
  const did = scope?.authorDid
  const specs: Spec[] =
    rkeys && did
      ? [
          {kind: 'system', args: {did}},
          ...rkeys.map(rkey => ({kind: 'member' as const, args: {did, rkey}})),
        ]
      : []
  const reads = useIdentityReads(specs, 'post')
  if (!rkeys || reads.length === 0) return null
  return resolvePostFronters(
    reads[0].answer as IdentityAnswer<PluralSystem> | undefined,
    rkeys.map((rkey, i) => ({
      rkey,
      answer: reads[i + 1].answer as IdentityAnswer<PluralMember> | undefined,
    })),
  )
}

/**
 * The single fronter's avatar URL (CDN thumbnail) for the post in scope
 * when it is drawing `profile`, else `undefined`, so the stock avatar keeps
 * the account's image and its moderation applies to either (P5R1-L2).
 */
export function useFronterAvatar(profile: {did: string}): string | undefined {
  const fronters = usePostFronters(profile.did)
  if (!fronters || fronters.length !== 1) return undefined
  const avatar = fronters[0].member.avatar
  return avatar
    ? memberImageUrl(profile.did, avatar, 'avatar_thumbnail')
    : undefined
}

/** An account's plural profile (5.2). */
export type PluralProfile = {
  /** The system answer is a record (the signal, U-8). */
  isSystem: boolean
  system: PluralSystem | undefined
  /** The front record, `null` for a proven none, `undefined` unknown. */
  front: PluralFront | null | undefined
  /** The front's engaging members, resolved, in member-list order. */
  engaging: PostFronter[]
  /** The member list, `undefined` while unknown. */
  members: MemberList | undefined
}

const STOCK_PROFILE: PluralProfile = {
  isSystem: false,
  system: undefined,
  front: undefined,
  engaging: [],
  members: undefined,
}

/**
 * `did`'s plural profile. `mode` `profile` or `hover` reads fresh on mount
 * (4.5); the hover card follows a kept signed-out schedule.
 */
export function usePluralProfile(
  did: string | undefined,
  {mode = 'profile'}: {mode?: ObserveMode} = {},
): PluralProfile {
  const base: Spec[] =
    PLURAL_DISPLAY && did
      ? [
          {kind: 'system', args: {did}},
          {kind: 'front', args: {did}},
          {kind: 'members', args: {did}},
        ]
      : []
  const [systemRead, frontRead, membersRead] = useIdentityReads(base, mode)
  const front = frontRead?.answer as IdentityAnswer<PluralFront> | undefined
  const engagingIds =
    did && front?.kind === 'record'
      ? [
          ...new Set(
            front.value.members.filter(isEngaging).map(member => member.id),
          ),
        ].sort()
      : []
  const memberReads = useIdentityReads(
    did
      ? engagingIds.map(rkey => ({kind: 'member' as const, args: {did, rkey}}))
      : [],
    'post',
  )
  if (!systemRead) return STOCK_PROFILE
  const system = systemRead.answer as IdentityAnswer<PluralSystem> | undefined
  const engaging: PostFronter[] = []
  engagingIds.forEach((rkey, i) => {
    const answer = memberReads[i]?.answer as
      IdentityAnswer<PluralMember> | undefined
    if (answer?.kind === 'record') engaging.push({rkey, member: answer.value})
  })
  return {
    isSystem: system?.kind === 'record',
    system: system?.kind === 'record' ? system.value : undefined,
    front: front ? (front.kind === 'record' ? front.value : null) : undefined,
    engaging,
    members: membersRead?.answer as MemberList | undefined,
  }
}
