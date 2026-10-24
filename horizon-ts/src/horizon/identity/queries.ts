/*
 * The identity entries in the query cache (Phase 5 design 4.5, B-4): one
 * entry per question, in-flight asks shared by key.
 *
 * | Entry    | Args          | Stale | gcTime | Persisted |
 * |----------|---------------|-------|--------|-----------|
 * | pronouns | {did}         | 5 min | 24 h   | yes, v1   |
 * | system   | {did}         | 5 min | 24 h   | yes, v1   |
 * | member   | {did, rkey}   | 5 min | 24 h   | yes, v1   |
 * | members  | {did}         | 5 min | 24 h   | yes, v1   |
 * | front    | {did}         | 2 min | 5 min  | no        |
 *
 * Only a record and none are answers (`IdentityAnswer`); an unknown, a
 * network error, a 5xx, a timeout or another 4xx makes the query fail,
 * which keeps a cached answer in place. Whether it still shows is
 * {@link identityAnswerFromState}'s rule: behind failing reads for at most
 * 1 h (members, pronouns) or 24 h (system) from its `dataUpdatedAt`; an
 * entry restored from disk and older than its stale time not until this
 * run has asked again (P5R2-N3). One actor read answers pronouns, system
 * and front together, and seeds the two not asked; a member list seeds its
 * members' entries, so a profile makes its posts' fronters instant.
 *
 * The queries never fetch by themselves (`enabled: false` on every
 * observer): `schedule.ts` decides each ask, through the observers the
 * hooks register.
 */

import {
  type QueryClient,
  type QueryKey,
  type QueryState,
} from '@tanstack/react-query'

import {createQueryKey} from '#/state/queries/util'
import {FAILURE_CAP_MS, GC_MS, STALE_MS} from '#/horizon/identity/config'
import {
  type PluralFront,
  type PluralMember,
  type PluralSystem,
  type Pronouns,
} from '#/horizon/identity/parse'
import {
  type ActorAnswers,
  identityPausedUntil,
  IdentityRateLimitedError,
  type ListedMember,
  readActorRecords,
  type ReadAnswer,
  readMemberList,
  readMemberRecord,
} from '#/horizon/identity/reads'
import {
  type IdentityOutcome,
  observeIdentityKey,
  type ObserveMode,
  prefetchIdentityKey,
  reportIdentityOutcome,
  type ScheduledKey,
} from '#/horizon/identity/schedule'

/** The entries, by kind. */
export type IdentityKind =
  'pronouns' | 'system' | 'member' | 'members' | 'front'

export const IDENTITY_ROOTS: Record<IdentityKind, string> = {
  pronouns: 'horizon-identity-pronouns',
  system: 'horizon-identity-system',
  member: 'horizon-identity-member',
  members: 'horizon-identity-members',
  front: 'horizon-identity-front',
}

/** A record (its parsed value and CID) or a proven none. */
export type IdentityAnswer<T> =
  {kind: 'record'; value: T; cid?: string} | {kind: 'none'}

/** An account's member list: ascending rkey; `partial` shows "and more". */
export type MemberList = {members: ListedMember[]; partial: boolean}

/** Each entry's data. */
export type IdentityData = {
  pronouns: IdentityAnswer<Pronouns>
  system: IdentityAnswer<PluralSystem>
  member: IdentityAnswer<PluralMember>
  members: MemberList
  front: IdentityAnswer<PluralFront>
}

/** Each entry's args. */
export type IdentityArgs = {
  pronouns: {did: string}
  system: {did: string}
  member: {did: string; rkey: string}
  members: {did: string}
  front: {did: string}
}

/**
 * S-2 answered unknown: not an answer, so the query fails and keeps any
 * cached value. `authed` says which cadence the retry follows.
 */
export class IdentityUnknownError extends Error {
  readonly authed: boolean

  constructor(authed: boolean) {
    super('Not known yet')
    this.name = 'IdentityUnknownError'
    this.authed = authed
  }
}

/** The start of this run: an entry older than it was restored from disk. */
let runStart = Date.now()

/** Test-only: move the start of the run. */
export function setIdentityRunStart(ms: number) {
  runStart = ms
}

/** The persisted query key of an entry (the front is not persisted). */
export function identityQueryKey<K extends IdentityKind>(
  kind: K,
  args: IdentityArgs[K],
) {
  return kind === 'front'
    ? createQueryKey(IDENTITY_ROOTS[kind], args)
    : createQueryKey(IDENTITY_ROOTS[kind], args, {persistedVersion: 1})
}

function hashOf(kind: IdentityKind, args: IdentityArgs[IdentityKind]): string {
  return JSON.stringify([IDENTITY_ROOTS[kind], args])
}

const withDefaults = new WeakSet<QueryClient>()

/**
 * The identity roots' stale and gc times as the client's defaults, so an
 * entry seeded with `setQueryData` keeps its 24 h (P5R1-N4).
 */
