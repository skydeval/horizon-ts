/*
 * Block state from prism on every AppView answer.
 *
 * The AppView can miss blocks: a block through a list it can't find, or
 * someone blocking the reader that it doesn't report. prism answers block
 * state from its own index (`app.nearhorizon.blocks.check`), so for a member
 * prism serves it to, each AppView read's answer is held until prism says
 * which of the accounts in it block or are blocked by the reader, and those
 * blocks are set on the accounts' `viewer` before anything moderates them.
 * A block either side reports counts; nothing prism says removes one the
 * AppView reports.
 *
 * - Only reads (`GET /xrpc/app.bsky.*`) are touched.
 * - The wait is soft: past {@link BLOCKS_WAIT_MS} the answer goes through as
 *   it came, and prism's answer lands in the cache for the next read.
 * - A `partial` answer asserts nothing it didn't find: incomplete coverage
 *   never counts as a block.
 * - Answers are kept a minute per viewer and account. An unblock or a list
 *   unsubscribe the reader just made is honoured at once, whatever prism's
 *   copy still says ({@link forgetBlock}, {@link forgetBlockList}).
 * - When prism is unavailable, reads go through untouched and prism isn't
 *   asked again for a while.
 */

import {type Agent, type Client} from '@atproto/lex'
import {i18n} from '@lingui/core'
import {msg} from '@lingui/core/macro'

import {getCurrentClients} from '#/horizon/routing/current-clients'

/** The most accounts one check takes (prism's limit). */
export const BLOCKS_BATCH = 100

/** A list someone blocks through, as prism read it from the list itself. */
export type BlockList = {
  uri: string
  cid?: string
  /** Empty when prism couldn't read the list. */
  name?: string
  purpose?: string
  avatar?: string
}

/** One account's block state with the reader. */
export type BlockState = {
  did: string
  blocking?: {direct?: string; lists?: BlockList[]}
  blockedBy?: {direct?: boolean; lists?: BlockList[]}
  /** prism's coverage was incomplete: only what it found is asserted. */
  partial?: boolean
}
/** The most accounts asked for one answer. */
const MAX_ACCOUNTS = BLOCKS_BATCH * 3
/** How long an account's block state is kept. */
export const BLOCKS_TTL_MS = 60_000
/** How long a partial answer that found nothing is kept. */
const PARTIAL_TTL_MS = 10_000
/** How long an AppView answer waits for prism. */
export const BLOCKS_WAIT_MS = 2_000
/** After prism fails a check, how long until it's asked again. */
export const BLOCKS_BACKOFF_MS = 60_000
/** How long the reader's own unblock outweighs prism's copy. */
const FORGET_MS = 2 * BLOCKS_TTL_MS

/**
 * A list's address (and cid) when prism couldn't read it: valid in the
 * lexicon, so the answer still passes the stock checks.
 */
const PLACEHOLDER_CID =
  'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'

/**
 * Where block state comes from. Connected at startup (`BlockStateSync`)
 * rather than imported, because the session's clients load this module and
 * prism's calls load the session: an import here would be a cycle.
 */
export type BlockStateSource = {
  serves(did: string): boolean
  fetchStates(pdsClient: Client, others: string[]): Promise<BlockState[]>
}

let source: BlockStateSource | undefined

/** Connect the source. Until then, answers pass through untouched. */
export function connectBlockState(next: BlockStateSource | undefined) {
  source = next
}

function servesBlockChecks(did: string): boolean {
  return !!source?.serves(did)
}

function fetchStates(pdsClient: Client, others: string[]) {
  if (!source) return Promise.resolve([])
  return source.fetchStates(pdsClient, others)
}

type Entry = {state: BlockState; at: number; ttl: number}

/** By viewer, then account. */
const cache = new Map<string, Map<string, Entry>>()
/** Accounts being asked for, by viewer, then account. */
const pending = new Map<string, Map<string, Promise<void>>>()
/** No check for this viewer before this time. */
const backoffUntil = new Map<string, number>()
/** Accounts the reader just unblocked, by viewer, then account: when. */
const forgotten = new Map<string, Map<string, number>>()
/** Lists the reader just stopped blocking through, by viewer, then list. */
const forgottenLists = new Map<string, Map<string, number>>()

function recent(map: Map<string, Map<string, number>>, a: string, b: string) {
  const at = map.get(a)?.get(b)
  return at !== undefined && Date.now() - at < FORGET_MS
}

function remember(map: Map<string, Map<string, number>>, a: string, b: string) {
  let inner = map.get(a)
  if (!inner) {
    inner = new Map()
    map.set(a, inner)
  }
  inner.set(b, Date.now())
}

/** The reader unblocked `other`: prism's copy of that block is ignored. */
export function forgetBlock(viewer: string, other: string) {
  remember(forgotten, viewer, other)
  cache.get(viewer)?.delete(other)
}

/** The reader stopped blocking through `list`: prism's copy is ignored. */
export function forgetBlockList(viewer: string, list: string) {
  remember(forgottenLists, viewer, list)
}

