/*
 * A profile owner's reposts of restored posts, on that owner's profile
 * (refract client design 4.1, "Feed tabs"). Bluesky's `getAuthorFeed` drops
 * a repost whose subject it can't hydrate, so anyone's repost of a restored
 * post counts on the post but is missing from the reposter's Posts and
 * Replies tabs.
 *
 * - Only `author|<owner>|<filter>`, for the tabs stock shows reposts on, on
 *   any profile the reader views (their own or another account's) while
 *   Refract is active. A restored owner's tabs come from prism instead
 *   (`author-feed.ts`).
 * - Every stock page passes through as it is. Its time window runs from the
 *   previous page's oldest item (the top page: now) down to its own oldest
 *   item (the last page: the start). The owner's reposts are read newest
 *   first, kept on this API instance and read further as the feed pages, at
 *   most {@link PROFILE_REPOST_PAGES_PER_LOAD} pages per feed page. The top
 *   page reads its first page alongside stock.
 * - **Where they come from.** prism's `refract.getAuthorReposts {actor}`
 *   (50 a page): feed items whose post prism already rendered and whose
 *   reason is a `reasonRepost` by the owner, placed by the reason's
 *   `indexedAt` and deduped by repost URI. prism names no feature for it, so
 *   only a refusal (the method isn't served: 404, 501, `MethodNotImplemented`)
 *   turns on the old path for the session: the owner's `app.bsky.feed.repost`
 *   records from their repo (`listRecords`, 100 a page), each subject read
 *   from the restored-post store, else from one `fill`. The reader's own repo
 *   is read with their PDS client; another owner's without a session, from
 *   the PDS their DID document names (repo records are public).
 * - Pages are shared while a read runs and kept for
 *   {@link PROFILE_REPOST_CACHE_MS} (another owner's) so the Posts and
 *   Replies tabs, and a quick return to the profile, read once. The reader's
 *   own pages are only shared in flight, so an unrepost shows on the next
 *   load.
 * - A repost stock already shows (its `reason.uri`, or a repost item of its
 *   subject) is left alone. The rest are inserted by time as repost items,
 *   `reason` a `reasonRepost` by the owner. Anything else stays dropped, as
 *   stock has it.
 * - A failure, or a read or `fill` slower than
 *   {@link PROFILE_REPOST_DEADLINE_MS}, leaves the page as stock sent it.
 * - An unrepost deletes the record, so the next load from the top no longer
 *   shows it.
 *
 * Quotes need nothing here: a quote is the owner's own post, which stock
 * keeps, and its restored embed is filled by the quote slot (4.4). Replies
 * under restored posts are the owner's own posts too.
 */

import {XrpcResponseError} from '@atproto/lex'
import {type AtIdentifierString} from '@atproto/syntax'

import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {createLexClient} from '#/lib/lexClient'
import {logger} from '#/logger'
import {networkAwareFetch} from '#/state/session/network'
import {authorPdsUrl} from '#/horizon/private/adapt/pds'
import {refractCall} from '#/horizon/refract/api'
import {askFill, isDefinitelyNotRestored} from '#/horizon/refract/fill'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {peekRestoredPost} from '#/horizon/refract/store'
import {
  getCurrentClients,
  getCurrentDid,
  getCurrentPdsClient,
} from '#/horizon/routing/current-clients'
import {app, com} from '#/lexicons'
import * as bsky from '#/types/bsky'

type FeedViewPost = app.bsky.feed.defs.FeedViewPost
type PostView = app.bsky.feed.defs.PostView
type ProfileViewBasic = app.bsky.actor.defs.ProfileViewBasic

const REPOST_COLLECTION = 'app.bsky.feed.repost'
const POST_COLLECTION = 'app.bsky.feed.post'

/** The tabs on which stock shows the author's reposts. */
const REPOST_FILTERS = new Set([
  '',
  'posts_and_author_threads',
  'posts_with_replies',
  'posts_no_replies',
])

/** Repost records read per page of the owner's repo (the fallback). */
export const PROFILE_REPOST_RECORDS_LIMIT = 100

