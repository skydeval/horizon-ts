/*
 * Own-record writes (Phase 5 design 5.1, 7, B-12): pronouns, the plural
 * system, members (with image upload), the front, and removing the whole
 * system. Each is for the current account's own repo, through its PDS
 * client.
 *
 * - **Keeps what it does not edit** (P5R1-N6). Every record written is the
 *   record read (`raw`, JSON form), spread under the edited fields, so keys
 *   Horizon does not know survive. Horizon 1.0's off-spec fields are
 *   dropped on the next save (PP-13).
 * - **Swaps.** An edit sends `swapRecord` with the CID last read; a create
 *   of a `self` record sends `null` (only if there is none). A swap that
 *   fails is {@link IdentityWriteConflictError}.
 * - **Member rkeys are TIDs** from the per-account TID clock, written with
 *   `createRecord`, never `putRecord`, so a clash fails instead of
 *   overwriting (PP-18, PP-21). Later edits use `putRecord` with a swap.
 * - **Pronouns are never deleted** (PP-22): there is no delete here;
 *   "show nothing" is a record with empty `sets`.
 * - **Optimistic.** Each write sets the identity cache from the written
 *   value at once and rolls it back on failure (4.5).
 * - **Removal** deletes the system record first, in its own write (it is
 *   the signal), then every member and the front in `applyWrites` calls of
 *   at most 200 (P5R1-N5).
 */

import {
  type Client,
  jsonToLex,
  type JsonValue,
  type LexMap,
  lexToJson,
  XrpcResponseError,
} from '@atproto/lex'
import {type DidString, type NsidString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient, type QueryKey} from '@tanstack/react-query'
import {countGraphemes} from 'unicode-segmenter/grapheme'

import {uploadBlob} from '#/lib/api/upload-blob'
import {
  ACCOUNT_PRONOUN_LIMITS,
  MEMBER_PRONOUN_LIMITS,
  type PronounSetInput,
  setsValid,
} from '#/horizon/identity/edit/pronoun-rows'
import {
  type DisplayMode,
  type FrontMember,
  MEMBER_IMAGE_TYPES,
  parseFront,
  parseMember,
  parsePronouns,
  parseSystem,
  type PluralFront,
  type PluralMember,
  type PluralSystem,
  type Pronouns,
} from '#/horizon/identity/parse'
import {
  type IdentityAnswer,
  identityQueryKey,
  type MemberList,
} from '#/horizon/identity/queries'
import {type ListedMember} from '#/horizon/identity/reads'
import {
  PLURAL_FRONT_COLLECTION,
  PLURAL_MEMBER_COLLECTION,
  PLURAL_SELF_RKEY,
  PLURAL_SYSTEM_COLLECTION,
  PRONOUNS_COLLECTION,
} from '#/horizon/lexicons/nearhorizon'
import {nextTidStr} from '#/horizon/tid-clock'
import {com} from '#/lexicons'

/** The account written as: its DID, PDS client and query client. */
export type OwnWriter = {
  did: string
  pdsClient: Client
  queryClient: QueryClient
}

/** Writes per `applyWrites` call (aurora-locus and Bluesky's PDS cap). */
export const REMOVE_BATCH = 200

/** The front holds at most this many members (`front.json`). */
export const FRONT_MAX_MEMBERS = 20

/** A member image's largest size in bytes (`member.json`). */
export const MEMBER_IMAGE_MAX_BYTES = 1_000_000

/** The record changed since it was read (the swap failed). */
export class IdentityWriteConflictError extends Error {
  constructor() {
    super(t`This changed somewhere else. Check it and save again.`)
    this.name = 'IdentityWriteConflictError'
  }
}

/** A value breaks the lexicon's limits; nothing was written. */
export class IdentityInvalidError extends Error {
  readonly code: string

  constructor(code: string) {
    super(t`Some of these details are too long or not valid.`)
    this.name = 'IdentityInvalidError'
    this.code = code
  }
}

