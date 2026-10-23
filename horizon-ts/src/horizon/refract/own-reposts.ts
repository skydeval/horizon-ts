/*
 * The reader's own reposts of restored posts, on the reader's own profile
 * (refract client design 4.1, "Feed tabs"). Bluesky's `getAuthorFeed` drops
 * a repost whose subject it can't hydrate, so a member's repost of a
 * restored post counts on the post but is missing from their Posts and
 * Replies tabs. prism has no read that gives it: `refract.getAuthorFeed`
 * serves restored actors only, and `refract.getTimeline` restored
 * originators only.
 *
 * - Only `author|<reader>|<filter>`, for the tabs stock shows reposts on.
 * - Every stock page passes through as it is. Its time window runs from the
 *   previous page's oldest item (the top page: now) down to its own oldest
 *   item (the last page: the start). The reader's `app.bsky.feed.repost`
 *   records are read from their own repo (`listRecords`, newest first), kept
 *   on this API instance and read further as the feed pages, at most
 *   {@link OWN_REPOST_PAGES_PER_LOAD} record pages per feed page. The top
 *   page reads its first record page alongside stock.
 * - A record stock already shows (its `reason.uri`, or a repost item of its
 *   subject) is left alone. For the rest, a subject whose author may be
 *   restored is read from the restored-post store, else from one `fill`.
 *   Positive posts are inserted by time as stock repost items, `reason` a
 *   `reasonRepost` by the reader. Anything else stays dropped, as stock has
 *   it.
 * - A failure, or a `fill` slower than {@link OWN_REPOST_DEADLINE_MS}, leaves
 *   the page as stock sent it.
 * - An unrepost deletes the record, so the next load from the top no longer
 *   shows it.
 *
 * Quotes need nothing here: a quote is the reader's own post, which stock
 * keeps, and its restored embed is filled by the quote slot (4.4). Own
 * replies under restored posts are the reader's own posts too.
 */

import {type AtIdentifierString} from '@atproto/syntax'

import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {askFill, isDefinitelyNotRestored} from '#/horizon/refract/fill'
import {peekRestoredPost} from '#/horizon/refract/store'
import {
  getCurrentClients,
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

/** Repost records read per page of the reader's repo. */
export const OWN_REPOST_RECORDS_LIMIT = 100

/** The most record pages one feed page reads. */
export const OWN_REPOST_PAGES_PER_LOAD = 3

/** How long a feed page waits on the `fill` for its reposted posts. */
export const OWN_REPOST_DEADLINE_MS = 3_000

/** One page of the reader's repost records, newest first. */
export type RepostRecordPage = {
  records: {uri: string; cid?: string; value: unknown}[]
  cursor?: string
}

/** Reads one page of the reader's repost records from `cursor`. */
export type ListRepostRecords = (
  cursor: string | undefined,
) => Promise<RepostRecordPage>

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
 * The reader's own author feed with their reposts of restored posts put
 * back in.
 */
export class OwnRepostsFeedAPI implements FeedAPI {
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
      const page = await this.list(asked)
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
      pages < OWN_REPOST_PAGES_PER_LOAD
    ) {
      await this.readPage()
      pages++
    }
  }

  private byProfile(feed: FeedViewPost[]): ProfileViewBasic {
    const cached = getCurrentClients()?.queryClient?.getQueryData<
      Record<string, unknown>
    >(['profile', this.did])
    if (cached?.did === this.did) return basicOf(cached)
    const own = feed.find(item => item.post.author.did === this.did)
    if (own) return own.post.author
    const clients = getCurrentClients()
    return basicOf({did: this.did, handle: clients?.handle ?? this.did})
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
        OWN_REPOST_DEADLINE_MS,
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
 * The reader's own Posts or Replies tab with their reposts of restored
 * posts, or `api` as it is for any other tab or without a PDS client.
 */
export function ownRepostsFeedApi(
  did: string,
  filter: string,
  api: FeedAPI,
): FeedAPI {
  if (!REPOST_FILTERS.has(filter)) return api
  const pds = getCurrentPdsClient()
  if (!pds) return api
  return new OwnRepostsFeedAPI(api, did, async cursor => {
    const res = await pds.call(com.atproto.repo.listRecords, {
      repo: did as AtIdentifierString,
      collection: REPOST_COLLECTION,
      limit: OWN_REPOST_RECORDS_LIMIT,
      cursor,
    })
    return {records: res.records, cursor: res.cursor}
  })
}