/** Reposts read per `refract.getAuthorReposts` page. */
export const PROFILE_REPOST_PRISM_LIMIT = 50

/** The most record pages one feed page reads. */
export const PROFILE_REPOST_PAGES_PER_LOAD = 3

/** How long a feed page waits on one repo read, or on the `fill`. */
export const PROFILE_REPOST_DEADLINE_MS = 3_000

/** How long another owner's record pages are kept. */
export const PROFILE_REPOST_CACHE_MS = 60_000

/** The most record pages kept at once. */
const CACHE_MAX = 100

/**
 * One page of the owner's reposts, newest first: repo records (the fallback)
 * or prism's ready feed items.
 */
export type RepostRecordPage = {
  records: {uri: string; cid?: string; value: unknown}[]
  /** prism's items, each a `reasonRepost` by the owner. */
  items?: FeedViewPost[]
  cursor?: string
}

/** Reads one page of the owner's reposts from `cursor`. */
export type ListRepostRecords = (
  cursor: string | undefined,
) => Promise<RepostRecordPage>

/** A client that reads `did`'s repo. */
export type RepoClientFor = (
  did: string,
) => Promise<Pick<ReturnType<typeof createLexClient>, 'call'>>

type RepostRecord = {
  uri: string
  cid?: string
  subject: string
  createdAt: string
  time: number
  /** prism's item, ready to show; repo records have none. */
  item?: FeedViewPost
}

function timeOf(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(parsed) ? NaN : parsed
}

function authorOf(uri: string): string | undefined {
  return uri.startsWith('at://') ? uri.split('/')[2] : undefined
}

function isPostUri(uri: string): boolean {
  const parts = uri.split('/')
  return (
    uri.startsWith('at://') &&
    parts.length === 5 &&
    parts[3] === POST_COLLECTION &&
    !!parts[4]
  )
}

function readRecord(record: {
  uri: string
  cid?: string
  value: unknown
}): RepostRecord | undefined {
  const value = record.value as
    {subject?: {uri?: unknown}; createdAt?: unknown} | null | undefined
  const subject = value?.subject?.uri
  const time = timeOf(value?.createdAt)
  if (typeof subject !== 'string' || Number.isNaN(time)) return undefined
  return {
    uri: record.uri,
    cid: record.cid,
    subject,
    createdAt: value!.createdAt as string,
    time,
  }
}

/** prism's item as a record, if it is a readable repost by `owner`. */
function readItem(item: FeedViewPost, owner: string): RepostRecord | undefined {
  const reason = item?.reason as
    | {$type?: unknown; uri?: unknown; cid?: unknown; indexedAt?: unknown}
    | undefined
  if (!bsky.isType(app.bsky.feed.defs.reasonRepost, reason)) return undefined
  const by = (reason as {by?: {did?: unknown}}).by
  if (by?.did !== owner) return undefined
  const uri = item.post?.uri
  const time = timeOf(reason.indexedAt)
  if (typeof uri !== 'string' || Number.isNaN(time)) return undefined
  return {
    uri: typeof reason.uri === 'string' ? reason.uri : `${uri}|${owner}`,
    cid: typeof reason.cid === 'string' ? reason.cid : undefined,
    subject: uri,
    createdAt: reason.indexedAt,
    time,
    item,
  }
}

function isRepostItem(item: FeedViewPost) {
  return bsky.isType(app.bsky.feed.defs.reasonRepost, item.reason)
}

function isPinItem(item: FeedViewPost) {
  return bsky.isType(app.bsky.feed.defs.reasonPin, item.reason)
}

/** A stock item's time: a repost's, else the post's `indexedAt`. */
function itemTime(item: FeedViewPost): number {
  const reason = item.reason
  if (bsky.isType(app.bsky.feed.defs.reasonRepost, reason)) {
    return timeOf(reason.indexedAt)
  }
  return timeOf(item.post.indexedAt)
}

