/*
 * The reader's mutes on the device (skydeval, 2026-10-25), so Thread Lens
 * can show a member's lens posts muted without the public-view pass.
 *
 * - What: the accounts the reader mutes (`app.bsky.graph.getMutes`, every
 *   page; a scoped mute, reposts or quote posts only, is left out because it
 *   does not mute posts) and the mute lists they subscribe to
 *   (`getListMutes`, every page), each with its members (`getList`, every
 *   page). All read from the reader's own AppView with their own session.
 * - Where: Horizon's local store, one key per account
 *   (`horizon:mutes:<did>`). Never sent anywhere: nothing here writes to a
 *   server, and nothing reads the copy but Thread Lens on this device.
 * - When: read on sign-in and app open, every 10 minutes while the app is in
 *   the foreground, and from scratch whenever the key is cleared
 *   (`startMuteCache`, mounted by `MuteCacheHost`). A mute or unmute and a
 *   list mute or unmute made in Horizon change it at once (`noteAccountMute`,
 *   `noteListMute`, hooked into the stock mutations).
 * - Trust: the copy is used only while it is whole. A listing past
 *   {@link MUTE_PAGES_MAX} pages stores an incomplete marker, and a list
 *   muted here whose members are still being read (or could not be read)
 *   holds it back; `getMuteCache` then answers `undefined` and Thread Lens
 *   keeps its pass.
 *
 * Changes made here stay in memory as well until a read that started after
 * the change settled has replaced them, so a read already in flight when the
 * reader mutes someone does not undo the mute. Logs name the part only,
 * never a DID or a list.
 */

import {type Client} from '@atproto/lex'
import {type AtUriString} from '@atproto/syntax'

import {logger} from '#/logger'
import {
  readLocal,
  subscribeLocal,
  writeLocal,
} from '#/horizon/session/local-store'
import {app} from '#/lexicons'

type ListViewBasic = app.bsky.graph.defs.ListViewBasic
type ListView = app.bsky.graph.defs.ListView

/** How often the copy is read again while the app is in the foreground. */
export const MUTE_CACHE_REFRESH_MS = 10 * 60_000

/** Items per page of every listing. */
export const MUTE_PAGE_SIZE = 100

/**
 * Pages read at most per listing (10,000 entries). Past it the copy is
 * marked incomplete and not used.
 */
export const MUTE_PAGES_MAX = 100

const KEY_PREFIX = 'horizon:mutes:'

/** The device key holding `did`'s mutes. */
export function muteCacheKey(did: string): string {
  return `${KEY_PREFIX}${did}`
}

type StoredList = {list: ListViewBasic; members: string[]}

type Stored =
  | {v: 1; at: number; accounts: string[]; lists: StoredList[]}
  | {v: 1; at: number; incomplete: true}

type Complete = Extract<Stored, {accounts: string[]}>

/** A change made in Horizon, kept until a later read includes it. */
type Change =
  | {
      kind: 'account'
      subject: string
      muted: boolean
      settledAt?: number
    }
  | {
      kind: 'list'
      uri: string
      muted: boolean
      /** The list and its members, once read (a mute only). */
      entry?: StoredList
      /** The members could not be read: the copy is not whole. */
      failed?: boolean
      settledAt?: number
    }

type State = {
  changes: Change[]
  refresh?: Promise<void>
}

const states = new Map<string, State>()
/** Accounts signed out: nothing reads for them until started again. */
const stopped = new Set<string>()

function stateOf(did: string): State {
  let state = states.get(did)
  if (!state) {
    state = {changes: []}
    states.set(did, state)
  }
  return state
}

let parsed: {did: string; raw: string; stored: Stored} | undefined

function readStored(did: string): Stored | undefined {
  const raw = readLocal(muteCacheKey(did))
  if (raw === undefined) return undefined
  if (parsed?.did === did && parsed.raw === raw) return parsed.stored
  try {
    const stored = JSON.parse(raw) as Stored
    if (stored?.v !== 1) return undefined
    parsed = {did, raw, stored}
    return stored
  } catch {
    return undefined
  }
}