/** A member image that is not PNG, JPEG or WebP, or is too large. */
export class MemberImageError extends Error {
  constructor() {
    super(t`Choose a PNG, JPEG or WebP image under 1 MB.`)
    this.name = 'MemberImageError'
  }
}

/**
 * The system record is gone, but some members or the front could not be
 * deleted. No reader treats them as a system (PL); trying again deletes
 * what is left.
 */
export class PluralRemovalIncompleteError extends Error {
  constructor(cause: unknown) {
    super(t`Some members couldn’t be removed.`, {cause})
    this.name = 'PluralRemovalIncompleteError'
  }
}

/** The member is removed, but the front still names it. */
export class FrontNotUpdatedError extends Error {
  constructor(cause: unknown) {
    super(t`The member was removed, but the front couldn’t be updated.`, {
      cause,
    })
    this.name = 'FrontNotUpdatedError'
  }
}

function isSwapFailure(error: unknown): boolean {
  return error instanceof XrpcResponseError && error.error === 'InvalidSwap'
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof XrpcResponseError && error.error === 'RecordNotFound'
}

function nowIso(): string {
  return new Date().toISOString()
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

function fits(value: string, graphemes: number, maxBytes: number): boolean {
  return countGraphemes(value) <= graphemes && bytes(value) <= maxBytes
}

function isDatetime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Set `key` to the trimmed text, or remove it when blank. */
function setText(
  record: Record<string, unknown>,
  key: string,
  value: string | undefined,
) {
  const trimmed = value?.trim()
  if (trimmed) record[key] = trimmed
  else delete record[key]
}

/** The written sets, each set object kept as read when it came from one. */
function setsJson(
  sets: readonly PronounSetInput[],
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const read = Array.isArray(raw[key]) ? (raw[key] as unknown[]) : []
  return sets.map(set => {
    const from = set.from === undefined ? undefined : read[set.from]
    const base =
      typeof from === 'object' && from !== null && !Array.isArray(from)
        ? (from as Record<string, unknown>)
        : {}
    return {...base, forms: [...set.forms]}
  })
}

/** The record for the PDS: JSON form to lex values (blobs, CIDs). */
function lexRecord(record: Record<string, unknown>): LexMap {
  return jsonToLex(record as JsonValue) as LexMap
}

/*
 * Set each entry at once, run the write, and on failure put every entry
 * back as it was.
 */
async function optimistic<T>(
  queryClient: QueryClient,
  entries: {key: QueryKey; next: unknown}[],
  write: () => Promise<T>,
): Promise<T> {
  const before = entries.map(({key}) => ({
    key,
    data: queryClient.getQueryData(key),
  }))
  for (const {key, next} of entries) queryClient.setQueryData(key, next)
  try {
    return await write()
  } catch (error) {
    for (const {key, data} of before) {
      if (data === undefined) {
        queryClient.removeQueries({queryKey: key, exact: true})
      } else {
        queryClient.setQueryData(key, data)
      }
    }
    throw error
  }
}

async function putSelf(
  w: OwnWriter,
  collection: string,
  record: Record<string, unknown>,
  swap: string | null,
): Promise<string> {
  try {
    const res = await w.pdsClient.call(com.atproto.repo.putRecord, {
      repo: w.did as DidString,
      collection: collection as NsidString,
      rkey: PLURAL_SELF_RKEY,
      record: lexRecord(record),
      swapRecord: swap,
    })
    return res.cid
  } catch (error) {
    if (isSwapFailure(error)) throw new IdentityWriteConflictError()
    throw error
  }
}

function previousCid<T>(
  previous: IdentityAnswer<T> | undefined,
): string | null {
  return previous?.kind === 'record' ? (previous.cid ?? null) : null
}

function requireAnswered<T>(
  previous: IdentityAnswer<T> | undefined,
): asserts previous is IdentityAnswer<T> {
  // Writing over a record that was never read could drop its contents.
  if (!previous) throw new Error('Read the record before writing it')
}

/* -------------------------------------------------------------------------
 * Pronouns
 * ---------------------------------------------------------------------- */

/** What the pronouns editor saves. */
export type PronounsInput = {
  sets: PronounSetInput[]
  displayMode: DisplayMode
}

/**
 * The pronouns record to write (7.1): the record read, spread under the
 * sets and display mode. `createdAt` kept from the record read (`now` on
 * the first write); `updatedAt` set on every edit and absent on the first
 * write (pronouns spec "Timestamps"). An untouched display mode keeps the
 * record's own value, absent included.
 */
export function buildPronounsRecord(
  previous: Pronouns | undefined,
  input: PronounsInput,
  now: string,
): Record<string, unknown> {
  const raw = previous?.raw ?? {}
  const record: Record<string, unknown> = {
    ...raw,
    $type: PRONOUNS_COLLECTION,
    sets: setsJson(input.sets, raw, 'sets'),
  }
  if (!previous || previous.displayMode !== input.displayMode) {
    if (input.displayMode === 'all' && !previous) delete record.displayMode
    else record.displayMode = input.displayMode
  }
  if (previous) {
    record.createdAt = isDatetime(raw.createdAt) ? raw.createdAt : now
    record.updatedAt = now
  } else {
    record.createdAt = now
    delete record.updatedAt
  }
  return record
}

/**
 * Save the pronouns. `previous` is the answer read (a record or none);
 * clearing every set writes empty `sets`, never a delete (PP-22).
 */
export async function savePronouns(
  w: OwnWriter,
  previous: IdentityAnswer<Pronouns> | undefined,
  input: PronounsInput,
): Promise<void> {
  requireAnswered(previous)
  if (!setsValid(input.sets, ACCOUNT_PRONOUN_LIMITS)) {
    throw new IdentityInvalidError('pronouns')
  }
  const old = previous.kind === 'record' ? previous.value : undefined
  const record = buildPronounsRecord(old, input, nowIso())
  const value = parsePronouns(record)
  if (!value) throw new IdentityInvalidError('pronouns')
  const key = identityQueryKey('pronouns', {did: w.did})
  const cid = previousCid(previous)
  await optimistic(
    w.queryClient,
    [{key, next: answer(value, cid ?? undefined)}],
    async () => {
      const written = await putSelf(w, PRONOUNS_COLLECTION, record, cid)
      w.queryClient.setQueryData(key, answer(value, written))
    },
  )
}

function answer<T>(value: T, cid: string | undefined): IdentityAnswer<T> {
  return cid === undefined
    ? {kind: 'record', value}
    : {kind: 'record', value, cid}
}

/* -------------------------------------------------------------------------
 * System
 * ---------------------------------------------------------------------- */

/** The system editor's fields. */
export type SystemInput = {
  name: string
  description: string
  collectiveNoun: string
  memberCount: string
}

/** Horizon 1.0's off-spec system fields, dropped on save (PP-13). */
const OLD_SYSTEM_FIELDS = ['avatar', 'banner', 'externalUrl']

/** Why the system fields cannot be written, or `null`. */
export function systemProblem(input: SystemInput): string | null {
  if (!fits(input.name.trim(), 64, 640)) return 'nameTooLong'
  if (!fits(input.description.trim(), 256, 2560)) return 'descriptionTooLong'
  if (!fits(input.collectiveNoun.trim(), 32, 320)) {
    return 'collectiveNounTooLong'
  }
  if (!fits(input.memberCount.trim(), 16, 64)) return 'memberCountTooLong'
  return null
}

/** The system record to write: the record read under the edited fields. */
export function buildSystemRecord(
  previous: PluralSystem | undefined,
  input: SystemInput | undefined,
  now: string,
): Record<string, unknown> {
  const raw = previous?.raw ?? {}
  const record: Record<string, unknown> = {
    ...raw,
    $type: PLURAL_SYSTEM_COLLECTION,
  }
  for (const key of OLD_SYSTEM_FIELDS) delete record[key]
  if (input) {
    setText(record, 'name', input.name)
    setText(record, 'description', input.description)
    setText(record, 'collectiveNoun', input.collectiveNoun)
    setText(record, 'memberCount', input.memberCount)
  }
  if (previous) {
    if (isDatetime(raw.createdAt)) record.createdAt = raw.createdAt
    else delete record.createdAt
    record.updatedAt = now
  } else {
    record.createdAt = now
    delete record.updatedAt
  }
  return record
}

/**
 * "Set up a plural system": an empty system record (the record existing
 * is the signal, PL). Created only if there is none.
 */
export async function setUpSystem(w: OwnWriter): Promise<void> {
  const record = buildSystemRecord(undefined, undefined, nowIso())
  const value = parseSystem(record)
  if (!value) throw new IdentityInvalidError('system')
  const key = identityQueryKey('system', {did: w.did})
  const listKey = identityQueryKey('members', {did: w.did})
  const entries: {key: QueryKey; next: unknown}[] = [
    {key, next: answer(value, undefined)},
  ]
  if (w.queryClient.getQueryData(listKey) === undefined) {
    const empty: MemberList = {members: [], partial: false}
    entries.push({key: listKey, next: empty})
  }
  await optimistic(w.queryClient, entries, async () => {
    const written = await putSelf(w, PLURAL_SYSTEM_COLLECTION, record, null)
    w.queryClient.setQueryData(key, answer(value, written))
  })
}

/** Save the system's fields over the record read. */
export async function saveSystem(
  w: OwnWriter,
  previous: IdentityAnswer<PluralSystem> | undefined,
  input: SystemInput,
): Promise<void> {
  requireAnswered(previous)
  const problem = systemProblem(input)
  if (problem) throw new IdentityInvalidError(problem)
  const old = previous.kind === 'record' ? previous.value : undefined
  const record = buildSystemRecord(old, input, nowIso())
  const value = parseSystem(record)
  if (!value) throw new IdentityInvalidError('system')
  const key = identityQueryKey('system', {did: w.did})
  const cid = previousCid(previous)
  await optimistic(
    w.queryClient,
    [{key, next: answer(value, cid ?? undefined)}],
    async () => {
      const written = await putSelf(w, PLURAL_SYSTEM_COLLECTION, record, cid)
      w.queryClient.setQueryData(key, answer(value, written))
    },
  )
}

/* -------------------------------------------------------------------------
 * Members
 * ---------------------------------------------------------------------- */

/** The member editor's fields. */
export type MemberInput = {
  displayName: string
  description: string
  emoji: string
  color: string
  pronouns: PronounSetInput[]
  roles: string[]
  memberTypes: string[]
  agePresentation: string
  /** Another member who speaks for this one, or `null`. */
  proxy: {id: string; note: string} | null
}

/** A picked image: its file and type, as the stock pickers give it. */
export type PickedImage = {path: string; mime: string; size?: number}

/**
 * The member's images: `undefined` keeps the image read, `null` removes
 * it, a picked image replaces it.
 */
export type MemberImages = {
  avatar?: PickedImage | null
  banner?: PickedImage | null
}

/** Horizon 1.0's off-spec member fields, dropped on save (PP-13). */
const OLD_MEMBER_FIELDS = ['pronounDisplayMode', 'externalUrl']

const COLOR = /^#[0-9A-Fa-f]{6}$/

function cleanList(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Why the member fields cannot be written, or `null`. */
export function memberProblem(input: MemberInput): string | null {
  const name = input.displayName.trim()
  if (!name) return 'displayNameRequired'
  if (!fits(name, 64, 640)) return 'displayNameTooLong'
  if (!fits(input.description.trim(), 256, 2560)) return 'descriptionTooLong'
  if (!fits(input.emoji.trim(), 4, 16)) return 'emojiTooLong'
  const color = input.color.trim()
  if (color && !COLOR.test(color)) return 'colorInvalid'
  if (!setsValid(input.pronouns, MEMBER_PRONOUN_LIMITS)) return 'pronouns'
  const roles = cleanList(input.roles)
  if (roles.length > 10) return 'tooManyRoles'
  if (roles.some(role => !fits(role, 32, 320))) return 'roleTooLong'
  const types = cleanList(input.memberTypes)
  if (types.length > 5) return 'tooManyMemberTypes'
  if (types.some(type => !fits(type, 32, 320))) return 'memberTypeTooLong'
  if (!fits(input.agePresentation.trim(), 32, 320)) {
    return 'agePresentationTooLong'
  }
  if (input.proxy && !fits(input.proxy.note.trim(), 64, 640)) {
    return 'proxyNoteTooLong'
  }
  return null
}

/**
 * The member record to write: the record read, spread under the edited
 * fields. `blobs` are JSON-form blob refs: `undefined` keeps the record's,
 * `null` removes it.
 */
export function buildMemberRecord(
  previous: PluralMember | undefined,
  input: MemberInput,
  blobs: {avatar?: unknown; banner?: unknown},
  now: string,
): Record<string, unknown> {
  const raw = previous?.raw ?? {}
  const record: Record<string, unknown> = {
    ...raw,
    $type: PLURAL_MEMBER_COLLECTION,
    displayName: input.displayName.trim(),
  }
  for (const key of OLD_MEMBER_FIELDS) delete record[key]
  setText(record, 'description', input.description)
  setText(record, 'emoji', input.emoji)
  setText(record, 'color', input.color)
  setText(record, 'agePresentation', input.agePresentation)
  if (input.pronouns.length > 0) {
    record.pronouns = setsJson(input.pronouns, raw, 'pronouns')
  } else {
    delete record.pronouns
  }
  const roles = cleanList(input.roles)
  if (roles.length > 0) record.roles = roles
  else delete record.roles
  const types = cleanList(input.memberTypes)
  if (types.length > 0) record.memberTypes = types
  else delete record.memberTypes
  if (input.proxy) {
    const base =
      typeof raw.proxy === 'object' && raw.proxy !== null
        ? (raw.proxy as Record<string, unknown>)
        : {}
    const proxy: Record<string, unknown> = {...base, id: input.proxy.id}
    setText(proxy, 'note', input.proxy.note)
    record.proxy = proxy
  } else {
    delete record.proxy
  }
  for (const key of ['avatar', 'banner'] as const) {
    const blob = blobs[key]
    if (blob === null) delete record[key]
    else if (blob !== undefined) record[key] = blob
  }
  if (previous) {
    if (isDatetime(raw.createdAt)) record.createdAt = raw.createdAt
    else delete record.createdAt
    record.updatedAt = now
  } else {
    record.createdAt = now
    delete record.updatedAt
  }
  return record
}

async function uploadImage(w: OwnWriter, image: PickedImage): Promise<unknown> {
  if (!MEMBER_IMAGE_TYPES.includes(image.mime)) {
    throw new MemberImageError()
  }
  if (image.size !== undefined && image.size > MEMBER_IMAGE_MAX_BYTES) {
    throw new MemberImageError()
  }
  const {blob} = await uploadBlob(w.pdsClient, image.path, image.mime)
  const json = lexToJson(blob) as Record<string, unknown>
  if (typeof json.size === 'number' && json.size > MEMBER_IMAGE_MAX_BYTES) {
    throw new MemberImageError()
  }
  return json
}

async function uploadImages(
  w: OwnWriter,
  images: MemberImages,
): Promise<{avatar?: unknown; banner?: unknown}> {
  const out: {avatar?: unknown; banner?: unknown} = {}
  for (const key of ['avatar', 'banner'] as const) {
    const image = images[key]
    if (image === null) out[key] = null
    else if (image !== undefined) out[key] = await uploadImage(w, image)
  }
  return out
}

function withMember(
  list: MemberList | undefined,
  member: ListedMember,
): MemberList | undefined {
  if (!list) return undefined
  const members = list.members.filter(m => m.rkey !== member.rkey)
  members.push(member)
  members.sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0))
  return {...list, members}
}

