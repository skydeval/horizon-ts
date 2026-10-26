/*
 * The identity reads (Phase 5 design 4.4, 4.5, 5.1, B-3), with no cache of
 * their own: the S-2 batch call to prism and its batcher, the own-PDS reads,
 * and the direct repo reads. Every answer is one of three: a record, none,
 * or unknown (PP-8); a failed repo record read is an error of its own, so
 * one record's failure never marks another.
 *
 * Other accounts' records come from prism first (PP-20 as amended,
 * skydeval 2026-10-26), and from the author's own repo whenever prism gives
 * no answer at all: S-2 not served (a 501 or 404, or features without
 * `plural.read`), a failed call (network, timeout, 5xx), or
 * `IDENTITY_PRISM_READS` off. An `unknown` that prism does answer stands
 * (a hidden account or member stays hidden), and a 429 pauses as before.
 * The direct reads go at most {@link DIRECT_READ_CONCURRENCY} at a time,
 * through the author's PDS from the DID document, with no auth.
 *
 * prism is asked on `prism.nearhorizon.app` directly, never through a PDS:
 *
 * - Signed in, with a service token of the current account through
 *   `getDirectPrismClient` (charged to prism's `plural_auth`, by DID). The
 *   token is taken first (`getDirectPrismToken`, which joins the identity
 *   prefetch's mint in flight at a cold start, P5R5-N7). A token that
 *   cannot be had, whether taken first or minted again inside the direct
 *   fetch after a 401 (then wrapped as `XrpcFetchError`, its `cause` the
 *   token error, P5R5-N4), sends the call without auth instead. A call prism
 *   still answers 401 after the fresh-token retry is sent again without
 *   auth, and that reader's S-2 calls go without auth for
 *   {@link NO_AUTH_WINDOW_MS}, asking for no token, so a refused token is
 *   not minted again on every batch. The window is S-2's own: Thread Lens
 *   and the private reads keep their tokens.
 * - Signed out (and on that fallback), a plain `fetch` with no
 *   `Authorization` and `cache: 'no-cache'` (P5R5-N3), charged to
 *   `plural_anon`, by IP.
 *
 * A 429 pauses the whole batcher until its wait (`Retry-After` first, then
 * `ratelimit-reset`, else 30 s, capped at 10 minutes, P5R5-N5): nothing is
 * sent for any key, and the refused asks fail with
 * {@link IdentityRateLimitedError}, which is not a failure (no negative
 * entry, cached answers keep showing). A 501 or 404 (S-2 not served) and a
 * signed-in reader whose features do not list `plural.read` answer every
 * record unknown. Every read times out after 3 s.
 *
 * One's own records (the current account's, and an account registered by
 * the composer's temporary client, PP-16) are read from the own PDS,
 * authenticated: `getRecord` and `listRecords`.
 */

import {
  type Client,
  lexToJson,
  type LexValue,
  XrpcError,
  XrpcFetchError,
  XrpcInvalidResponseError,
  XrpcResponseError,
} from '@atproto/lex'
import {type DidString, type NsidString} from '@atproto/syntax'
import {type QueryClient} from '@tanstack/react-query'

import {createServiceClient} from '#/lib/lexClient'
import {resolvePdsForIdentifier} from '#/state/queries/pds-detection'
import {networkAwareFetch} from '#/state/session/network'
import {
  BATCH_WINDOW_MS,
  DIRECT_READ_CONCURRENCY,
  MAX_CALL_DIDS,
  MAX_CALL_MEMBERS,
  MEMBER_PAGE_LIMIT,
  MEMBER_PAGES_MAX,
  NO_AUTH_WINDOW_MS,
  RATE_LIMIT_DEFAULT_MS,
  RATE_LIMIT_MAX_MS,
  READ_TIMEOUT_MS,
} from '#/horizon/identity/config'
import {
  parseFront,
  parseMember,
  parsePronouns,
  parseSystem,
  type PluralFront,
  type PluralMember,
  type PluralSystem,
  type Pronouns,
} from '#/horizon/identity/parse'
import {nearhorizon} from '#/horizon/lexicons'
import {
  PLURAL_FRONT_COLLECTION,
  PLURAL_MEMBER_COLLECTION,
  PLURAL_SELF_RKEY,
  PLURAL_SYSTEM_COLLECTION,
  PRONOUNS_COLLECTION,
} from '#/horizon/lexicons/nearhorizon'
import {authorPdsQueryKey, PDS_TTL_MS} from '#/horizon/private/adapt/pds'
import {
  getCurrentClients,
  PrivateClientUnavailableError,
} from '#/horizon/routing/current-clients'
import {getPrismFeatures} from '#/horizon/routing/features'
import {PRISM_URL} from '#/horizon/routing/prism'
import {
  DirectPrismRateLimitedError,
  getDirectPrismClient,
  getDirectPrismToken,
} from '#/horizon/routing/prism-direct'
import {IDENTITY_PRISM_READS} from '#/horizon/switches'
import {com} from '#/lexicons'

