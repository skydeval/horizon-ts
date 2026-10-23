/*
 * The reader's own blocks and mutes, as the normalizer and the reply
 * fallback read them (refract client design 10.1, 10.2). One set of each per
 * account, in memory, loaded lazily on the first restored view or the first
 * reply fallback, never persisted.
 *
 * - Blocks: the reader's `app.bsky.graph.block` records, listed from their
 *   own PDS, 10 pages first, then the rest in the background. The set maps
 *   each blocked DID to its block record's URI, so stock renders the author
 *   as blocked and Unblock has its record.
 * - Mutes: `app.bsky.graph.getMutes` pages (1 h), the members of muted lists
 *   (`getListMutes`, then each list's members, at most 10 pages per list),
 *   and this session's mute changes (`noteRestoredMuteChange`).
 *
 * When a set finishes loading, listeners are told, so views normalized
 * before it can be refreshed. Logs name the part only, never a DID.
 */

import {type Client} from '@atproto/lex'
import {type AtIdentifierString} from '@atproto/syntax'

import {logger} from '#/logger'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {app, com} from '#/lexicons'

/** Pages read before the first answer is used; the rest go on after. */
export const FIRST_PAGES = 10
/** Pages of one muted list's members read at most. */
export const LIST_PAGES_MAX = 10
/** How long a loaded mute set is used before it is read again. */
export const MUTES_TTL_MS = 60 * 60_000

type Relations = {
  did: string
  blocks: Map<string, string>
  blocksState: 'idle' | 'loading' | 'loaded'
  blocksPromise: Promise<void> | undefined
  mutes: Set<string>
  muteShadows: Map<string, boolean>
  mutesState: 'idle' | 'loading' | 'loaded'
  mutesPromise: Promise<void> | undefined
  mutesAt: number
}

let relations: Relations | undefined
const loadListeners = new Set<() => void>()

function current(): Relations | undefined {
  const clients = getCurrentClients()
  if (!clients) return undefined
  if (relations?.did !== clients.did) {
    relations = {
      did: clients.did,
      blocks: new Map(),
      blocksState: 'idle',
      blocksPromise: undefined,
      mutes: new Set(),
      muteShadows: new Map(),
      mutesState: 'idle',
      mutesPromise: undefined,
      mutesAt: 0,
    }
  }
  return relations
}

function loaded(state: Relations) {
  if (relations === state) loadListeners.forEach(listener => listener())
}

async function listBlocks(
  state: Relations,
  pdsClient: Client,
  from: string | undefined,
  pages: number,
): Promise<string | undefined> {
  let cursor = from
  for (let page = 0; page < pages; page++) {
    const res = await pdsClient.call(com.atproto.repo.listRecords, {
      repo: state.did as AtIdentifierString,
      collection: 'app.bsky.graph.block',
      limit: 100,
      cursor,
    })
    for (const record of res.records) {
      const subject = (record.value as {subject?: unknown} | undefined)?.subject
      if (typeof subject === 'string') state.blocks.set(subject, record.uri)
    }
    if (!res.cursor || res.records.length === 0) return undefined
    cursor = res.cursor
  }
  return cursor
}

/**
 * Start loading the reader's block records, once per session. Resolves when
 * the first {@link FIRST_PAGES} are read (or failed); the rest are read in
 * the background.
 */
export function loadOwnBlocks(): Promise<void> {
  const state = current()
  const clients = getCurrentClients()
  if (!state || !clients) return Promise.resolve()
  if (state.blocksPromise) return state.blocksPromise
  state.blocksState = 'loading'
  state.blocksPromise = listBlocks(
    state,
    clients.pdsClient,
    undefined,
    FIRST_PAGES,
  )
    .then(rest => {
      state.blocksState = 'loaded'
      loaded(state)
      if (rest) {
        void listBlocks(state, clients.pdsClient, rest, Infinity)
          .then(() => loaded(state))
          .catch(error => {
            logger.info('refract: block listing stopped', {safeMessage: error})
          })
      }
    })
    .catch(error => {
      state.blocksState = 'loaded'
      logger.info('refract: block listing failed', {safeMessage: error})
    })
  return state.blocksPromise
}

async function readMutes(state: Relations, appview: Client) {
  const mutes = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < FIRST_PAGES; page++) {
    const res = await appview.call(app.bsky.graph.getMutes, {
      limit: 100,
      cursor,
    })
    res.mutes.forEach(profile => mutes.add(profile.did))
    if (!res.cursor || res.mutes.length === 0) break
    cursor = res.cursor
  }
  const lists = await appview.call(app.bsky.graph.getListMutes, {limit: 100})
  for (const list of lists.lists) {
    let listCursor: string | undefined
    for (let page = 0; page < LIST_PAGES_MAX; page++) {
      const res = await appview.call(app.bsky.graph.getList, {
        list: list.uri,
        limit: 100,
        cursor: listCursor,
      })
      res.items.forEach(item => mutes.add(item.subject.did))
      if (!res.cursor || res.items.length === 0) break
      listCursor = res.cursor
    }
  }
  state.mutes = mutes
}

/**
 * Start loading the reader's mutes, once per {@link MUTES_TTL_MS}.
 */
export function loadOwnMutes(): Promise<void> {
  const state = current()
  const clients = getCurrentClients()
  if (!state || !clients) return Promise.resolve()
  const fresh = Date.now() - state.mutesAt < MUTES_TTL_MS
  if (state.mutesPromise && (state.mutesState === 'loading' || fresh)) {
    return state.mutesPromise
  }
  state.mutesState = 'loading'
  state.mutesPromise = readMutes(state, clients.appviewClient)
    .catch(error => {
      logger.info('refract: mute listing failed', {safeMessage: error})
    })
    .then(() => {
      state.mutesState = 'loaded'
      state.mutesAt = Date.now()
      loaded(state)
    })
  return state.mutesPromise
}

/** Start both loads (the first restored view in the session). */
export function loadOwnRelations() {
  void loadOwnBlocks()
  void loadOwnMutes()
}

/** The reader's block record naming `did`, if the loaded set has one. */
export function ownBlockOf(did: string): string | undefined {
  return current()?.blocks.get(did)
}

/** Whether the reader's own block set is still loading. */
export function ownBlocksLoading(): boolean {
  const state = current()
  return !state || state.blocksState !== 'loaded'
}

/** Whether the reader mutes `did` (the loaded set and this session's changes). */
export function isOwnMuted(did: string): boolean {
  const state = current()
  if (!state) return false
  const shadow = state.muteShadows.get(did)
  if (shadow !== undefined) return shadow
  return state.mutes.has(did)
}

/** A mute or unmute made in this session (the stock mutation's success). */
export function noteRestoredMuteChange(did: string, muted: boolean) {
  current()?.muteShadows.set(did, muted)
}

/**
 * Called when a set finishes loading. Returns the unsubscribe function.
 */
export function onOwnRelationsLoaded(listener: () => void) {
  loadListeners.add(listener)
  return () => {
    loadListeners.delete(listener)
  }
}

/** Test-only: seed the sets without a load. */
export function seedOwnRelations({
  blocks = {},
  mutes = [],
}: {
  blocks?: Record<string, string>
  mutes?: string[]
}) {
  const state = current()
  if (!state) return
  state.blocks = new Map(Object.entries(blocks))
  state.blocksState = 'loaded'
  state.blocksPromise = Promise.resolve()
  state.mutes = new Set(mutes)
  state.mutesState = 'loaded'
  state.mutesPromise = Promise.resolve()
  state.mutesAt = Date.now()
}

/** Test-only: forget the sets. */
export function resetOwnRelations() {
  relations = undefined
}