function ensureDefaults(queryClient: QueryClient) {
  if (withDefaults.has(queryClient)) return
  withDefaults.add(queryClient)
  for (const kind of Object.keys(IDENTITY_ROOTS) as IdentityKind[]) {
    queryClient.setQueryDefaults([IDENTITY_ROOTS[kind]], {
      staleTime: STALE_MS[kind],
      gcTime: GC_MS[kind],
      retry: false,
    })
  }
}

function settledThisRun(state: QueryState<unknown, Error>): boolean {
  if (state.dataUpdatedAt >= runStart) return true
  return (
    state.errorUpdatedAt >= runStart &&
    !(state.error instanceof IdentityRateLimitedError)
  )
}

/**
 * The answer an entry's state shows now, or `undefined` for unknown
 * (pending, failing past its cap, or restored and stale until this run asks
 * again).
 */
export function identityAnswerFromState<K extends IdentityKind>(
  kind: K,
  state:
    | Pick<
        QueryState<IdentityData[K], Error>,
        'data' | 'dataUpdatedAt' | 'errorUpdatedAt' | 'error' | 'status'
      >
    | undefined,
  now: number = Date.now(),
): IdentityData[K] | undefined {
  if (!state || state.data === undefined) return undefined
  const settled = settledThisRun(state as QueryState<unknown, Error>)
  if (!settled && now - state.dataUpdatedAt > STALE_MS[kind]) return undefined
  if (
    state.status === 'error' &&
    now - state.dataUpdatedAt >= FAILURE_CAP_MS[kind]
  ) {
    return undefined
  }
  return state.data
}

/**
 * When the cached answer of a failing entry stops showing, or `undefined`
 * when it is not failing (for a re-render at the cap).
 */
export function identityCapEndsAt(
  kind: IdentityKind,
  state:
    | Pick<QueryState<unknown, Error>, 'data' | 'dataUpdatedAt' | 'status'>
    | undefined,
): number | undefined {
  if (!state || state.data === undefined || state.status !== 'error') {
    return undefined
  }
  return state.dataUpdatedAt + FAILURE_CAP_MS[kind]
}

function toAnswer<T>(answer: ReadAnswer<T>): IdentityAnswer<T> | undefined {
  if (answer.status === 'record') {
    return answer.cid === undefined
      ? {kind: 'record', value: answer.value}
      : {kind: 'record', value: answer.value, cid: answer.cid}
  }
  if (answer.status === 'none') return {kind: 'none'}
  return undefined
}

function outcomeOf(error: unknown): IdentityOutcome {
  if (error instanceof IdentityRateLimitedError) {
    return {kind: 'limited', until: error.until}
  }
  if (error instanceof IdentityUnknownError) {
    return {kind: 'unknown', authed: error.authed}
  }
  return {kind: 'error'}
}

const ACTOR_PARTS = ['pronouns', 'system', 'front'] as const
type ActorPart = (typeof ACTOR_PARTS)[number]

/** Seed the actor parts not asked, from an answer to the one asked. */
function seedActor(
  queryClient: QueryClient,
  did: string,
  answers: ActorAnswers,
  asked: ActorPart,
  at: number,
) {
  for (const part of ACTOR_PARTS) {
    if (part === asked) continue
    const answer = toAnswer<unknown>(answers[part])
    if (!answer) continue
    queryClient.setQueryData(identityQueryKey(part, {did}), answer, {
      updatedAt: at,
    })
    reportIdentityOutcome(
      scheduledIdentityKey(queryClient, part, {did}),
      {
        kind: 'answer',
      },
      at,
    )
  }
}

/** Seed each listed member's own entry (4.5). */
function seedMembers(
  queryClient: QueryClient,
  did: string,
  members: readonly ListedMember[],
  at: number,
) {
  for (const member of members) {
    const args = {did, rkey: member.rkey}
    const answer: IdentityAnswer<PluralMember> =
      member.cid === undefined
        ? {kind: 'record', value: member.value}
        : {kind: 'record', value: member.value, cid: member.cid}
    queryClient.setQueryData(identityQueryKey('member', args), answer, {
      updatedAt: at,
    })
    reportIdentityOutcome(
      scheduledIdentityKey(queryClient, 'member', args),
      {kind: 'answer'},
      at,
    )
  }
}

async function run<K extends IdentityKind>(
  queryClient: QueryClient,
  kind: K,
  args: IdentityArgs[K],
): Promise<IdentityData[K]> {
  switch (kind) {
    case 'pronouns':
    case 'system':
    case 'front': {
      const part: ActorPart = kind
      const {did} = args
      const answers = await readActorRecords(did, {queryClient})
      const at = Date.now()
      seedActor(queryClient, did, answers, part, at)
      const mine = answers[part]
      if (mine.status === 'unknown') {
        throw new IdentityUnknownError(answers.authed)
      }
      if (mine.status === 'error') throw mine.error
      return toAnswer<unknown>(mine) as IdentityData[K]
    }
    case 'member': {
      const {did, rkey} = args as IdentityArgs['member']
      const read = await readMemberRecord(did, rkey, {queryClient})
      if (read.answer.status === 'unknown') {
        throw new IdentityUnknownError(read.authed)
      }
      if (read.answer.status === 'error') throw read.answer.error
      return toAnswer(read.answer) as IdentityData[K]
    }
    case 'members': {
      const {did} = args
      const read = await readMemberList(did, {queryClient})
      if (read.status === 'unknown') throw new IdentityUnknownError(read.authed)
      seedMembers(queryClient, did, read.members, Date.now())
      return {
        members: read.members,
        partial: read.status === 'partial',
      } as IdentityData[K]
    }
  }
  throw new Error('Unknown identity entry')
}