/** S-2's batch read, the token's `lxm`. */
export const GET_RECORDS_LXM = 'app.nearhorizon.plural.getRecords' as NsidString

/** S-2's member list, the token's `lxm`. */
export const LIST_MEMBERS_LXM =
  'app.nearhorizon.plural.listMembers' as NsidString

/** prism's feature id for S-2 (`getMembership.features`). */
export const PLURAL_READ_FEATURE = 'plural.read'

/**
 * One record's answer. `error` comes only from an own-PDS read (S-2 never
 * fails one record alone).
 */
export type ReadAnswer<T> =
  | {status: 'record'; value: T; cid?: string}
  | {status: 'none'}
  | {status: 'unknown'}
  | {status: 'error'; error: unknown}

/** One account's self-keyed records, and how they were asked. */
export type ActorAnswers = {
  did: string
  pronouns: ReadAnswer<Pronouns>
  system: ReadAnswer<PluralSystem>
  front: ReadAnswer<PluralFront>
  /**
   * Whether the answer came with the current account's token (the
   * signed-in cadence) or without (the signed-out cadence, PP-23). Own-PDS
   * answers are `true`; they are never unknown.
   */
  authed: boolean
}

export type MemberRead = {answer: ReadAnswer<PluralMember>; authed: boolean}

/** One member of a list: its rkey, CID and record. */
export type ListedMember = {rkey: string; cid?: string; value: PluralMember}

/**
 * An account's member list, ascending rkey. `partial`: not every member is
 * promised (prism's `partial`, or more than 10 pages); `unknown`: prism has
 * not listed the repo.
 */
export type MemberListRead =
  | {status: 'complete' | 'partial'; members: ListedMember[]; authed: boolean}
  | {status: 'unknown'; authed: boolean}

/**
 * prism limited S-2 (a 429): nothing is sent before `until` (epoch ms).
 * Not a failure: no negative entry, no episode change (4.5).
 */
export class IdentityRateLimitedError extends Error {
  readonly until: number

  constructor(until: number) {
    super('prism is limiting identity reads')
    this.name = 'IdentityRateLimitedError'
    this.until = until
  }
}

/**
 * A read that failed: a network error, a timeout, a 5xx or another 4xx.
 * Takes a 60 s negative entry (4.5).
 */
export class IdentityReadError extends Error {
  constructor(cause: unknown) {
    super('An identity read failed', {cause})
    this.name = 'IdentityReadError'
  }
}

/** Not served here (501 `MethodNotImplemented`, or a 404). */
const NOT_SERVED = Symbol('not served')

/**
 * Answers made up because prism gave none (not served, or not asked), as
 * against prism's own `unknown`: only these are read from the repo.
 */
const unanswered = new WeakSet<object>()

function markUnanswered<T extends object>(value: T): T {
  unanswered.add(value)
  return value
}

let pausedUntil = 0
/** Reader DID -> no token for S-2 before this time (P5R5-N4). */
const noAuthUntil = new Map<string, number>()
/** Own clients beyond the current account's (PP-16), by DID. */
const ownClients = new Map<string, Client>()

/** No S-2 call is sent before this time (epoch ms); 0 when not paused. */
export function identityPausedUntil(): number {
  return pausedUntil
}

/**
 * Register `client` as `did`'s own PDS client (the composer's temporary
 * client, 5D), so that account's records are read from its own PDS while
 * registered. Returns the unregister function.
 */
export function registerOwnIdentityClient(
  did: string,
  client: Client,
): () => void {
  ownClients.set(did, client)
  return () => {
    if (ownClients.get(did) === client) ownClients.delete(did)
  }
}

/**
 * The own PDS client for `did`: the current account's, or one registered
 * with {@link registerOwnIdentityClient}; `undefined` for anyone else.
 */
export function ownClientFor(did: string): Client | undefined {
  const current = getCurrentClients()
  if (current?.did === did) return current.pdsClient
  return ownClients.get(did)
}

/**
 * The wait after a 429 (P5R5-N5): `Retry-After` first (seconds, or an HTTP
 * date), then `ratelimit-reset` (epoch seconds), else 30 s; capped at 10
 * minutes so a bad header or a skewed clock cannot hold every read for
 * hours. Not `rateLimitWaitMs`, which prefers `ratelimit-reset`.
 */