function withoutMember(
  list: MemberList | undefined,
  rkey: string,
): MemberList | undefined {
  if (!list) return undefined
  return {...list, members: list.members.filter(m => m.rkey !== rkey)}
}

function memberEntries(
  w: OwnWriter,
  rkey: string,
  value: PluralMember,
  cid: string | undefined,
) {
  const memberKey = identityQueryKey('member', {did: w.did, rkey})
  const listKey = identityQueryKey('members', {did: w.did})
  const listed: ListedMember =
    cid === undefined ? {rkey, value} : {rkey, cid, value}
  const entries: {key: QueryKey; next: unknown}[] = [
    {key: memberKey, next: answer(value, cid)},
  ]
  const list = withMember(
    w.queryClient.getQueryData<MemberList>(listKey),
    listed,
  )
  if (list) entries.push({key: listKey, next: list})
  return entries
}

/**
 * Create a member: images uploaded first, then one `createRecord` at a new
 * TID from the per-account clock (never `putRecord`, so a clash fails
 * instead of overwriting). Returns the new member's rkey.
 */
export async function createMember(
  w: OwnWriter,
  input: MemberInput,
  images: MemberImages = {},
): Promise<string> {
  const problem = memberProblem(input)
  if (problem) throw new IdentityInvalidError(problem)
  const blobs = await uploadImages(w, images)
  const record = buildMemberRecord(undefined, input, blobs, nowIso())
  const value = parseMember(record)
  if (!value) throw new IdentityInvalidError('member')
  const rkey = nextTidStr(w.did)
  await optimistic(
    w.queryClient,
    memberEntries(w, rkey, value, undefined),
    async () => {
      const res = await w.pdsClient.call(com.atproto.repo.createRecord, {
        repo: w.did as DidString,
        collection: PLURAL_MEMBER_COLLECTION,
        rkey,
        record: lexRecord(record),
      })
      for (const {key, next} of memberEntries(w, rkey, value, res.cid)) {
        w.queryClient.setQueryData(key, next)
      }
    },
  )
  return rkey
}