function basicOf(profile: Record<string, unknown>): ProfileViewBasic {
  const keys = [
    'did',
    'handle',
    'displayName',
    'avatar',
    'associated',
    'labels',
    'viewer',
    'createdAt',
    'verification',
    'status',
  ]
  const basic: Record<string, unknown> = {}
  for (const key of keys) {
    if (profile[key] !== undefined) basic[key] = profile[key]
  }
  return basic as unknown as ProfileViewBasic
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * The owner's author feed with their reposts of restored posts put back in.
 */
export class ProfileRepostsFeedAPI implements FeedAPI {
  /** Records read and not yet placed, newest first. */
  private records: RepostRecord[] = []
  private listCursor: string | undefined
  private listDone = false
  private listFailed = false
  /** The oldest record time read so far. */
  private listedLow = Infinity
  /** A window's upper bound for each stock cursor this API returned. */
  private highs = new Map<string, number>()
  /** The repost record URIs and subjects stock has shown. */
  private stockReposts = new Set<string>()
  private stockSubjects = new Set<string>()

  constructor(
    private readonly stock: FeedAPI,
    private readonly did: string,
    private readonly list: ListRepostRecords,
  ) {}

  peekLatest(): Promise<FeedViewPost> {
    return this.stock.peekLatest()
  }

  private async readPage(): Promise<void> {
    if (this.listDone || this.listFailed) return
    try {
      const asked = this.listCursor
      const page = await withDeadline(
        this.list(asked),
        PROFILE_REPOST_DEADLINE_MS,
      )
      const read = [
        ...page.records.map(readRecord),
        ...(page.items ?? []).map(item => readItem(item, this.did)),
      ]
      for (const record of read) {
        if (!record) continue
        this.records.push(record)
        if (record.time < this.listedLow) this.listedLow = record.time
      }
      const next =
        page.cursor && page.cursor !== asked ? page.cursor : undefined
      this.listCursor = next
      if (!next) this.listDone = true
    } catch {
      // Stock only until the tab is loaded again from the top.
      this.listFailed = true
    }
  }

  /** Read records until every one newer than `low` is read, within the cap. */
  private async readUntil(low: number, alreadyRead: number) {
    let pages = alreadyRead
    while (
      !this.listDone &&
      !this.listFailed &&
      this.listedLow > low &&
      pages < PROFILE_REPOST_PAGES_PER_LOAD
    ) {
      await this.readPage()
      pages++
    }
  }

  /** The owner as a repost's `by`: the profile query's view, else the feed's. */
  private byProfile(feed: FeedViewPost[]): ProfileViewBasic {
    const clients = getCurrentClients()
    const cached = clients?.queryClient?.getQueryData<Record<string, unknown>>([
      'profile',
      this.did,
    ])
    if (cached?.did === this.did) return basicOf(cached)
    const own = feed.find(item => item.post.author.did === this.did)
    if (own) return own.post.author
    for (const item of feed) {
      const by = (item.reason as {by?: ProfileViewBasic} | undefined)?.by
      if (isRepostItem(item) && by?.did === this.did) return by
    }
    const handle =
      clients?.did === this.did ? (clients.handle ?? this.did) : this.did
    return basicOf({did: this.did, handle})
  }

  /** The restored posts for `subjects`, from the store or one `fill`. */
  private async resolve(subjects: string[]): Promise<Map<string, PostView>> {
    const found = new Map<string, PostView>()
    const ask: string[] = []
    for (const uri of subjects) {
      const stored = peekRestoredPost(uri)
      if (stored) found.set(uri, stored)
      else ask.push(uri)
    }
    if (ask.length === 0) return found
    try {
      const outcome = await withDeadline(
        askFill({uris: ask}, {kind: 'slot', foreground: true, screen: true}),
        PROFILE_REPOST_DEADLINE_MS,
      )
      for (const uri of ask) {
        const verdict = outcome.uris.get(uri)
        if (verdict?.kind === 'positive') found.set(uri, verdict.post)
      }
    } catch {
      // Left out, as stock leaves them.
    }
    return found
  }

  async fetch(params: {
    cursor: string | undefined
    limit: number
    signal?: AbortSignal
  }): Promise<FeedAPIResponse> {
    const {cursor} = params
    const high = cursor === undefined ? Infinity : this.highs.get(cursor)
    // A cursor this API didn't return (an older cache) stays stock.
    if (high === undefined) return this.stock.fetch(params)
    const top = cursor === undefined
    const first = top ? this.readPage() : Promise.resolve()
    const res = await this.stock.fetch(params)
    await first

    for (const item of res.feed) {
      if (!isRepostItem(item)) continue
      const reason = item.reason as {uri?: string}
      if (reason.uri) this.stockReposts.add(reason.uri)
      this.stockSubjects.add(item.post.uri)
    }

    const times = res.feed
      .filter(item => !isPinItem(item))
      .map(itemTime)
      .filter(time => !Number.isNaN(time))
    let low = res.cursor
      ? times.length
        ? Math.min(...times)
        : high
      : -Infinity
    await this.readUntil(low, top ? 1 : 0)
    if (!this.listDone && !this.listFailed) {
      // Records older than what was read wait for the next page.
      low = Math.max(low, this.listedLow)
    }

    const placed = this.records.filter(record => record.time > low)
    this.records = this.records.filter(record => record.time <= low)
    if (res.cursor) this.highs.set(res.cursor, low)

    const candidates = placed.filter(record => {
      if (this.stockReposts.has(record.uri)) return false
      if (this.stockSubjects.has(record.subject)) return false
      if (!isPostUri(record.subject)) return false
      const author = authorOf(record.subject)
      if (!author || author === this.did) return false
      // prism's items are restored by its own word.
      return !!record.item || !isDefinitelyNotRestored(author)
    })
    if (candidates.length === 0) return res

    const ask = candidates.filter(record => !record.item)
    const posts =
      ask.length > 0
        ? await this.resolve(
            Array.from(new Set(ask.map(record => record.subject))),
          )
        : new Map<string, PostView>()
    if (posts.size === 0 && ask.length === candidates.length) return res

    const by = this.byProfile(res.feed)
    const feed = [...res.feed]
    const shown = new Set<string>()
    for (const record of candidates) {
      const post = record.item?.post ?? posts.get(record.subject)
      if (!post || shown.has(record.subject)) continue
      shown.add(record.subject)
      this.stockSubjects.add(record.subject)
      const item: FeedViewPost = record.item ?? {
        post,
        reason: {
          $type: 'app.bsky.feed.defs#reasonRepost',
          by,
          uri: record.uri as never,
          ...(record.cid ? {cid: record.cid} : {}),
          indexedAt: record.createdAt as never,
        },
      }
      const at = feed.findIndex(
        other => !isPinItem(other) && itemTime(other) < record.time,
      )
      if (at === -1) feed.push(item)
      else feed.splice(at, 0, item)
    }
    return {...res, feed}
  }
}

/**
 * An unauthenticated client for the PDS `did`'s DID document names, as the
 * private code reads another account's gate records. Throws when the PDS is
 * unknown.
 */
export async function ownerPdsClient(did: string) {
  const pdsUrl = await authorPdsUrl(did)
  if (!pdsUrl) throw new Error('The PDS of a profile owner could not be found')
  return createLexClient(
    {service: pdsUrl, fetch: networkAwareFetch},
    {appLabelers: null},
  )
}

type CacheEntry = {
  promise: Promise<RepostRecordPage>
  /** When the read settled; `undefined` while it runs. */
  at?: number
}

/** Record pages by `<did>|<cursor>`, shared in flight and kept briefly. */
const pageCache = new Map<string, CacheEntry>()

function prune(now: number) {
  for (const [key, entry] of pageCache) {
    if (entry.at !== undefined && now - entry.at >= PROFILE_REPOST_CACHE_MS) {
      pageCache.delete(key)
    }
  }
  // Oldest first, as a Map iterates in insertion order.
  for (const key of pageCache.keys()) {
    if (pageCache.size <= CACHE_MAX) break
    pageCache.delete(key)
  }
}

/**
 * `read` with one in-flight read per owner and cursor, and settled pages
 * kept for `keepMs` (0: only shared while running). A failed read is not
 * kept.
 */
export function sharedRepostPages(
  did: string,
  read: ListRepostRecords,
  keepMs: number,
): ListRepostRecords {
  return cursor => {
    const key = `${did}|${cursor ?? ''}`
    const now = Date.now()
    const hit = pageCache.get(key)
    if (hit && (hit.at === undefined || now - hit.at < keepMs)) {
      return hit.promise
    }
    prune(now)
    const entry: CacheEntry = {promise: read(cursor)}
    pageCache.set(key, entry)
    entry.promise.then(
      () => {
        if (pageCache.get(key) !== entry) return
        if (keepMs > 0) entry.at = Date.now()
        else pageCache.delete(key)
      },
      () => {
        if (pageCache.get(key) === entry) pageCache.delete(key)
      },
    )
    return entry.promise
  }
}

/*
 * Whether prism refused `refract.getAuthorReposts` this session. prism lists
 * no feature for it, so a refusal is the only sign it isn't served; the repo
 * read then stands in until the app restarts.
 */
let authorRepostsRefused = false

/** Whether `error` says prism doesn't serve the method at all. */
export function isMethodRefusal(error: unknown): boolean {
  if (!(error instanceof XrpcResponseError)) return false
  if (
    error.error === 'MethodNotImplemented' ||
    error.error === 'NotImplemented' ||
    error.error === 'XRPCNotSupported'
  ) {
    return true
  }
  return error.status === 404 || error.status === 501
}

/** Whether profiles read reposts from repos (prism refused the method). */
export function profileRepostsFromRepo(): boolean {
  return authorRepostsRefused
}

/** Test-only: forget kept pages and a refusal. */
export function resetProfileRepostCache() {
  pageCache.clear()
  authorRepostsRefused = false
}

/** One `refract.getAuthorReposts` page for `did`. */
async function prismRepostPage(
  did: string,
  cursor: string | undefined,
): Promise<RepostRecordPage> {
  const {body} = await refractCall<{feed?: unknown; cursor?: unknown}>(
    REFRACT_METHODS.getAuthorReposts,
    {actor: did, limit: PROFILE_REPOST_PRISM_LIMIT, cursor},
    {foreground: true},
  )
  return {
    records: [],
    items: Array.isArray(body.feed) ? (body.feed as FeedViewPost[]) : [],
    cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
  }
}

/**
 * The Posts or Replies tab of `did` with the owner's reposts of restored
 * posts, or `api` as it is for any other tab. Read from prism; after a
 * refusal, from the owner's repo: the reader's own with their PDS client, any
 * other owner's without a session.
 */
export function profileRepostsFeedApi(
  did: string,
  filter: string,
  api: FeedAPI,
  clientFor: RepoClientFor = ownerPdsClient,
): FeedAPI {
  if (!REPOST_FILTERS.has(filter)) return api
  if (!did.startsWith('did:')) return api
  const own = did === getCurrentDid()
  const ownPds = own ? getCurrentPdsClient() : undefined
  const fromRepo: ListRepostRecords = async cursor => {
    if (own && !ownPds) throw new Error('No PDS client for the reader')
    const client = ownPds ?? (await clientFor(did))
    const res = await client.call(com.atproto.repo.listRecords, {
      repo: did as AtIdentifierString,
      collection: REPOST_COLLECTION,
      limit: PROFILE_REPOST_RECORDS_LIMIT,
      cursor,
    })
    return {records: res.records, cursor: res.cursor}
  }
  const read: ListRepostRecords = async cursor => {
    if (!authorRepostsRefused) {
      try {
        return await prismRepostPage(did, cursor)
      } catch (error) {
        // A cursor is prism's, which the repo can't continue.
        if (!isMethodRefusal(error) || cursor !== undefined) throw error
        authorRepostsRefused = true
        logger.info(
          'refract: reposts read from repos, prism refused the method',
        )
      }
    }
    return fromRepo(cursor)
  }
  return new ProfileRepostsFeedAPI(
    api,
    did,
    sharedRepostPages(did, read, own ? 0 : PROFILE_REPOST_CACHE_MS),
  )
}