/**
 * Write `did`'s copy. When the store does not keep it (quota, storage
 * blocked), the key is removed, so a stale copy is never used.
 */
function writeStored(did: string, stored: Stored) {
  const key = muteCacheKey(did)
  const raw = JSON.stringify(stored)
  writeLocal(key, raw)
  if (readLocal(key) !== raw) {
    logger.info('mute cache: not saved on the device')
    writeLocal(key, undefined)
  }
}

function isComplete(stored: Stored | undefined): stored is Complete {
  return !!stored && !('incomplete' in stored)
}

function applyChange(stored: Complete, change: Change): Complete {
  if (change.kind === 'account') {
    const accounts = stored.accounts.filter(did => did !== change.subject)
    if (change.muted) accounts.push(change.subject)
    return {...stored, accounts}
  }
  const lists = stored.lists.filter(held => held.list.uri !== change.uri)
  if (change.muted) {
    if (!change.entry) return stored
    lists.push(change.entry)
  }
  return {...stored, lists}
}

/** Apply `change` to the stored copy now, when there is a whole one. */
function applyNow(did: string, change: Change) {
  const stored = readStored(did)
  if (isComplete(stored)) writeStored(did, applyChange(stored, change))
}

function basicOf(list: ListView): ListViewBasic {
  return {
    uri: list.uri,
    cid: list.cid,
    name: list.name,
    purpose: list.purpose,
    ...(list.avatar ? {avatar: list.avatar} : {}),
    ...(list.labels ? {labels: list.labels} : {}),
    ...(list.viewer ? {viewer: list.viewer} : {}),
    ...(list.indexedAt ? {indexedAt: list.indexedAt} : {}),
    ...(typeof list.listItemCount === 'number'
      ? {listItemCount: list.listItemCount}
      : {}),
  }
}

/** Thrown when a listing goes past {@link MUTE_PAGES_MAX} pages. */
class TooManyPages extends Error {}

async function pages<T>(
  read: (cursor: string | undefined) => Promise<{
    items: T[]
    cursor?: string
  }>,
): Promise<T[]> {
  const out: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < MUTE_PAGES_MAX; page++) {
    const res = await read(cursor)
    out.push(...res.items)
    if (!res.cursor || res.items.length === 0 || res.cursor === cursor) {
      return out
    }
    cursor = res.cursor
  }
  throw new TooManyPages()
}

/** One mute list and every member, from the AppView. */
async function readList(
  appview: Client,
  uri: string,
  known?: ListView,
): Promise<StoredList> {
  let list = known
  const members = await pages(async cursor => {
    const res = await appview.call(app.bsky.graph.getList, {
      list: uri as AtUriString,
      limit: MUTE_PAGE_SIZE,
      cursor,
    })
    list ??= res.list
    return {items: res.items, cursor: res.cursor}
  })
  if (!list) throw new Error('mute cache: no list view')
  return {
    list: basicOf(list),
    members: members.map(item => item.subject.did),
  }
}

async function readAll(did: string, appview: Client): Promise<Complete> {
  const at = Date.now()
  const [mutes, lists] = await Promise.all([
    pages(async cursor => {
      const res = await appview.call(app.bsky.graph.getMutes, {
        limit: MUTE_PAGE_SIZE,
        cursor,
      })
      return {items: res.mutes, cursor: res.cursor}
    }),
    pages(async cursor => {
      const res = await appview.call(app.bsky.graph.getListMutes, {
        limit: MUTE_PAGE_SIZE,
        cursor,
      })
      return {items: res.lists, cursor: res.cursor}
    }),
  ])
  const accounts = mutes
    .filter(
      profile =>
        profile.did !== did &&
        !profile.viewer?.mutedOnlyReposts &&
        !profile.viewer?.mutedOnlyQuoteposts,
    )
    .map(profile => profile.did)
  const stored = await Promise.all(
    lists.map(list => readList(appview, list.uri, list)),
  )
  return {v: 1, at, accounts, lists: stored}
}

/**
 * Read `did`'s mutes again from `appview` (that account's own AppView
 * client), every page. One read per account at a time; a read asked for
 * while one runs gets that one.
 */