/** Drop every cached answer (sign-out, account switch). */
export function dropBlockStates(viewer?: string) {
  if (viewer === undefined) {
    cache.clear()
    pending.clear()
    backoffUntil.clear()
  } else {
    cache.delete(viewer)
    pending.delete(viewer)
    backoffUntil.delete(viewer)
  }
}

function fresh(viewer: string, other: string, now: number) {
  const entry = cache.get(viewer)?.get(other)
  return entry && now - entry.at < entry.ttl ? entry : undefined
}

function found(state: BlockState): boolean {
  return !!(
    state.blocking?.direct ||
    state.blocking?.lists?.length ||
    state.blockedBy?.direct ||
    state.blockedBy?.lists?.length
  )
}

/** Ask prism for the accounts not cached, in batches. */
async function ensure(
  viewer: string,
  pdsClient: Client,
  others: string[],
): Promise<void> {
  const now = Date.now()
  if ((backoffUntil.get(viewer) ?? 0) > now) return
  let byViewer = pending.get(viewer)
  if (!byViewer) {
    byViewer = new Map()
    pending.set(viewer, byViewer)
  }
  const waits: Promise<void>[] = []
  const missing: string[] = []
  for (const other of others) {
    if (fresh(viewer, other, now)) continue
    const inFlight = byViewer.get(other)
    if (inFlight) waits.push(inFlight)
    else missing.push(other)
  }
  for (let i = 0; i < missing.length; i += BLOCKS_BATCH) {
    const batch = missing.slice(i, i + BLOCKS_BATCH)
    const request = fetchStates(pdsClient, batch).then(
      states => {
        const at = Date.now()
        let entries = cache.get(viewer)
        if (!entries) {
          entries = new Map()
          cache.set(viewer, entries)
        }
        const byDid = new Map(states.map(state => [state.did, state]))
        for (const other of batch) {
          const state = byDid.get(other) ?? {did: other}
          const ttl =
            state.partial && !found(state) ? PARTIAL_TTL_MS : BLOCKS_TTL_MS
          entries.set(other, {state, at, ttl})
        }
      },
      () => {
        backoffUntil.set(viewer, Date.now() + BLOCKS_BACKOFF_MS)
      },
    )
    const done = request.finally(() => {
      for (const other of batch) {
        if (byViewer.get(other) === done) byViewer.delete(other)
      }
    })
    for (const other of batch) byViewer.set(other, done)
    waits.push(done)
  }
  await Promise.all(waits)
}

type Account = {did: string; viewer?: Record<string, unknown>}

/** Every account view in `body` (a DID and a handle), by DID. */
export function findAccounts(body: unknown): Map<string, Account[]> {
  const accounts = new Map<string, Account[]>()
  const seen = new Set<object>()
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 24) return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const each of value) walk(each, depth + 1)
      return
    }
    const view = value as Record<string, unknown>
    if (
      typeof view.did === 'string' &&
      view.did.startsWith('did:') &&
      typeof view.handle === 'string'
    ) {
      const list = accounts.get(view.did)
      if (list) list.push(view as Account)
      else accounts.set(view.did, [view as Account])
    }
    for (const key in view) {
      // A post's own record is content, not a view.
      if (key === 'record' && 'author' in view) continue
      if (key === 'value') continue
      walk(view[key], depth + 1)
    }
  }
  walk(body, 0)
  return accounts
}

/** The name shown for a list prism couldn't read. */
function unnamedList(): string {
  try {
    return i18n._(msg`A moderation list`)
  } catch {
    // No locale active yet: a read must never fail over a name.
    return 'A moderation list'
  }
}

/** A list as the stock `listViewBasic` the moderation display reads. */
export function listViewBasic(list: BlockList) {
  return {
    $type: 'app.bsky.graph.defs#listViewBasic',
    uri: list.uri,
    cid: list.cid || PLACEHOLDER_CID,
    name: list.name || unnamedList(),
    purpose: list.purpose || 'app.bsky.graph.defs#modlist',
    ...(list.avatar ? {avatar: list.avatar} : {}),
  }
}

/**
 * Set `viewer`'s cached blocks on the account views of `accounts`. Returns
 * whether any view changed.
 */
function merge(viewer: string, accounts: Map<string, Account[]>): boolean {
  const now = Date.now()
  let changed = false
  for (const [did, views] of accounts) {
    if (did === viewer) continue
    const state = fresh(viewer, did, now)?.state
    if (!state || !found(state)) continue
    const ignoreDirect = recent(forgotten, viewer, did)
    const blockingList = state.blocking?.lists?.find(
      list =>
        typeof list?.uri === 'string' &&
        !recent(forgottenLists, viewer, list.uri),
    )
    const direct = ignoreDirect ? undefined : state.blocking?.direct
    const blockedBy = !!(
      state.blockedBy?.direct || state.blockedBy?.lists?.length
    )
    for (const view of views) {
      const v = view.viewer ?? {}
      let touched = false
      if (blockingList && !v.blockingByList) {
        v.blockingByList = listViewBasic(blockingList)
        touched = true
      }
      // Moderation counts a list block only with `blocking` set too.
      if (!v.blocking && (direct || blockingList)) {
        v.blocking = direct || blockingList?.uri
        touched = true
      }
      if (blockedBy && v.blockedBy !== true) {
        v.blockedBy = true
        touched = true
      }
      if (touched) {
        view.viewer = v
        changed = true
      }
    }
  }
  return changed
}

