/*
 * Member labelers' labels on every AppView view.
 *
 * Their labels never come with AppView answers (the AppView never hears of
 * these labelers). So for a member with labelers, each AppView read's
 * answer is held until prism says which of their labels apply to the posts,
 * accounts, lists and feeds in it, and those labels are added to the views'
 * `labels` before anything moderates them. A `!hide` therefore applies
 * before the item is ever shown.
 *
 * - Only reads (`GET /xrpc/app.bsky.*`) are touched, and only when the
 *   account has labelers.
 * - Labels are kept in memory for a minute per viewer and subject, so
 *   scrolling back or reading the same post twice asks nothing.
 * - If prism takes longer than {@link LABELS_WAIT_MS}, the answer goes
 *   through as it came; the labels land in the cache for the next read.
 * - Nothing is written anywhere: views are edited in the answer only.
 */

import {type Agent, type Client} from '@atproto/lex'

import {getCurrentClients} from '#/horizon/routing/current-clients'
import {type RawMemberLabel} from './api'

/** The most subjects one labels call takes (prism's limit). */
const LABELS_BATCH = 100

/**
 * Where labels come from. Connected at startup (`MemberLabelersSync`)
 * rather than imported, because the session's clients load this module and
 * prism's calls load the session: an import here would be a cycle.
 */
export type MemberLabelsSource = {
  hasLabelers(did: string): boolean
  fetchLabels(pdsClient: Client, subjects: string[]): Promise<RawMemberLabel[]>
}

let source: MemberLabelsSource | undefined

/** Connect the labels source. Until then, answers pass through untouched. */
export function connectMemberLabels(next: MemberLabelsSource | undefined) {
  source = next
}

function hasMemberLabelers(did: string): boolean {
  return !!source?.hasLabelers(did)
}

function fetchMemberLabels(pdsClient: Client, subjects: string[]) {
  if (!source) return Promise.resolve([])
  return source.fetchLabels(pdsClient, subjects)
}

/** How long a subject's labels are kept. */
export const LABELS_TTL_MS = 60_000
/** How long an AppView answer waits for its labels. */
export const LABELS_WAIT_MS = 2_000
/** The most subjects asked for one answer. */
const MAX_SUBJECTS = LABELS_BATCH * 3

type Entry = {labels: RawMemberLabel[]; at: number}

/** By viewer, then subject. */
const cache = new Map<string, Map<string, Entry>>()
/** Subjects being asked for, by viewer, then subject. */
const pending = new Map<string, Map<string, Promise<void>>>()

const READ = /^\/xrpc\/app\.bsky\.[A-Za-z0-9.]+(?:[?#]|$)/

type Target = {labels?: unknown}

/** Where the labels of one subject go in an answer. */
type Found = Map<string, Target[]>

function add(found: Found, subject: string, target: Target) {
  const list = found.get(subject)
  if (list) list.push(target)
  else found.set(subject, [target])
}

/**
 * Every view in `body` that carries labels: posts, embedded records, lists
 * and feeds by URI (they have a `cid` and an `author` or `creator`), and
 * accounts by DID (they have a `handle`).
 */
export function findSubjects(body: unknown): Found {
  const found: Found = new Map()
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
      typeof view.uri === 'string' &&
      view.uri.startsWith('at://') &&
      typeof view.cid === 'string' &&
      ((view.author && typeof view.author === 'object') ||
        (view.creator && typeof view.creator === 'object'))
    ) {
      add(found, view.uri, view)
    } else if (
      typeof view.did === 'string' &&
      view.did.startsWith('did:') &&
      typeof view.handle === 'string'
    ) {
      add(found, view.did, view)
    }
    for (const key in view) {
      // A post's own record is content, not a view (an embed's `record` is).
      if (key === 'record' && 'author' in view) continue
      if (key === 'value') continue
      walk(view[key], depth + 1)
    }
  }
  walk(body, 0)
  return found
}