export function refreshMuteCache(did: string, appview: Client): Promise<void> {
  if (stopped.has(did)) return Promise.resolve()
  const state = stateOf(did)
  if (state.refresh) return state.refresh
  const startedAt = Date.now()
  const run = readAll(did, appview)
    .then(fresh => {
      if (stopped.has(did) || states.get(did) !== state) return
      // A change settled before this read started is in it already.
      state.changes = state.changes.filter(
        change =>
          change.settledAt === undefined || change.settledAt >= startedAt,
      )
      let stored = fresh
      for (const change of state.changes) stored = applyChange(stored, change)
      writeStored(did, stored)
    })
    .catch(error => {
      if (stopped.has(did) || states.get(did) !== state) return
      if (error instanceof TooManyPages) {
        logger.info('mute cache: too many pages, not used')
        writeStored(did, {v: 1, at: Date.now(), incomplete: true})
        return
      }
      logger.info('mute cache: read failed', {safeMessage: error})
    })
    .finally(() => {
      if (state.refresh === run) state.refresh = undefined
    })
  state.refresh = run
  return run
}

/** Whether `did` has a read in flight. */
export function isMuteCacheRefreshing(did: string): boolean {
  return !!states.get(did)?.refresh
}

/** When `did`'s copy was read, or `undefined` with none stored. */
export function muteCacheReadAt(did: string): number | undefined {
  return readStored(did)?.at
}

/** What the copy says about one author, as stock's viewer state says it. */
export type MuteState = {muted: boolean; mutedByList?: ListViewBasic}

/** The reader's whole mute set, for one account. */
export type MuteLookup = {
  /** The reader's DID. */
  did: string
  stateOf: (author: string) => MuteState
}

let lookupMemo: {stored: Stored; lookup: MuteLookup} | undefined

/**
 * `did`'s mutes when the device holds a whole copy, else `undefined` (none
 * stored, incomplete, or a list muted here still being read).
 */
export function getMuteCache(did: string | undefined): MuteLookup | undefined {
  if (!did || stopped.has(did)) return undefined
  const state = states.get(did)
  if (
    state?.changes.some(
      change => change.kind === 'list' && change.muted && !change.entry,
    )
  ) {
    return undefined
  }
  const stored = readStored(did)
  if (!isComplete(stored)) return undefined
  if (lookupMemo?.stored === stored && lookupMemo.lookup.did === did) {
    return lookupMemo.lookup
  }
  const accounts = new Set(stored.accounts)
  const byList = new Map<string, ListViewBasic>()
  for (const {list, members} of stored.lists) {
    for (const member of members) {
      if (!byList.has(member)) byList.set(member, list)
    }
  }
  const lookup: MuteLookup = {
    did,
    stateOf: author => {
      if (author === did) return {muted: false}
      const list = byList.get(author)
      if (list) return {muted: true, mutedByList: list}
      return {muted: accounts.has(author)}
    },
  }
  lookupMemo = {stored, lookup}
  return lookup
}

/**
 * Why {@link getMuteCache} answers `undefined` for `did`, for the timing
 * log: `undefined` when it would answer a lookup.
 */
export function muteCacheGate(did: string | undefined): string | undefined {
  if (!did) return 'no account'
  if (stopped.has(did)) return 'stopped'
  if (
    states
      .get(did)
      ?.changes.some(
        change => change.kind === 'list' && change.muted && !change.entry,
      )
  ) {
    return 'a list muted here still being read'
  }
  const stored = readStored(did)
  if (!stored) {
    return isMuteCacheRefreshing(did) ? 'first read in flight' : 'none stored'
  }
  if (!isComplete(stored)) return 'incomplete (too many pages)'
  return undefined
}

/** Ends a change: `true` once the server took it, `false` when it failed. */
export type SettleMuteChange = (ok: boolean) => void

function settler(
  did: string,
  change: Change,
  undo: () => void,
  settled?: () => void,
) {
  return (ok: boolean) => {
    const state = states.get(did)
    if (!state) return
    if (ok) {
      change.settledAt = Date.now()
      settled?.()
      return
    }
    state.changes = state.changes.filter(held => held !== change)
    undo()
  }
}