export function identityRateLimitWaitMs(
  headers: Headers | undefined,
  now: number = Date.now(),
): number {
  let wait: number | undefined
  const retryAfter = headers?.get('retry-after')?.trim()
  if (retryAfter) {
    const ms = /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000
      : new Date(retryAfter).getTime() - now
    if (ms > 0) wait = ms
  }
  if (wait === undefined) {
    const reset = headers?.get('ratelimit-reset')?.trim()
    if (reset && /^\d+$/.test(reset)) {
      const ms = Number(reset) * 1000 - now
      if (ms > 0) wait = ms
    }
  }
  return Math.min(wait ?? RATE_LIMIT_DEFAULT_MS, RATE_LIMIT_MAX_MS)
}

function pause(headers: Headers | undefined): IdentityRateLimitedError {
  const now = Date.now()
  pausedUntil = Math.max(pausedUntil, now + identityRateLimitWaitMs(headers))
  return new IdentityRateLimitedError(pausedUntil)
}

function assertNotPaused() {
  if (pausedUntil > Date.now()) {
    throw new IdentityRateLimitedError(pausedUntil)
  }
}

/** A token error, not the network's (P5R5-N4). */
function isTokenFailure(error: unknown): boolean {
  return (
    error instanceof DirectPrismRateLimitedError ||
    error instanceof PrivateClientUnavailableError ||
    error instanceof XrpcError
  )
}

/**
 * Whether S-2 may be asked at all: never with `IDENTITY_PRISM_READS` off;
 * signed out always (the method answering is the discovery), signed in
 * unless the reader's features are known and leave out `plural.read`.
 */
function s2Served(): boolean {
  if (!IDENTITY_PRISM_READS) return false
  const current = getCurrentClients()
  if (!current) return true
  const features = getPrismFeatures(current.did)
  return !Array.isArray(features) || features.includes(PLURAL_READ_FEATURE)
}

function withTimeout(): {signal: AbortSignal; done: () => void} {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
  return {signal: controller.signal, done: () => clearTimeout(timer)}
}

type S2Params = Record<string, string | number | string[] | undefined>
type S2Result = {body: unknown; authed: boolean} | typeof NOT_SERVED

function notServedStatus(status: number): boolean {
  return status === 501 || status === 404
}

/** The signed-out call: a plain fetch, no auth, `cache: 'no-cache'`. */
async function unauthCall(
  lxm: NsidString,
  params: S2Params,
): Promise<S2Result> {
  const url = new URL(`/xrpc/${lxm}`, PRISM_URL)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item)
    } else {
      url.searchParams.set(key, String(value))
    }
  }
  const {signal, done} = withTimeout()
  try {
    let response: Response
    try {
      response = await networkAwareFetch(url.toString(), {
        cache: 'no-cache',
        signal,
      })
    } catch (error) {
      throw new IdentityReadError(error)
    }
    if (response.status === 429) throw pause(response.headers)
    if (notServedStatus(response.status)) return NOT_SERVED
    if (!response.ok) {
      throw new IdentityReadError(new Error(`HTTP ${response.status}`))
    }
    try {
      return {body: await response.json(), authed: false}
    } catch (error) {
      throw new IdentityReadError(error)
    }
  } finally {
    done()
  }
}

/** A direct prism call's error, classified. */
function classify(
  error: unknown,
): IdentityRateLimitedError | IdentityReadError | typeof NOT_SERVED {
  if (error instanceof XrpcResponseError) {
    if (error.status === 429) return pause(error.headers)
    if (
      notServedStatus(error.status) ||
      error.error === 'MethodNotImplemented'
    ) {
      return NOT_SERVED
    }
  }
  if (
    error instanceof XrpcInvalidResponseError &&
    notServedStatus(error.response.status)
  ) {
    return NOT_SERVED
  }
  return new IdentityReadError(error)
}

/**
 * One S-2 call: with the current account's token when it can be had, else
 * without (4.4, P5R5-N4).
 */
async function callS2(
  method:
    typeof nearhorizon.pluralGetRecords | typeof nearhorizon.pluralListMembers,
  lxm: NsidString,
  params: S2Params,
): Promise<S2Result> {
  assertNotPaused()
  const current = getCurrentClients()
  if (current && !inNoAuthWindow(current.did)) {
    const authed = await authedCall(
      current.did,
      current.pdsClient,
      method,
      lxm,
      params,
    )
    if (authed !== FALL_BACK) return authed
  }
  return unauthCall(lxm, params)
}

/** The authed call gave way to an unauthenticated one. */
const FALL_BACK = Symbol('fall back')