function fresh(viewer: string, subject: string, now: number) {
  const entry = cache.get(viewer)?.get(subject)
  return entry && now - entry.at < LABELS_TTL_MS ? entry : undefined
}

/**
 * Ask prism for the labels of the subjects not cached, in batches. Resolves
 * when every batch has answered or failed.
 */
async function ensure(
  viewer: string,
  pdsClient: Client,
  subjects: string[],
): Promise<void> {
  const now = Date.now()
  let byViewer = pending.get(viewer)
  if (!byViewer) {
    byViewer = new Map()
    pending.set(viewer, byViewer)
  }
  const waits: Promise<void>[] = []
  const missing: string[] = []
  for (const subject of subjects) {
    if (fresh(viewer, subject, now)) continue
    const inFlight = byViewer.get(subject)
    if (inFlight) waits.push(inFlight)
    else missing.push(subject)
  }
  for (let i = 0; i < missing.length; i += LABELS_BATCH) {
    const batch = missing.slice(i, i + LABELS_BATCH)
    const request = fetchMemberLabels(pdsClient, batch).then(
      labels => {
        const at = Date.now()
        let entries = cache.get(viewer)
        if (!entries) {
          entries = new Map()
          cache.set(viewer, entries)
        }
        const grouped = new Map<string, RawMemberLabel[]>()
        for (const label of labels) {
          const list = grouped.get(label.uri)
          if (list) list.push(label)
          else grouped.set(label.uri, [label])
        }
        for (const subject of batch) {
          entries.set(subject, {labels: grouped.get(subject) ?? [], at})
        }
      },
      () => {
        // Nothing cached: the next read asks again.
      },
    )
    const done = request.finally(() => {
      for (const subject of batch) {
        if (byViewer.get(subject) === done) byViewer.delete(subject)
      }
    })
    for (const subject of batch) byViewer.set(subject, done)
    waits.push(done)
  }
  await Promise.all(waits)
}

/**
 * Add `viewer`'s cached labels to the views of `found`. Returns whether any
 * were added.
 */
function merge(viewer: string, found: Found): boolean {
  const now = Date.now()
  let changed = false
  for (const [subject, targets] of found) {
    const labels = fresh(viewer, subject, now)?.labels
    if (!labels?.length) continue
    for (const target of targets) {
      const existing = Array.isArray(target.labels)
        ? (target.labels as {src?: unknown; val?: unknown}[])
        : []
      const have = new Set(
        existing.map(label => `${String(label.src)} ${String(label.val)}`),
      )
      const extra = labels
        .filter(label => !have.has(`${label.src} ${label.val}`))
        .map(label => ({...label, uri: subject}))
      if (extra.length === 0) continue
      target.labels = [...existing, ...extra]
      changed = true
    }
  }
  return changed
}

/**
 * Add the member labelers' labels to an AppView answer for `viewer`, waiting
 * at most {@link LABELS_WAIT_MS}. Returns the answer, rebuilt when labels
 * were added.
 */
export async function labelAnswer(
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
  const found = findSubjects(body)
  if (found.size === 0) return response
  const subjects = Array.from(found.keys()).slice(0, MAX_SUBJECTS)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    ensure(viewer, pdsClient, subjects),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, LABELS_WAIT_MS)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (!merge(viewer, found)) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const wrapped = new WeakMap<object, Agent>()

/**
 * The same agent, with member labelers' labels added to its AppView reads
 * while the signed-in account (the agent's own) has labelers. Idempotent.
 */
export function withMemberLabels(agent: Agent): Agent {
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
            !hasMemberLabelers(viewer)
          ) {
            return response
          }
          return labelAnswer(viewer, current.pdsClient, response)
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

/** Drop every cached label (sign-out, account switch, a list change). */
export function dropMemberLabels(viewer?: string) {
  if (viewer === undefined) {
    cache.clear()
    pending.clear()
  } else {
    cache.delete(viewer)
    pending.delete(viewer)
  }
}
