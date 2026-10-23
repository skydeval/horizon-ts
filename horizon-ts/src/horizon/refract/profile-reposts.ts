/*
 * A profile owner's reposts of restored posts, on that owner's profile
 * (refract client design 4.1, "Feed tabs"). Bluesky's `getAuthorFeed` drops
 * a repost whose subject it can't hydrate, so anyone's repost of a restored
 * post counts on the post but is missing from the reposter's Posts and
 * Replies tabs. prism has no read that gives it: `refract.getAuthorFeed`
 * serves restored actors only, and `refract.getTimeline` restored
 * originators only.
 *
 * - Only `author|<owner>|<filter>`, for the tabs stock shows reposts on, on
 *   any profile the reader views (their own or another account's) while
 *   Refract is active. A restored owner's tabs come from prism instead
 *   (`author-feed.ts`).
 * - Every stock page passes through as it is. Its time window runs from the
 *   previous page's oldest item (the top page: now) down to its own oldest
 *   item (the last page: the start). The owner's `app.bsky.feed.repost`
 *   records are read from the owner's repo (`listRecords`, newest first),
 *   kept on this API instance and read further as the feed pages, at most
 *   {@link PROFILE_REPOST_PAGES_PER_LOAD} record pages per feed page. The top
 *   page reads its first record page alongside stock. The reader's own repo
 *   is read with their PDS client; another owner's without a session, from
 *   the PDS their DID document names (repo records are public).
 * - Record pages are shared while a read runs and kept for
 *   {@link PROFILE_REPOST_CACHE_MS} (another owner's) so the Posts and
 *   Replies tabs, and a quick return to the profile, read the repo once. The
 *   reader's own pages are only shared in flight, so an unrepost shows on the
 *   next load.
 * - A record stock already shows (its `reason.uri`, or a repost item of its
 *   subject) is left alone. For the rest, a subject whose author may be
 *   restored is read from the restored-post store, else from one `fill`.
 *   Positive posts are inserted by time as stock repost items, `reason` a
 *   `reasonRepost` by the owner. Anything else stays dropped, as stock has
 *   it.
 * - A failure, or a repo read or `fill` slower than
 *   {@link PROFILE_REPOST_DEADLINE_MS}, leaves the page as stock sent it.
 * - An unrepost deletes the record, so the next load from the top no longer
 *   shows it.
 *
 * Quotes need nothing here: a quote is the owner's own post, which stock
 * keeps, and its restored embed is filled by the quote slot (4.4). Replies
 * under restored posts are the owner's own posts too.
 */

import {type AtIdentifierString} from '@atproto/syntax'

import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {createLexClient} from '#/lib/lexClient'
import {networkAwareFetch} from '#/state/session/network'
import {authorPdsUrl} from '#/horizon/private/adapt/pds'
import {askFill, isDefinitelyNotRestored} from '#/horizon/refract/fill'
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

/** Repost records read per page of the owner's repo. */
export const PROFILE_REPOST_RECORDS_LIMIT = 100

/** The most record pages one feed page reads. */
export const PROFILE_REPOST_PAGES_PER_LOAD = 3

/** How long a feed page waits on one repo read, or on the `fill`. */
export const PROFILE_REPOST_DEADLINE_MS = 3_000

/** How long another owner's record pages are kept. */
export const PROFILE_REPOST_CACHE_MS = 60_000

/** The most record pages kept at once. */
const CACHE_MAX = 100

/** One page of the owner's repost records, newest first. */
export type RepostRecordPage = {
  records: {uri: string; cid?: string; value: unknown}[]
  cursor?: string
}

/** Reads one page of the owner's repost records from `cursor`. */
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
      for (const raw of page.records) {
        const record = readRecord(raw)
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
      return !isDefinitelyNotRestored(author)
    })
    if (candidates.length === 0) return res

    const posts = await this.resolve(
      Array.from(new Set(candidates.map(record => record.subject))),
    )
    if (posts.size === 0) return res

    const by = this.byProfile(res.feed)
    const feed = [...res.feed]
    const shown = new Set<string>()
    for (const record of candidates) {
      const post = posts.get(record.subject)
      if (!post || shown.has(record.subject)) continue
      shown.add(record.subject)
      this.stockSubjects.add(record.subject)
      const item: FeedViewPost = {
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

/** Test-only: forget kept record pages. */
export function resetProfileRepostCache() {
  pageCache.clear()
}

/**
 * The Posts or Replies tab of `did` with the owner's reposts of restored
 * posts, or `api` as it is for any other tab. The reader's own repo is read
 * with their PDS client, any other owner's without a session.
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
  if (own && !ownPds) return api
  const read: ListRepostRecords = async cursor => {
    const client = ownPds ?? (await clientFor(did))
    const res = await client.call(com.atproto.repo.listRecords, {
      repo: did as AtIdentifierString,
      collection: REPOST_COLLECTION,
      limit: PROFILE_REPOST_RECORDS_LIMIT,
      cursor,
    })
    return {records: res.records, cursor: res.cursor}
  }
  return new ProfileRepostsFeedAPI(
    api,
    did,
    sharedRepostPages(did, read, own ? 0 : PROFILE_REPOST_CACHE_MS),
  )
}