function inNoAuthWindow(did: string): boolean {
  const until = noAuthUntil.get(did)
  if (until === undefined) return false
  if (until > Date.now()) return true
  noAuthUntil.delete(did)
  return false
}

async function authedCall(
  did: string,
  pdsClient: Client,
  method:
    typeof nearhorizon.pluralGetRecords | typeof nearhorizon.pluralListMembers,
  lxm: NsidString,
  params: S2Params,
): Promise<S2Result | typeof FALL_BACK> {
  // The first token, taken before the call: any failure falls back.
  try {
    await getDirectPrismToken(pdsClient, lxm)
  } catch {
    return FALL_BACK
  }
  const {signal, done} = withTimeout()
  try {
    const body: unknown = await getDirectPrismClient(pdsClient).call(
      method as typeof nearhorizon.pluralGetRecords,
      params as never,
      {signal},
    )
    return {body, authed: true}
  } catch (error) {
    // The fresh mint after a 401 failed inside the fetch handler.
    if (error instanceof XrpcFetchError && isTokenFailure(error.cause)) {
      return FALL_BACK
    }
    // prism refused the fresh token too.
    if (error instanceof XrpcResponseError && error.status === 401) {
      noAuthUntil.set(did, Date.now() + NO_AUTH_WINDOW_MS)
      return FALL_BACK
    }
    const classified = classify(error)
    if (classified === NOT_SERVED) return NOT_SERVED
    throw classified
  } finally {
    done()
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON form, so a value can be parsed and persisted as it is. */
function jsonForm(value: unknown): unknown {
  try {
    return lexToJson(value as LexValue)
  } catch {
    return value
  }
}

type Kind = 'pronouns' | 'system' | 'front' | 'member'

/**
 * A record's parsed answer. A record that does not parse: pronouns show
 * nothing and block the short field (a record exists), a system still
 * signals a system, a member or front reads as absent.
 */
function parsed(
  kind: 'pronouns',
  raw: unknown,
  cid?: string,
): ReadAnswer<Pronouns>
function parsed(
  kind: 'system',
  raw: unknown,
  cid?: string,
): ReadAnswer<PluralSystem>
function parsed(
  kind: 'front',
  raw: unknown,
  cid?: string,
): ReadAnswer<PluralFront>
function parsed(
  kind: 'member',
  raw: unknown,
  cid?: string,
): ReadAnswer<PluralMember>
function parsed(kind: Kind, raw: unknown, cid?: string): ReadAnswer<unknown> {
  const value = jsonForm(raw)
  const withCid = <T>(v: T): ReadAnswer<T> =>
    cid === undefined
      ? {status: 'record', value: v}
      : {status: 'record', value: v, cid}
  switch (kind) {
    case 'pronouns':
      return withCid(
        parsePronouns(value) ?? {
          sets: [],
          displayMode: 'all',
          raw: isObject(value) ? value : {},
        },
      )
    case 'system':
      return withCid(parseSystem(value) ?? {raw: {}})
    case 'front': {
      const front = parseFront(value)
      return front ? withCid(front) : {status: 'none'}
    }
    case 'member': {
      const member = parseMember(value)
      return member ? withCid(member) : {status: 'none'}
    }
  }
}

/** An S-2 `#answer` (or `#memberAnswer`) as a {@link ReadAnswer}. */
function fromS2(kind: 'pronouns', answer: unknown): ReadAnswer<Pronouns>
function fromS2(kind: 'system', answer: unknown): ReadAnswer<PluralSystem>
function fromS2(kind: 'front', answer: unknown): ReadAnswer<PluralFront>
function fromS2(kind: 'member', answer: unknown): ReadAnswer<PluralMember>
function fromS2(kind: Kind, answer: unknown): ReadAnswer<unknown> {
  if (!isObject(answer)) return {status: 'unknown'}
  if (answer.status === 'none') return {status: 'none'}
  if (answer.status !== 'record' || answer.value === undefined) {
    return {status: 'unknown'}
  }
  const cid = typeof answer.cid === 'string' ? answer.cid : undefined
  return parsed(kind as 'pronouns', answer.value, cid)
}

function unknownActor(did: string, authed: boolean): ActorAnswers {
  return {
    did,
    pronouns: {status: 'unknown'},
    system: {status: 'unknown'},
    front: {status: 'unknown'},
    authed,
  }
}

export function memberUri(did: string, rkey: string): string {
  return `at://${did}/${PLURAL_MEMBER_COLLECTION}/${rkey}`
}

/** One planned `getRecords` call. */
export type PlannedCall = {actors: string[]; members: string[]}

/**
 * Split the asks into calls within prism's caps (P5R2-N11): at most 50
 * distinct DIDs per call, counting the member URIs' DIDs with the actors,
 * and at most 100 member URIs, keeping a DID's actor and member asks in one
 * call where they fit.
 */
export function planIdentityCalls(
  actors: readonly string[],
  members: readonly {did: string; uri: string}[],
): PlannedCall[] {
  const groups = new Map<string, {actor: boolean; uris: string[]}>()
  const group = (did: string) => {
    let g = groups.get(did)
    if (!g) {
      g = {actor: false, uris: []}
      groups.set(did, g)
    }
    return g
  }
  for (const did of actors) group(did).actor = true
  for (const {did, uri} of members) {
    const g = group(did)
    if (!g.uris.includes(uri)) g.uris.push(uri)
  }

  const calls: PlannedCall[] = []
  let call: PlannedCall & {dids: Set<string>} = {
    actors: [],
    members: [],
    dids: new Set(),
  }
  const next = () => {
    calls.push({actors: call.actors, members: call.members})
    call = {actors: [], members: [], dids: new Set()}
  }
  for (const [did, g] of groups) {
    const uris = [...g.uris]
    let actorPlaced = !g.actor
    // A DID with members fits better in a fresh call than split from them.
    if (
      call.dids.size > 0 &&
      uris.length > 0 &&
      uris.length <= MAX_CALL_MEMBERS &&
      call.members.length + uris.length > MAX_CALL_MEMBERS
    ) {
      next()
    }
    do {
      const full =
        (!call.dids.has(did) && call.dids.size >= MAX_CALL_DIDS) ||
        (uris.length > 0 && call.members.length >= MAX_CALL_MEMBERS)
      if (full) next()
      call.dids.add(did)
      if (!actorPlaced) {
        call.actors.push(did)
        actorPlaced = true
      }
      const take = Math.min(uris.length, MAX_CALL_MEMBERS - call.members.length)
      call.members.push(...uris.splice(0, take))
    } while (uris.length > 0)
  }
  if (call.dids.size > 0) next()
  return calls
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

type Batch = {
  actors: Map<string, Deferred<ActorAnswers>>
  members: Map<
    string,
    {did: string; rkey: string; deferred: Deferred<MemberRead>}
  >
}

let open: Batch | undefined
/** Asks sent or waiting, so a DID or member is in one call at a time. */
const actorAsks = new Map<string, Promise<ActorAnswers>>()
const memberAsks = new Map<string, Promise<MemberRead>>()

function openBatch(): Batch {
  if (!open) {
    const batch: Batch = {actors: new Map(), members: new Map()}
    open = batch
    setTimeout(() => flush(batch), BATCH_WINDOW_MS)
  }
  return open
}

function settle(
  batch: Batch,
  call: PlannedCall | undefined,
  outcome: {
    body?: unknown
    authed: boolean
    error?: unknown
    /** prism gave no answer: every ask is marked for the repo read. */
    unanswered?: boolean
  },
) {
  const mark = <T extends object>(value: T): T =>
    outcome.unanswered ? markUnanswered(value) : value
  const actors = call ? call.actors : Array.from(batch.actors.keys())
  const members = call ? call.members : Array.from(batch.members.keys())
  if (outcome.error !== undefined) {
    for (const did of actors) batch.actors.get(did)?.reject(outcome.error)
    for (const uri of members)
      batch.members.get(uri)?.deferred.reject(outcome.error)
    return
  }
  const body = isObject(outcome.body) ? outcome.body : {}
  const actorRows = new Map<string, Record<string, unknown>>()
  for (const row of Array.isArray(body.actors) ? body.actors : []) {
    if (isObject(row) && typeof row.did === 'string')
      actorRows.set(row.did, row)
  }
  const memberRows = new Map<string, unknown>()
  for (const row of Array.isArray(body.members) ? body.members : []) {
    if (isObject(row) && typeof row.uri === 'string')
      memberRows.set(row.uri, row)
  }
  for (const did of actors) {
    const row = actorRows.get(did)
    batch.actors.get(did)?.resolve(
      mark(
        row
          ? {
              did,
              pronouns: fromS2('pronouns', row.pronouns),
              system: fromS2('system', row.system),
              front: fromS2('front', row.front),
              authed: outcome.authed,
            }
          : unknownActor(did, outcome.authed),
      ),
    )
  }
  for (const uri of members) {
    batch.members.get(uri)?.deferred.resolve(
      mark({
        answer: fromS2('member', memberRows.get(uri)),
        authed: outcome.authed,
      }),
    )
  }
}

function flush(batch: Batch) {
  if (open === batch) open = undefined
  if (pausedUntil > Date.now()) {
    settle(batch, undefined, {
      authed: false,
      error: new IdentityRateLimitedError(pausedUntil),
    })
    return
  }
  if (!s2Served()) {
    settle(batch, undefined, {
      authed: !!getCurrentClients(),
      body: {},
      unanswered: true,
    })
    return
  }
  const calls = planIdentityCalls(
    Array.from(batch.actors.keys()),
    Array.from(batch.members.entries()).map(([uri, m]) => ({did: m.did, uri})),
  )
  for (const call of calls) {
    const params: S2Params = {}
    if (call.actors.length > 0) params.actors = call.actors
    if (call.members.length > 0) params.members = call.members
    callS2(nearhorizon.pluralGetRecords, GET_RECORDS_LXM, params).then(
      result => {
        if (result === NOT_SERVED) {
          settle(batch, call, {
            authed: !!getCurrentClients(),
            body: {},
            unanswered: true,
          })
        } else {
          settle(batch, call, {authed: result.authed, body: result.body})
        }
      },
      error => settle(batch, call, {authed: false, error}),
    )
  }
}

/** Ask S-2 for `did`'s self-keyed records, batched (4.5). */
function askActor(did: string): Promise<ActorAnswers> {
  const asked = actorAsks.get(did)
  if (asked) return asked
  const d = deferred<ActorAnswers>()
  openBatch().actors.set(did, d)
  const promise = d.promise.finally(() => {
    if (actorAsks.get(did) === promise) actorAsks.delete(did)
  })
  actorAsks.set(did, promise)
  return promise
}

/** Ask S-2 for one member record, batched (4.5). */
function askMember(did: string, rkey: string): Promise<MemberRead> {
  const uri = memberUri(did, rkey)
  const asked = memberAsks.get(uri)
  if (asked) return asked
  const d = deferred<MemberRead>()
  openBatch().members.set(uri, {did, rkey, deferred: d})
  const promise = d.promise.finally(() => {
    if (memberAsks.get(uri) === promise) memberAsks.delete(uri)
  })
  memberAsks.set(uri, promise)
  return promise
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof XrpcResponseError && error.error === 'RecordNotFound'
}

/** One record from a PDS: record, none, or error. */
async function pdsRecord(
  client: Client,
  did: string,
  collection: string,
  rkey: string,
): Promise<
  | {status: 'record'; value: unknown; cid?: string}
  | {status: 'none'}
  | {status: 'error'; error: unknown}
> {
  const {signal, done} = withTimeout()
  try {
    const res = await client.call(
      com.atproto.repo.getRecord,
      {repo: did as DidString, collection: collection as NsidString, rkey},
      {signal},
    )
    return {status: 'record', value: res.value, cid: res.cid}
  } catch (error) {
    if (isRecordNotFound(error)) return {status: 'none'}
    return {status: 'error', error}
  } finally {
    done()
  }
}

function fromPds<K extends 'pronouns' | 'system' | 'front' | 'member'>(
  kind: K,
  read: Awaited<ReturnType<typeof pdsRecord>>,
) {
  if (read.status !== 'record') return read
  return parsed(kind as 'pronouns', read.value, read.cid)
}

const ownActorReads = new Map<string, Promise<ActorAnswers>>()
const repoActorReads = new Map<string, Promise<ActorAnswers>>()

/** `did`'s self-keyed records from a repo client: never unknown. */
function readRepoActor(
  did: string,
  client: Client,
  authed: boolean,
  inFlight: Map<string, Promise<ActorAnswers>>,
): Promise<ActorAnswers> {
  const joined = inFlight.get(did)
  if (joined) return joined
  const promise = Promise.all([
    pdsRecord(client, did, PRONOUNS_COLLECTION, PLURAL_SELF_RKEY),
    pdsRecord(client, did, PLURAL_SYSTEM_COLLECTION, PLURAL_SELF_RKEY),
    pdsRecord(client, did, PLURAL_FRONT_COLLECTION, PLURAL_SELF_RKEY),
  ])
    .then(([pronouns, system, front]): ActorAnswers => ({
      did,
      pronouns: fromPds('pronouns', pronouns),
      system: fromPds('system', system) as ReadAnswer<PluralSystem>,
      front: fromPds('front', front) as ReadAnswer<PluralFront>,
      authed,
    }))
    .finally(() => {
      if (inFlight.get(did) === promise) inFlight.delete(did)
    })
  inFlight.set(did, promise)
  return promise
}

/** One's own self-keyed records, from one's own PDS. */
function readOwnActor(did: string, client: Client): Promise<ActorAnswers> {
  return readRepoActor(did, client, true, ownActorReads)
}

/*
 * The direct reads' limit: a slot is handed straight to the next waiter, so
 * no more than DIRECT_READ_CONCURRENCY run at once.
 */
let directActive = 0
const directQueue: (() => void)[] = []

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (directActive < DIRECT_READ_CONCURRENCY) {
    directActive++
  } else {
    await new Promise<void>(resolve => directQueue.push(resolve))
  }
  try {
    return await task()
  } finally {
    const next = directQueue.shift()
    if (next) next()
    else directActive--
  }
}

/** One client per PDS URL for the direct reads, without auth. */
const repoClients = new Map<string, Client>()

/**
 * A client for `did`'s own PDS, from its DID document (cached with the
 * private adapter's author PDS entries); `undefined` when it cannot be
 * resolved.
 */
async function repoClient(
  did: string,
  queryClient: QueryClient | undefined,
): Promise<Client | undefined> {
  const resolve = async () => {
    const identity = await resolvePdsForIdentifier(did)
    if (!identity?.pdsUrl) throw new Error('PDS not resolved')
    return identity.pdsUrl
  }
  try {
    const url = queryClient
      ? await queryClient.fetchQuery({
          queryKey: authorPdsQueryKey(did),
          staleTime: PDS_TTL_MS,
          gcTime: 24 * 60 * 60 * 1000,
          queryFn: resolve,
        })
      : await resolve()
    let client = repoClients.get(url)
    if (!client) {
      client = createServiceClient(url)
      repoClients.set(url, client)
    }
    return client
  } catch {
    return undefined
  }
}

/** Options every read takes. */
export type ReadOptions = {
  /** The hooks' query client, for the author's PDS URL. */
  queryClient?: QueryClient
}

/** `did`'s self-keyed records from its own repo; `undefined` if unreachable. */
async function directActor(
  did: string,
  queryClient: QueryClient | undefined,
): Promise<ActorAnswers | undefined> {
  const client = await repoClient(did, queryClient)
  if (!client) return undefined
  return limited(() =>
    readRepoActor(did, client, !!getCurrentClients(), repoActorReads),
  )
}

/**
 * `did`'s pronouns, system and front: from the own PDS for one's own
 * account, else S-2, batched, else the author's repo when prism gave no
 * answer. Throws {@link IdentityRateLimitedError} while paused and
 * {@link IdentityReadError} when prism's call and the repo read both failed.
 */
export async function readActorRecords(
  did: string,
  {queryClient}: ReadOptions = {},
): Promise<ActorAnswers> {
  const own = ownClientFor(did)
  if (own) return readOwnActor(did, own)
  let answers: ActorAnswers
  try {
    answers = await askActor(did)
  } catch (error) {
    if (error instanceof IdentityRateLimitedError) throw error
    const direct = await directActor(did, queryClient)
    if (direct) return direct
    throw error
  }
  if (!unanswered.has(answers)) return answers
  return (await directActor(did, queryClient)) ?? answers
}

/** One member record from its author's repo; `undefined` if unreachable. */
async function directMember(
  did: string,
  rkey: string,
  queryClient: QueryClient | undefined,
): Promise<MemberRead | undefined> {
  const client = await repoClient(did, queryClient)
  if (!client) return undefined
  const read = await limited(() =>
    pdsRecord(client, did, PLURAL_MEMBER_COLLECTION, rkey),
  )
  return {
    answer: fromPds('member', read) as ReadAnswer<PluralMember>,
    authed: !!getCurrentClients(),
  }
}

/**
 * One member record: own PDS for one's own account, else S-2, batched, else
 * the author's repo when prism gave no answer.
 */
export async function readMemberRecord(
  did: string,
  rkey: string,
  {queryClient}: ReadOptions = {},
): Promise<MemberRead> {
  const own = ownClientFor(did)
  if (own) {
    const read = await pdsRecord(own, did, PLURAL_MEMBER_COLLECTION, rkey)
    return {
      answer: fromPds('member', read) as ReadAnswer<PluralMember>,
      authed: true,
    }
  }
  let read: MemberRead
  try {
    read = await askMember(did, rkey)
  } catch (error) {
    if (error instanceof IdentityRateLimitedError) throw error
    const direct = await directMember(did, rkey, queryClient)
    if (direct) return direct
    throw error
  }
  if (!unanswered.has(read)) return read
  return (await directMember(did, rkey, queryClient)) ?? read
}

function byRkey(a: ListedMember, b: ListedMember): number {
  return a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0
}

function rkeyOf(uri: string): string | undefined {
  const rkey = uri.split('/').pop()
  return rkey && rkey.length > 0 ? rkey : undefined
}

/** One's own member list from a PDS: `listRecords`, sorted ascending. */
async function pdsMemberList(
  client: Client,
  did: string,
): Promise<MemberListRead> {
  const members: ListedMember[] = []
  let cursor: string | undefined
  for (let page = 0; page < MEMBER_PAGES_MAX; page++) {
    const {signal, done} = withTimeout()
    let res
    try {
      res = await client.call(
        com.atproto.repo.listRecords,
        {
          repo: did as DidString,
          collection: PLURAL_MEMBER_COLLECTION,
          limit: MEMBER_PAGE_LIMIT,
          cursor,
        },
        {signal},
      )
    } catch (error) {
      throw new IdentityReadError(error)
    } finally {
      done()
    }
    for (const record of res.records) {
      const rkey = rkeyOf(record.uri)
      const value = parseMember(jsonForm(record.value))
      if (rkey && value) members.push({rkey, cid: record.cid, value})
    }
    cursor = res.cursor
    if (!cursor || res.records.length === 0) {
      return {status: 'complete', members: members.sort(byRkey), authed: true}
    }
  }
  return {status: 'partial', members: members.sort(byRkey), authed: true}
}

/** `did`'s member list through S-2's `listMembers`, paged. */
async function s2MemberList(did: string): Promise<MemberListRead> {
  if (!s2Served()) {
    return markUnanswered({status: 'unknown', authed: !!getCurrentClients()})
  }
  const members: ListedMember[] = []
  let partial = false
  let authed = false
  let cursor: string | undefined
  for (let page = 0; page < MEMBER_PAGES_MAX; page++) {
    const params: S2Params = {actor: did, limit: MEMBER_PAGE_LIMIT}
    if (cursor) params.cursor = cursor
    const result = await callS2(
      nearhorizon.pluralListMembers,
      LIST_MEMBERS_LXM,
      params,
    )
    if (result === NOT_SERVED) {
      return markUnanswered({status: 'unknown', authed: !!getCurrentClients()})
    }
    authed = result.authed
    const body = isObject(result.body) ? result.body : {}
    if (
      body.status === 'unknown' ||
      (body.status !== 'complete' && body.status !== 'partial')
    ) {
      return {status: 'unknown', authed}
    }
    if (body.status === 'partial') partial = true
    for (const row of Array.isArray(body.members) ? body.members : []) {
      if (!isObject(row)) continue
      const rkey =
        typeof row.rkey === 'string'
          ? row.rkey
          : typeof row.uri === 'string'
            ? rkeyOf(row.uri)
            : undefined
      const value = parseMember(jsonForm(row.value))
      if (rkey && value) {
        members.push({
          rkey,
          cid: typeof row.cid === 'string' ? row.cid : undefined,
          value,
        })
      }
    }
    cursor = typeof body.cursor === 'string' ? body.cursor : undefined
    if (!cursor) {
      return {
        status: partial ? 'partial' : 'complete',
        members: members.sort(byRkey),
        authed,
      }
    }
  }
  return {status: 'partial', members: members.sort(byRkey), authed}
}

/** `did`'s member list from its own repo; `undefined` if unreachable. */
async function directMemberList(
  did: string,
  queryClient: QueryClient | undefined,
): Promise<MemberListRead | undefined> {
  const client = await repoClient(did, queryClient)
  if (!client) return undefined
  const read = await limited(() => pdsMemberList(client, did))
  return {...read, authed: !!getCurrentClients()}
}

/**
 * `did`'s member list, ascending rkey, up to 10 pages of 100: from the own
 * PDS for one's own account, else S-2 (not batched: one call per page), else
 * the author's repo when prism gave no answer.
 */
export async function readMemberList(
  did: string,
  {queryClient}: ReadOptions = {},
): Promise<MemberListRead> {
  const own = ownClientFor(did)
  if (own) return pdsMemberList(own, did)
  let read: MemberListRead
  try {
    read = await s2MemberList(did)
  } catch (error) {
    if (error instanceof IdentityRateLimitedError) throw error
    let direct: MemberListRead | undefined
    try {
      direct = await directMemberList(did, queryClient)
    } catch {
      direct = undefined
    }
    if (direct) return direct
    throw error
  }
  if (!unanswered.has(read)) return read
  return (await directMemberList(did, queryClient)) ?? read
}

/**
 * Test-only: forget the pause, the no-auth windows, the registered clients
 * and every ask in flight.
 */
export function resetIdentityReads() {
  pausedUntil = 0
  noAuthUntil.clear()
  ownClients.clear()
  open = undefined
  actorAsks.clear()
  memberAsks.clear()
  ownActorReads.clear()
  repoActorReads.clear()
  repoClients.clear()
  directActive = 0
  directQueue.length = 0
}