/** Save an existing member over the record read, swapped on its CID. */
export async function updateMember(
  w: OwnWriter,
  rkey: string,
  previous: {value: PluralMember; cid?: string},
  input: MemberInput,
  images: MemberImages = {},
): Promise<void> {
  const problem = memberProblem(input)
  if (problem) throw new IdentityInvalidError(problem)
  const blobs = await uploadImages(w, images)
  const record = buildMemberRecord(previous.value, input, blobs, nowIso())
  const value = parseMember(record)
  if (!value) throw new IdentityInvalidError('member')
  await optimistic(
    w.queryClient,
    memberEntries(w, rkey, value, previous.cid),
    async () => {
      let cid: string
      try {
        const res = await w.pdsClient.call(com.atproto.repo.putRecord, {
          repo: w.did as DidString,
          collection: PLURAL_MEMBER_COLLECTION,
          rkey,
          record: lexRecord(record),
          ...(previous.cid ? {swapRecord: previous.cid} : {}),
        })
        cid = res.cid
      } catch (error) {
        if (isSwapFailure(error)) throw new IdentityWriteConflictError()
        throw error
      }
      for (const {key, next} of memberEntries(w, rkey, value, cid)) {
        w.queryClient.setQueryData(key, next)
      }
    },
  )
}

/**
 * Delete a member and drop it from the front (7.2). Posts naming it then
 * show without it (PP-3). A front write that fails after the delete is
 * {@link FrontNotUpdatedError}.
 */