/**
 * The query options of an entry. Observers add `enabled: false`; asks come
 * from `schedule.ts`.
 */
export function identityQueryOptions<K extends IdentityKind>(
  kind: K,
  args: IdentityArgs[K],
) {
  return {
    queryKey: identityQueryKey(kind, args) as QueryKey,
    queryFn: async ({client}: {client: QueryClient}) => {
      const key = scheduledIdentityKey(client, kind, args)
      try {
        const data = await run(client, kind, args)
        reportIdentityOutcome(key, {kind: 'answer'})
        return data
      } catch (error) {
        reportIdentityOutcome(key, outcomeOf(error))
        throw error
      }
    },
    staleTime: STALE_MS[kind],
    gcTime: GC_MS[kind],
    retry: false as const,
  }
}

/** An entry as `schedule.ts` handles it. */
export function scheduledIdentityKey<K extends IdentityKind>(
  queryClient: QueryClient,
  kind: K,
  args: IdentityArgs[K],
): ScheduledKey {
  const queryKey = identityQueryKey(kind, args)
  return {
    hash: hashOf(kind, args),
    staleMs: STALE_MS[kind],
    pausedUntil: identityPausedUntil,
    state: () => {
      const state = queryClient.getQueryState(queryKey)
      if (!state) {
        return {
          hasData: false,
          dataUpdatedAt: 0,
          answeredAt: 0,
          settledThisRun: false,
          fetching: false,
        }
      }
      const settled = settledThisRun(state)
      const errored =
        state.errorUpdatedAt >= runStart &&
        !(state.error instanceof IdentityRateLimitedError)
      return {
        hasData: state.data !== undefined,
        dataUpdatedAt: state.dataUpdatedAt,
        answeredAt: Math.max(
          state.dataUpdatedAt >= runStart ? state.dataUpdatedAt : 0,
          errored ? state.errorUpdatedAt : 0,
        ),
        settledThisRun: settled,
        fetching: state.fetchStatus === 'fetching',
      }
    },
    fetch: () => {
      ensureDefaults(queryClient)
      return queryClient
        .fetchQuery({...identityQueryOptions(kind, args), staleTime: 0})
        .then(
          () => undefined,
          () => undefined,
        )
    },
  }
}

/**
 * Observe an entry while a component shows it (`mode`: a post, or the
 * profile's or hover card's fresh read). Returns the stop function.
 */
export function observeIdentity<K extends IdentityKind>(
  queryClient: QueryClient,
  kind: K,
  args: IdentityArgs[K],
  mode: ObserveMode = 'post',
): () => void {
  ensureDefaults(queryClient)
  return observeIdentityKey(scheduledIdentityKey(queryClient, kind, args), mode)
}

/** What a page names, for {@link prefetchIdentities}. */
export type IdentityPage = {
  /** Every author DID on the page (post authors, quoted, reply parents). */
  dids: readonly string[]
  /** The member rkeys a page's posts name as fronters, by author DID. */
  fronters?: readonly {did: string; rkeys: readonly string[]}[]
}

/**
 * Warm a page's identities (4.6): the pronouns and system of every DID not
 * cached fresh, and the members its fronter posts name, in one batched S-2
 * call (the front comes back with them and is cached, but is never asked
 * for). Asks only what a post mounting now would ask. Resolves when every
 * ask has settled, for a caller that waits a bounded time (5B).
 */
export function prefetchIdentities(
  queryClient: QueryClient,
  page: IdentityPage,
): Promise<void> {
  ensureDefaults(queryClient)
  const asks: Promise<unknown>[] = []
  const push = (promise: Promise<unknown> | undefined) => {
    if (promise) asks.push(promise)
  }
  for (const did of new Set(page.dids)) {
    push(
      prefetchIdentityKey(scheduledIdentityKey(queryClient, 'pronouns', {did})),
    )
    push(
      prefetchIdentityKey(scheduledIdentityKey(queryClient, 'system', {did})),
    )
  }
  for (const {did, rkeys} of page.fronters ?? []) {
    for (const rkey of new Set(rkeys)) {
      push(
        prefetchIdentityKey(
          scheduledIdentityKey(queryClient, 'member', {did, rkey}),
        ),
      )
    }
  }
  return Promise.all(asks).then(() => undefined)
}