/**
 * How `other` and the reader block each other, by prism's cached answer:
 * `BlockedActor` when the reader blocks them, `BlockedByActor` when they
 * block the reader (the AppView's own error names), or nothing.
 */
function blockBetween(
  viewer: string,
  other: string,
): 'BlockedActor' | 'BlockedByActor' | undefined {
  if (other === viewer) return undefined
  const state = fresh(viewer, other, Date.now())?.state
  if (!state || !found(state)) return undefined
  if (state.blockedBy?.direct || state.blockedBy?.lists?.length) {
    return 'BlockedByActor'
  }
  const direct = recent(forgotten, viewer, other)
    ? undefined
    : state.blocking?.direct
  const list = state.blocking?.lists?.some(
    l => typeof l?.uri === 'string' && !recent(forgottenLists, viewer, l.uri),
  )
  return direct || list ? 'BlockedActor' : undefined
}

/**
 * Whether the signed-in reader and `other` block each other, by prism,
 * waiting at most {@link BLOCKS_WAIT_MS} for an answer not cached. Nothing
 * when prism doesn't serve block checks or can't answer in time.
 */
export async function checkBlockWith(
  other: string,
): Promise<'BlockedActor' | 'BlockedByActor' | undefined> {
  if (!other.startsWith('did:')) return undefined
  const current = getCurrentClients()
  const viewer = current?.did
  if (!current || !viewer || other === viewer) return undefined
  if (!servesBlockChecks(viewer)) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    ensure(viewer, current.pdsClient, [other]),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, BLOCKS_WAIT_MS)
    }),
  ])
  if (timer) clearTimeout(timer)
  return blockBetween(viewer, other)
}

/**
 * Leave out of a feed answer the reposts by accounts that block or are
 * blocked by the reader, as the AppView does for blocks it knows. Returns
 * whether any was left out.
 */
function dropBlockedReposts(viewer: string, body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const feed = (body as {feed?: unknown}).feed
  if (!Array.isArray(feed)) return false
  const kept = feed.filter(item => {
    const by = (item as {reason?: {by?: {did?: unknown}}})?.reason?.by?.did
    return typeof by !== 'string' || !blockBetween(viewer, by)
  })
  if (kept.length === feed.length) return false
  ;(body as {feed: unknown[]}).feed = kept
  return true
}

/**
 * Set prism's block state on an AppView answer for `viewer`, waiting at most
 * {@link BLOCKS_WAIT_MS}. Returns the answer, rebuilt when a block was set.
 */
export async function blockAnswer(
  viewer: string,
  pdsClient: Client,
  response: Response,
): Promise<Response> {
  if (!response.ok) return response
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return response
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return response
  }
  const accounts = findAccounts(body)
  accounts.delete(viewer)
  if (accounts.size === 0) return response
  const others = Array.from(accounts.keys()).slice(0, MAX_ACCOUNTS)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    ensure(viewer, pdsClient, others),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, BLOCKS_WAIT_MS)
    }),
  ])
  if (timer) clearTimeout(timer)
  const merged = merge(viewer, accounts)
  const dropped = dropBlockedReposts(viewer, body)
  if (!merged && !dropped) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const READ = /^\/xrpc\/app\.bsky\.[A-Za-z0-9.]+(?:[?#]|$)/

const wrapped = new WeakMap<object, Agent>()

/**
 * The same agent, with prism's block state set on its AppView reads while
 * prism serves block checks to the signed-in account. Idempotent.
 */
export function withBlockState(agent: Agent): Agent {
  const known = wrapped.get(agent)
  if (known) return known
  const proxy = new Proxy(agent, {
    get(target, prop) {
      if (prop === 'fetchHandler') {
        return async (path: `/${string}`, init: RequestInit) => {
          const response = await target.fetchHandler(path, init)
          const method = (init?.method ?? 'GET').toUpperCase()
          if (method !== 'GET' || !READ.test(path)) return response
          const current = getCurrentClients()
          const viewer = target.did
          if (
            !current ||
            !viewer ||
            current.did !== viewer ||
            !servesBlockChecks(viewer)
          ) {
            return response
          }
          return blockAnswer(viewer, current.pdsClient, response)
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrapped.set(agent, proxy)
  wrapped.set(proxy, proxy)
  return proxy
}

/** Tests: forget everything. */
export function resetBlockStates() {
  dropBlockStates()
  forgotten.clear()
  forgottenLists.clear()
  source = undefined
}
