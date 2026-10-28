/*
 * Audience records (`tools.kryphocron.policy.audience`) in the account's own
 * repo: listing them, finding or creating the standing audiences the composer
 * offers (Horizon members, Followers, People you follow, Only me), creating,
 * editing and deleting list audiences, and their labels.
 *
 * A create goes through the posting writer (2K design 4.7); an edit (lists
 * only) and a delete through the repo writer, so they work on any PDS
 * whatever the posting route. On locus they wait on A-4 (`AUDIENCE_EDIT`,
 * PA-14): aurora's `manageAudience` only creates there today.
 */

import {type Client, type LexMap, XrpcResponseError} from '@atproto/lex'
import {AtUri, type DidString, toDatetimeString} from '@atproto/syntax'
import {plural, t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'
import {countGraphemes} from 'unicode-segmenter/grapheme'

import {STALE} from '#/state/queries'
import {kryphocron} from '#/horizon/lexicons'
import {
  audiencesOnPrism,
  createPrismAudience,
  deletePrismAudience,
  listPrismAudiences,
  updatePrismAudience,
} from '#/horizon/private/api/prism-audiences'
import {
  requestRecordCaughtUp,
  requestRecordQuietly,
} from '#/horizon/private/api/request-record'
import {utf8Length} from '#/horizon/private/api/validate'
import {
  type PostingWriter,
  postingWriterForClient,
  repoWriterForClient,
} from '#/horizon/private/api/writer'
import {AUDIENCE_EDIT} from '#/horizon/private/server-support'
import {AUDIENCE_COLLECTION} from '#/horizon/private/uri'
import {
  clientDid,
  type RepoRoute,
  repoRouteForDid,
} from '#/horizon/routing/write-route'
import {com} from '#/lexicons'

/**
 * The fixed modes the composer offers, created on first use and reused.
 */
export type StandingMode = 'everyone' | 'followers' | 'following' | 'nobody'

/**
 * One audience record, as read from the repo.
 */
export type AudienceEntry = {
  uri: string
  rkey: string
  /** The record's `mode`, `list` when absent; any other string is kept. */
  mode: string
  name?: string
  /** Member DIDs; other entries are ignored. */
  members: string[]
  /** The record's CID as listed: the swap for an edit (4.7). */
  cid?: string
  /** The record's `createdAt`, kept by an edit. */
  createdAt?: string
}

/**
 * The audience a private post or reply was refused for no longer exists.
 */
export class PrivateAudienceMissingError extends Error {
  constructor() {
    super(t`This audience no longer exists. Choose another audience.`)
    this.name = 'PrivateAudienceMissingError'
  }
}

/**
 * A private write called with no audience chosen (`{kind: 'unpicked'}`).
 * Thrown before anything is captured, saved, found, created or sent.
 */
export class PrivateAudienceUnpickedError extends Error {
  constructor() {
    super(t`Choose who can see this post.`)
    this.name = 'PrivateAudienceUnpickedError'
  }
}

const MAX_NAME_GRAPHEMES = 64
const MAX_NAME_BYTES = 640

/**
 * The account's clients the audience calls need.
 */
export type AudienceClients = {
  did: string
  pdsClient: Client
  prismClient: Client
}

export const audiencesQueryKey = (did: string) => ['horizon-audiences', did]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One listed record as an {@link AudienceEntry}. Timestamps may be absent
 * (aurora's signup default writes only `$type` and `mode`); nothing depends
 * on them.
 */
export function readAudienceRecord(
  uri: string,
  value: unknown,
  cid?: string,
): AudienceEntry | undefined {
  if (!isObject(value)) return undefined
  const rkey = uri.split('/').pop() ?? ''
  const mode = typeof value.mode === 'string' ? value.mode : 'list'
  const name =
    typeof value.name === 'string' && value.name.length > 0
      ? value.name
      : undefined
  const members = Array.isArray(value.members)
    ? value.members.filter(
        (member): member is string =>
          typeof member === 'string' && member.startsWith('did:'),
      )
    : []
  const createdAt =
    typeof value.createdAt === 'string' ? value.createdAt : undefined
  return {uri, rkey, mode, name, members, cid, createdAt}
}

/**
 * Every audience record in the account's repo, following the cursor to the
 * end. Read from the PDS directly, as stored.
 */
export async function listAudiences(
  pdsClient: Client,
  did: string,
): Promise<AudienceEntry[]> {
  const entries: AudienceEntry[] = []
  let cursor: string | undefined
  do {
    const page = await pdsClient.call(com.atproto.repo.listRecords, {
      repo: did as DidString,
      collection: AUDIENCE_COLLECTION,
      limit: 100,
      cursor,
    })
    for (const record of page.records) {
      const entry = readAudienceRecord(record.uri, record.value, record.cid)
      if (entry) entries.push(entry)
    }
    cursor = page.records.length > 0 ? page.cursor : undefined
  } while (cursor)
  return entries
}

/**
 * The account's audiences from wherever they are held: prism once it lists
 * `private.audiences` (audience lists are private, skydeval 2026-10-27),
 * else the repo.
 */
export async function loadAudiences(
  clients: AudienceClients,
): Promise<AudienceEntry[]> {
  if (!audiencesOnPrism(clients.did)) {
    return listAudiences(clients.pdsClient, clients.did)
  }
  const rows = await listPrismAudiences(clients.prismClient, clients.did)
  const entries: AudienceEntry[] = []
  for (const row of rows) {
    const entry = readAudienceRecord(row.uri, row.record, row.cid)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * The audience list's query options, shared by the hook and the write path.
 */
export function audiencesQueryOptions(clients: AudienceClients) {
  return {
    queryKey: audiencesQueryKey(clients.did),
    queryFn: () => loadAudiences(clients),
    staleTime: STALE.MINUTES.FIVE,
  }
}

/**
 * The account's audiences, through the query cache.
 */
export function fetchAudiences(
  queryClient: QueryClient,
  clients: AudienceClients,
): Promise<AudienceEntry[]> {
  return queryClient.fetchQuery(audiencesQueryOptions(clients))
}

/**
 * The standing audience for `mode`: the first unnamed record of that mode by
 * rkey (TIDs sort by time, so the oldest). A named record is never taken, so
 * a user's own list named "Followers" is never reused for the Followers
 * choice.
 */
export function pickStandingAudience(
  entries: readonly AudienceEntry[],
  mode: StandingMode,
): AudienceEntry | undefined {
  return entries
    .filter(entry => entry.mode === mode && entry.name === undefined)
    .sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0))[0]
}

const STANDING_ORDER: StandingMode[] = [
  'everyone',
  'followers',
  'following',
  'nobody',
]

/**
 * The Audiences screen's order: the standing audiences that exist, in the
 * fixed order, then every other audience (lists, and records of modes Horizon
 * does not know) by label. Extra unnamed records of a standing mode (two tabs
 * creating one at once) are not shown.
 */
export function orderAudiences(entries: readonly AudienceEntry[]): {
  standing: AudienceEntry[]
  lists: AudienceEntry[]
} {
  const standing = STANDING_ORDER.map(mode =>
    pickStandingAudience(entries, mode),
  ).filter((entry): entry is AudienceEntry => !!entry)
  const standingModes: readonly string[] = STANDING_ORDER
  const lists = entries
    .filter(
      entry =>
        !(entry.name === undefined && standingModes.includes(entry.mode)),
    )
    .sort((x, y) =>
      audienceLabel(x, {isSelf: true}).localeCompare(
        audienceLabel(y, {isSelf: true}),
      ),
    )
  return {standing, lists}
}

/**
 * On repo route `stock`, a cached audience list older than this is not
 * trusted for a write that names one of its audiences (4.7): the audience
 * may have been deleted elsewhere since.
 */
export const CACHED_AUDIENCE_CONFIRM_MS = 10_000

/**
 * Whether one audience record exists on its owner's PDS: `present` for a
 * record that parses, `absent` for `RecordNotFound`, `unknown` for any other
 * error or a value that does not parse.
 */
export async function readAudienceState(
  pdsClient: Client,
  uri: string,
): Promise<'present' | 'absent' | 'unknown'> {
  try {
    return (await readAudienceRecordAt(pdsClient, uri)) ? 'present' : 'unknown'
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return 'absent'
    }
    return 'unknown'
  }
}

/** Fetch the list fresh into the cache; a failure throws, before any write. */
async function refetchAudiences(
  queryClient: QueryClient,
  clients: AudienceClients,
): Promise<AudienceEntry[]> {
  const fresh = await loadAudiences(clients)
  queryClient.setQueryData(audiencesQueryKey(clients.did), fresh)
  return fresh
}

/**
 * The audience `pick` finds for a write, through the cache. On repo route
 * `stock` a hit from a cached list older than
 * {@link CACHED_AUDIENCE_CONFIRM_MS} is confirmed with one `getRecord`:
 * `present` keeps it; `absent` fetches the list fresh and picks again
 * without it, as if the cache had missed; `unknown` fetches the list fresh
 * and lets it decide. With `refetchOnMiss`, a miss fetches the list fresh
 * once.
 */
async function findForWrite(
  queryClient: QueryClient,
  clients: AudienceClients,
  pick: (entries: readonly AudienceEntry[]) => AudienceEntry | undefined,
  {refetchOnMiss}: {refetchOnMiss: boolean},
): Promise<AudienceEntry | undefined> {
  const repoRoute = repoRouteForDid(clientDid(clients.pdsClient) ?? clients.did)
  const onPrism = audiencesOnPrism(clients.did)
  const cached = await fetchAudiences(queryClient, clients)
  const hit = pick(cached)
  if (hit) {
    const listedAt =
      queryClient.getQueryState(audiencesQueryKey(clients.did))
        ?.dataUpdatedAt ?? 0
    if (
      (repoRoute !== 'stock' && !onPrism) ||
      Date.now() - listedAt <= CACHED_AUDIENCE_CONFIRM_MS
    ) {
      return hit
    }
    /*
     * prism holds no single-audience read: an older cached hit is checked
     * against a fresh list instead (it may have been deleted elsewhere).
     */
    if (onPrism) return pick(await refetchAudiences(queryClient, clients))
    const state = await readAudienceState(clients.pdsClient, hit.uri)
    if (state === 'present') return hit
    const fresh = await refetchAudiences(queryClient, clients)
    return pick(
      state === 'absent' ? fresh.filter(entry => entry.uri !== hit.uri) : fresh,
    )
  }
  if (!refetchOnMiss) return undefined
  return pick(await refetchAudiences(queryClient, clients))
}

/**
 * The URI of the standing audience for `mode`, creating it through the
 * posting writer when the account has none. `writer` is the caller's, taken
 * at its entry (PA-20); without one it is taken now. Two tabs creating one at
 * once may make two records; {@link pickStandingAudience} picks the same one
 * afterwards. A failed create throws.
 */
export async function findOrCreateStandingAudience(
  queryClient: QueryClient,
  clients: AudienceClients,
  mode: StandingMode,
  writer: PostingWriter = postingWriterForClient(
    clients.pdsClient,
    clients.did,
  ),
): Promise<string> {
  const existing = await findForWrite(
    queryClient,
    clients,
    entries => pickStandingAudience(entries, mode),
    {refetchOnMiss: false},
  )
  if (existing) return existing.uri
  const now = toDatetimeString(new Date())
  const record: LexMap = {
    $type: AUDIENCE_COLLECTION,
    mode,
    createdAt: now,
    updatedAt: now,
  }
  if (audiencesOnPrism(clients.did)) {
    /*
     * prism commits the row before it answers, so the post naming it next is
     * served at once: no `requestRecord` wait (prism's reply 1).
     */
    const created = await createOnPrism(clients, record)
    void queryClient.invalidateQueries({
      queryKey: audiencesQueryKey(clients.did),
    })
    return created
  }
  const res = await writer.createAudience(record)
  void queryClient.invalidateQueries({queryKey: audiencesQueryKey(clients.did)})
  if (writer.route === 'encode') {
    /*
     * On the encode route the compose names it next (2K design 4.7): prism is
     * asked to index it first, waiting at most three seconds, so readers are
     * served the post at once. Never fails the write.
     */
    await requestRecordCaughtUp(clients.prismClient, res.uri)
  } else {
    requestRecordQuietly(clients.prismClient, res.uri)
  }
  return res.uri
}

/**
 * Check that a list audience the composer names still exists in the
 * account's repo, refetching the list once if the cached one lacks it (and,
 * on repo route `stock`, confirming an older cached hit). aurora does not
 * check this, and a post naming a missing audience would be readable by its
 * author alone, so a miss throws {@link PrivateAudienceMissingError} before
 * anything is written.
 */
export async function assertOwnAudienceExists(
  queryClient: QueryClient,
  clients: AudienceClients,
  uri: string,
): Promise<void> {
  const found = await findForWrite(
    queryClient,
    clients,
    entries => entries.find(entry => entry.uri === uri),
    {refetchOnMiss: true},
  )
  if (!found) throw new PrivateAudienceMissingError()
}

/**
 * The name of a list audience is too long.
 */
export class AudienceNameInvalidError extends Error {
  constructor() {
    super(t`List names can be at most 64 characters.`)
    this.name = 'AudienceNameInvalidError'
  }
}

/**
 * The account already holds as many audiences as prism keeps (200).
 */
export class AudienceLimitError extends Error {
  constructor() {
    super(
      t`You’ve reached the limit of ${MAX_AUDIENCES} audiences. Delete one to make another.`,
    )
    this.name = 'AudienceLimitError'
  }
}

/**
 * A list has more people than an audience can hold (1000).
 */
export class AudienceMembersLimitError extends Error {
  constructor() {
    super(t`A list can have at most ${MAX_MEMBERS} people.`)
    this.name = 'AudienceMembersLimitError'
  }
}

/** prism's caps (prism's private audiences reply, Q-2). */
export const MAX_AUDIENCES = 200
export const MAX_MEMBERS = 1000

/**
 * The members a list audience is written with: DIDs only, de-duplicated,
 * without the author (who always reads their own posts).
 */
export function normalizeMembers(
  members: readonly string[],
  ownDid: string,
): string[] {
  return Array.from(
    new Set(
      members.filter(member => member.startsWith('did:') && member !== ownDid),
    ),
  )
}

/** {@link normalizeMembers}, refused past {@link MAX_MEMBERS}. */
function membersFor(members: readonly string[], ownDid: string): string[] {
  const normalized = normalizeMembers(members, ownDid)
  if (normalized.length > MAX_MEMBERS) throw new AudienceMembersLimitError()
  return normalized
}

/** A create on prism, its cap refusal worded. Answers the URI. */
async function createOnPrism(
  clients: AudienceClients,
  record: LexMap,
): Promise<string> {
  try {
    const res = await createPrismAudience(
      clients.prismClient,
      clients.did,
      record,
    )
    return res.uri
  } catch (error) {
    if (error instanceof XrpcResponseError && error.error === 'LimitReached') {
      throw new AudienceLimitError()
    }
    throw error
  }
}

/** A list name, trimmed and checked as `manageAudience` checks it. */
function listNameFor(name: string): string {
  const trimmed = name.trim()
  if (
    trimmed.length === 0 ||
    countGraphemes(trimmed) > MAX_NAME_GRAPHEMES ||
    utf8Length(trimmed) > MAX_NAME_BYTES
  ) {
    throw new AudienceNameInvalidError()
  }
  return trimmed
}

/**
 * Create a named list audience through the posting writer. Returns its URI.
 */
export async function createListAudience(
  queryClient: QueryClient,
  clients: AudienceClients,
  {name, members}: {name: string; members: readonly string[]},
): Promise<string> {
  const trimmed = listNameFor(name)
  const now = toDatetimeString(new Date())
  const record: LexMap = {
    $type: AUDIENCE_COLLECTION,
    mode: 'list',
    name: trimmed,
    members: membersFor(members, clients.did),
    createdAt: now,
    updatedAt: now,
  }
  if (audiencesOnPrism(clients.did)) {
    const uri = await createOnPrism(clients, record)
    await queryClient.invalidateQueries({
      queryKey: audiencesQueryKey(clients.did),
    })
    return uri
  }
  const writer = postingWriterForClient(clients.pdsClient, clients.did)
  const res = await writer.createAudience(record)
  requestRecordQuietly(clients.prismClient, res.uri)
  await queryClient.invalidateQueries({
    queryKey: audiencesQueryKey(clients.did),
  })
  return res.uri
}

/**
 * The list changed since its editor was opened (`InvalidSwap`); nothing was
 * written.
 */
export class AudienceChangedError extends Error {
  constructor() {
    super(t`This list changed since you opened it. Close and try again.`)
    this.name = 'AudienceChangedError'
  }
}

/**
 * Whether the Audiences screen offers edit and delete (PA-14): always once
 * prism holds the account's audiences; else on repo route `stock` always,
 * whatever the posting route, and on locus once A-4 is live.
 */
export function audienceEditAvailable(
  repoRoute: RepoRoute,
  onPrism = false,
): boolean {
  return (
    onPrism || repoRoute === 'stock' || (repoRoute === 'locus' && AUDIENCE_EDIT)
  )
}

/**
 * Whether `entry` may be edited: lists only. A standing audience is never
 * renamed, because {@link pickStandingAudience} would then skip it and the
 * next compose would silently make a second one.
 */
export function isEditableAudience(entry: AudienceEntry): boolean {
  return entry.mode === 'list'
}

/**
 * Rename a list audience or change its members, through the repo writer,
 * swapping on the CID it was listed with (always: PA-24). A stale CID fails
 * as {@link AudienceChangedError}.
 */
export async function updateListAudience(
  queryClient: QueryClient,
  clients: AudienceClients,
  {
    entry,
    name,
    members,
  }: {entry: AudienceEntry; name: string; members: readonly string[]},
): Promise<void> {
  if (!isEditableAudience(entry) || !entry.cid) throw new AudienceChangedError()
  const trimmed = listNameFor(name)
  const now = toDatetimeString(new Date())
  const record: LexMap = {
    $type: AUDIENCE_COLLECTION,
    mode: 'list',
    name: trimmed,
    members: membersFor(members, clients.did),
    createdAt: entry.createdAt ?? now,
    updatedAt: now,
  }
  const onPrism = audiencesOnPrism(clients.did)
  try {
    if (onPrism) {
      await updatePrismAudience(clients.prismClient, clients.did, {
        uri: entry.uri,
        record,
        swapCid: entry.cid,
      })
    } else {
      await repoWriterForClient(clients.pdsClient).updateAudienceRecord(
        entry.uri,
        record,
        entry.cid,
      )
    }
  } catch (error) {
    if (error instanceof XrpcResponseError && error.error === 'InvalidSwap') {
      throw new AudienceChangedError()
    }
    throw error
  }
  if (!onPrism) requestRecordQuietly(clients.prismClient, entry.uri)
  await queryClient.invalidateQueries({
    queryKey: audiencesQueryKey(clients.did),
  })
}

/**
 * Delete an audience (any mode) through the repo writer. Posts naming it
 * become visible to their author only; a standing mode's next compose makes
 * a new one. The entry leaves the cached list once the delete succeeds, so
 * no write trusts it (4.7), and the list is fetched again.
 */
export async function deleteAudience(
  queryClient: QueryClient,
  clients: AudienceClients,
  uri: string,
): Promise<void> {
  const onPrism = audiencesOnPrism(clients.did)
  if (onPrism) {
    await deletePrismAudience(clients.prismClient, clients.did, uri)
  } else {
    await repoWriterForClient(clients.pdsClient).deleteAudience(uri)
  }
  queryClient.setQueryData<AudienceEntry[]>(
    audiencesQueryKey(clients.did),
    entries => entries?.filter(entry => entry.uri !== uri),
  )
  if (!onPrism) requestRecordQuietly(clients.prismClient, uri)
  void queryClient.invalidateQueries({queryKey: audiencesQueryKey(clients.did)})
}

/**
 * Read one audience record from its owner's PDS, with any client for that
 * PDS (7.2: an unauthenticated read; the record is a plain record).
 * `undefined` when the value is not an object.
 */
export async function readAudienceRecordAt(
  client: Client,
  uri: string,
): Promise<AudienceEntry | undefined> {
  const {host, rkey} = new AtUri(uri)
  const res = await client.call(com.atproto.repo.getRecord, {
    repo: host,
    collection: AUDIENCE_COLLECTION,
    rkey,
  })
  return readAudienceRecord(uri, res.value)
}

/**
 * Whose audience a label describes.
 */
export type AudienceOwner = {isSelf: true} | {isSelf: false; handle: string}

/**
 * The label of an audience: its name when it has one; otherwise worded by
 * mode, and for the relational modes by whose audience it is.
 */
export function audienceLabel(
  entry: Pick<AudienceEntry, 'mode' | 'name' | 'members'>,
  owner: AudienceOwner,
): string {
  if (entry.name) return entry.name
  switch (entry.mode) {
    case 'everyone':
      return t`Horizon members`
    case 'list':
      return plural(entry.members.length, {one: '# person', other: '# people'})
    case 'followers':
      return owner.isSelf ? t`Your followers` : t`Followers of @${owner.handle}`
    case 'following':
      return owner.isSelf
        ? t`People you follow`
        : t`People @${owner.handle} follows`
    case 'nobody':
      return owner.isSelf ? t`Only you` : t`Only @${owner.handle}`
    default:
      return t`Custom audience`
  }
}

/**
 * What a private post's audience label is built from (7.2).
 */
export type PostAudienceSource = {
  /** The audience the post names; absent for a self-only post. */
  audienceUri: string | undefined
  currentDid: string | undefined
  /** The current account's audiences, once loaded. */
  ownAudiences: readonly AudienceEntry[] | undefined
  /** Another account's audience record from its PDS, once read. */
  record: AudienceEntry | undefined
  /**
   * The audience prism serves for the post (P-3), when it names
   * `audienceUri`; another account's label comes from it when it carries a
   * name or a mode other than `list` (2H design 5.6).
   */
  served?: {uri: string; mode?: string; name?: string}
  /** That account's handle, once known. */
  ownerHandle: string | undefined
  /**
   * Where audiences are held. With `prism` another account's record can't
   * be read, so an audience the served one doesn't label reads "a custom
   * audience" (its member count is never served). Default `repo`.
   */
  recordsHeld?: 'repo' | 'prism'
}

const RELATIONAL_MODES: readonly string[] = ['followers', 'following', 'nobody']

/**
 * Whether a served audience can be labelled without its record: it has a
 * name, or a mode whose label needs no member count (an unnamed `list`
 * would be labelled by a member count prism never serves).
 */
export function labelsFromServedAudience(
  served: {mode?: string; name?: string} | undefined,
): boolean {
  if (!served) return false
  if (served.name) return true
  return (
    served.mode === 'everyone' || RELATIONAL_MODES.includes(served.mode ?? '')
  )
}

/**
 * The label of the audience a private post names, shown after "Private" on
 * the anchor's meta line (separated by a middle dot), or `undefined` while
 * what it needs is loading or could not be read (the badge still marks the
 * post, with no dot).
 *
 * - The current account's own audience: its label from the account's list,
 *   or "a custom audience" when the list does not hold it.
 * - Another account's: its label from the audience prism serves when that
 *   names it (`labelsFromServedAudience`), else from the record on that
 *   account's PDS, worded in that account's terms.
 * - No audience (a self-only post, served only to its owner): "Only you".
 */
export function postAudienceLabel(
  source: PostAudienceSource,
): string | undefined {
  const {audienceUri, currentDid} = source
  if (!audienceUri) {
    return audienceLabel({mode: 'nobody', members: []}, {isSelf: true})
  }
  let owner: string
  try {
    owner = new AtUri(audienceUri).host
  } catch {
    return undefined
  }
  if (owner === currentDid) {
    if (!source.ownAudiences) return undefined
    const entry = source.ownAudiences.find(item => item.uri === audienceUri)
    return entry ? audienceLabel(entry, {isSelf: true}) : t`a custom audience`
  }
  const served =
    source.served?.uri === audienceUri &&
    labelsFromServedAudience(source.served)
      ? source.served
      : undefined
  const record: Pick<AudienceEntry, 'mode' | 'name' | 'members'> | undefined =
    served
      ? {mode: served.mode ?? 'list', name: served.name, members: []}
      : source.record
  if (!record) {
    return source.recordsHeld === 'prism' ? t`a custom audience` : undefined
  }
  const needsHandle =
    record.name === undefined && RELATIONAL_MODES.includes(record.mode)
  if (needsHandle && !source.ownerHandle) return undefined
  return audienceLabel(record, {
    isSelf: false,
    handle: source.ownerHandle ?? '',
  })
}

/**
 * Once prism holds the account's audiences, delete the audience records
 * still in its repo: prism ignores them, but anyone can list them, names and
 * members included. Run once per sign-in; after the first success the list
 * is empty and this costs one `listRecords`. Each delete stands alone, so a
 * failure leaves the rest to the next sign-in. Answers how many went.
 */
export async function deleteLeftoverRepoAudiences(
  clients: Pick<AudienceClients, 'did' | 'pdsClient'>,
): Promise<number> {
  if (!audiencesOnPrism(clients.did)) return 0
  const leftovers = await listAudiences(clients.pdsClient, clients.did)
  if (leftovers.length === 0) return 0
  const repoRoute = repoRouteForDid(clientDid(clients.pdsClient) ?? clients.did)
  let deleted = 0
  for (const entry of leftovers) {
    try {
      if (repoRoute === 'locus') {
        await clients.pdsClient.call(kryphocron.deleteAudience, {
          repo: clients.did as DidString,
          rkey: entry.rkey,
        })
      } else {
        await repoWriterForClient(clients.pdsClient).deleteAudience(entry.uri)
      }
      deleted++
    } catch {
      // Left for the next sign-in.
    }
  }
  return deleted
}