export async function deleteMember(
  w: OwnWriter,
  rkey: string,
  front: IdentityAnswer<PluralFront> | undefined,
): Promise<void> {
  const memberKey = identityQueryKey('member', {did: w.did, rkey})
  const listKey = identityQueryKey('members', {did: w.did})
  const entries: {key: QueryKey; next: unknown}[] = [
    {key: memberKey, next: {kind: 'none'}},
  ]
  const list = withoutMember(
    w.queryClient.getQueryData<MemberList>(listKey),
    rkey,
  )
  if (list) entries.push({key: listKey, next: list})
  await optimistic(w.queryClient, entries, async () => {
    try {
      await w.pdsClient.call(com.atproto.repo.deleteRecord, {
        repo: w.did as DidString,
        collection: PLURAL_MEMBER_COLLECTION,
        rkey,
      })
    } catch (error) {
      if (!isRecordNotFound(error)) throw error
    }
  })
  if (front?.kind !== 'record') return
  if (!front.value.members.some(member => member.id === rkey)) return
  try {
    await saveFront(w, front, {
      members: front.value.members.filter(member => member.id !== rkey),
      state: front.value.state ?? '',
      comment: front.value.comment ?? '',
      keepSetAt: true,
    })
  } catch (error) {
    throw new FrontNotUpdatedError(error)
  }
}