/**
 * The reader `did` muted (`muted`) or unmuted `subject` in Horizon: the copy
 * says so at once. Call the result when the server answers.
 */
export function noteAccountMute(
  did: string,
  subject: string,
  muted: boolean,
): SettleMuteChange {
  const before = readStored(did)
  const was = isComplete(before) ? before.accounts.includes(subject) : undefined
  const change: Change = {kind: 'account', subject, muted}
  stateOf(did).changes.push(change)
  applyNow(did, change)
  return settler(did, change, () => {
    if (was !== undefined) {
      applyNow(did, {kind: 'account', subject, muted: was})
    }
  })
}

/**
 * The reader `did` subscribed to (`muted`) or unsubscribed from the mute
 * list `uri` in Horizon. An unsubscribe applies at once; a subscribe reads
 * the list's members from `appview` first, and until they are in, the copy
 * is not used. Call the result when the server answers.
 */
export function noteListMute(
  did: string,
  uri: string,
  muted: boolean,
  appview: Client,
): SettleMuteChange {
  const before = readStored(did)
  const held = isComplete(before)
    ? before.lists.find(entry => entry.list.uri === uri)
    : undefined
  const change: Change = {kind: 'list', uri, muted}
  const state = stateOf(did)
  state.changes.push(change)
  if (muted) {
    readList(appview, uri)
      .then(entry => {
        if (!state.changes.includes(change)) return
        change.entry = entry
        applyNow(did, change)
      })
      .catch(error => {
        if (!state.changes.includes(change)) return
        logger.info('mute cache: list read failed', {safeMessage: error})
        change.failed = true
        void refreshMuteCache(did, appview)
      })
  } else {
    applyNow(did, change)
  }
  return settler(
    did,
    change,
    () => {
      const stored = readStored(did)
      if (!isComplete(stored)) return
      const lists = stored.lists.filter(entry => entry.list.uri !== uri)
      if (held) lists.push(held)
      writeStored(did, {...stored, lists})
    },
    () => {
      // The members could not be read: a read after the server took it.
      if (change.kind === 'list' && change.failed) {
        void refreshMuteCache(did, appview)
      }
    },
  )
}

/** What `startMuteCache` needs from the app. */
export type MuteCacheEnvironment = {
  isForeground: () => boolean
  /** Called on every foreground change. Returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

/**
 * Keep `did`'s copy fresh while the caller runs: a read now (sign-in, app
 * open), every {@link MUTE_CACHE_REFRESH_MS} in the foreground, on coming
 * back to the foreground when the copy is older than that, and from scratch
 * when the key is cleared. Returns the stop function.
 */
export function startMuteCache(
  did: string,
  appview: Client,
  env: MuteCacheEnvironment,
): () => void {
  stopped.delete(did)
  const refresh = () => void refreshMuteCache(did, appview)
  const refreshIfOld = () => {
    if (!env.isForeground()) return
    const at = muteCacheReadAt(did)
    if (at === undefined || Date.now() - at >= MUTE_CACHE_REFRESH_MS) {
      refresh()
    }
  }
  refresh()
  const timer = setInterval(() => {
    if (env.isForeground()) refresh()
  }, MUTE_CACHE_REFRESH_MS)
  const unsubscribeForeground = env.subscribe(refreshIfOld)
  const unsubscribeKey = subscribeLocal(muteCacheKey(did), () => {
    if (readLocal(muteCacheKey(did)) === undefined) refresh()
  })
  return () => {
    clearInterval(timer)
    unsubscribeForeground()
    unsubscribeKey()
  }
}

/** Forget the copies of signed-out accounts (on the device too). */
export function clearMuteCache(dids: Iterable<string>) {
  for (const did of dids) {
    stopped.add(did)
    states.delete(did)
    writeLocal(muteCacheKey(did), undefined)
  }
  parsed = undefined
  lookupMemo = undefined
}

/** Tests: forget everything held in memory. */
export function resetMuteCache() {
  states.clear()
  stopped.clear()
  parsed = undefined
  lookupMemo = undefined
}