/* -------------------------------------------------------------------------
 * Front
 * ---------------------------------------------------------------------- */

/** The front switcher's fields. */
export type FrontInput = {
  members: FrontMember[]
  state: string
  comment: string
  /** Keep the record's `setAt` (a member removed, not a switch). */
  keepSetAt?: boolean
}

/** Why the front cannot be written, or `null`. */
export function frontProblem(input: FrontInput): string | null {
  if (input.members.length > FRONT_MAX_MEMBERS) return 'tooManyMembers'
  if (input.members.some(m => m.status && !fits(m.status.trim(), 32, 320))) {
    return 'statusTooLong'
  }
  if (!fits(input.state.trim(), 32, 320)) return 'stateTooLong'
  if (!fits(input.comment.trim(), 256, 2560)) return 'commentTooLong'
  return null
}

/**
 * The front record to write: the record read, spread under the members,
 * state and comment, `setAt` now. "Nobody fronting" is empty `members`.
 */
export function buildFrontRecord(
  previous: PluralFront | undefined,
  input: FrontInput,
  now: string,
): Record<string, unknown> {
  const raw = previous?.raw ?? {}
  const seen = new Set<string>()
  const members: Record<string, unknown>[] = []
  for (const member of input.members) {
    if (seen.has(member.id)) continue
    seen.add(member.id)
    const status = member.status?.trim()
    members.push(status ? {id: member.id, status} : {id: member.id})
  }
  const record: Record<string, unknown> = {
    ...raw,
    $type: PLURAL_FRONT_COLLECTION,
    members,
  }
  setText(record, 'state', input.state)
  setText(record, 'comment', input.comment)
  record.setAt = input.keepSetAt && isDatetime(raw.setAt) ? raw.setAt : now
  return record
}

/** Save the whole front record (7.3), swapped on the CID read. */
export async function saveFront(
  w: OwnWriter,
  previous: IdentityAnswer<PluralFront> | undefined,
  input: FrontInput,
): Promise<void> {
  requireAnswered(previous)
  const problem = frontProblem(input)
  if (problem) throw new IdentityInvalidError(problem)
  const old = previous.kind === 'record' ? previous.value : undefined
  const record = buildFrontRecord(old, input, nowIso())
  const value = parseFront(record)
  if (!value) throw new IdentityInvalidError('front')
  const key = identityQueryKey('front', {did: w.did})
  const cid = previousCid(previous)
  await optimistic(
    w.queryClient,
    [{key, next: answer(value, cid ?? undefined)}],
    async () => {
      const written = await putSelf(w, PLURAL_FRONT_COLLECTION, record, cid)
      w.queryClient.setQueryData(key, answer(value, written))
    },
  )
}

/* -------------------------------------------------------------------------
 * Removing the system
 * ---------------------------------------------------------------------- */

/** Every member rkey in the repo, unparsed records included. */
async function listAllMemberRkeys(w: OwnWriter): Promise<string[]> {
  const rkeys: string[] = []
  let cursor: string | undefined
  // A generous bound: 100 pages of 100, far past any real system.
  for (let page = 0; page < 100; page++) {
    const res = await w.pdsClient.call(com.atproto.repo.listRecords, {
      repo: w.did as DidString,
      collection: PLURAL_MEMBER_COLLECTION,
      limit: 100,
      cursor,
    })
    for (const record of res.records) {
      const rkey = record.uri.split('/').pop()
      if (rkey) rkeys.push(rkey)
    }
    cursor = res.cursor
    if (!cursor || res.records.length === 0) break
  }
  return [...new Set(rkeys)]
}

async function frontExists(w: OwnWriter): Promise<boolean> {
  try {
    await w.pdsClient.call(com.atproto.repo.getRecord, {
      repo: w.did as DidString,
      collection: PLURAL_FRONT_COLLECTION,
      rkey: PLURAL_SELF_RKEY,
    })
    return true
  } catch (error) {
    if (isRecordNotFound(error)) return false
    throw error
  }
}

/**
 * Remove the plural system (7.2): the system record first, in its own
 * write; then every member and the front in `applyWrites` calls of at most
 * {@link REMOVE_BATCH}. A failure before the system record is gone changes
 * nothing (the cache is put back); one after it is
 * {@link PluralRemovalIncompleteError}, and calling this again deletes
 * what is left.
 */
export async function removePluralSystem(w: OwnWriter): Promise<void> {
  const systemKey = identityQueryKey('system', {did: w.did})
  await optimistic(
    w.queryClient,
    [{key: systemKey, next: {kind: 'none'}}],
    async () => {
      try {
        await w.pdsClient.call(com.atproto.repo.deleteRecord, {
          repo: w.did as DidString,
          collection: PLURAL_SYSTEM_COLLECTION,
          rkey: PLURAL_SELF_RKEY,
        })
      } catch (error) {
        if (!isRecordNotFound(error)) throw error
      }
    },
  )

  const listKey = identityQueryKey('members', {did: w.did})
  const frontKey = identityQueryKey('front', {did: w.did})
  try {
    const rkeys = await listAllMemberRkeys(w)
    const writes: {
      $type: 'com.atproto.repo.applyWrites#delete'
      collection: string
      rkey: string
    }[] = rkeys.map(rkey => ({
      $type: 'com.atproto.repo.applyWrites#delete',
      collection: PLURAL_MEMBER_COLLECTION,
      rkey,
    }))
    if (await frontExists(w)) {
      writes.push({
        $type: 'com.atproto.repo.applyWrites#delete',
        collection: PLURAL_FRONT_COLLECTION,
        rkey: PLURAL_SELF_RKEY,
      })
    }
    for (let i = 0; i < writes.length; i += REMOVE_BATCH) {
      const batch = writes.slice(i, i + REMOVE_BATCH)
      await w.pdsClient.call(com.atproto.repo.applyWrites, {
        repo: w.did as DidString,
        writes: batch as com.atproto.repo.applyWrites.$InputBody['writes'],
      })
      for (const write of batch) {
        if (write.collection !== PLURAL_MEMBER_COLLECTION) continue
        w.queryClient.setQueryData(
          identityQueryKey('member', {did: w.did, rkey: write.rkey}),
          {kind: 'none'},
        )
      }
    }
  } catch (error) {
    void w.queryClient.invalidateQueries({queryKey: listKey})
    throw new PluralRemovalIncompleteError(error)
  }
  const empty: MemberList = {members: [], partial: false}
  w.queryClient.setQueryData(listKey, empty)
  w.queryClient.setQueryData(frontKey, {kind: 'none'})
}
