/*
 * A restored account's profile feed tabs (refract client design 4.1, "Feed
 * tabs"). `refractAuthorFeedApi` wraps the stock author feed beside
 * `horizonFeedApi`, for a DID noted restored while Refract is active:
 *
 * - each page asks stock `getAuthorFeed` and `refract.getAuthorFeed` (the
 *   stock filter, cursor, limit and `includePins`) in parallel; stock wins if
 *   it succeeds, else the refract page is used. The cursor records which side
 *   it came from, so later pages stay on that side.
 * - `AccountTakedown` or `AccountDeactivated` from prism means the restore
 *   ended: its caches are dropped, the tab shows stock's error and the
 *   profile is refetched.
 * - `NotFound` or `InvalidRequest` isn't enough on its own: one foreground
 *   `fill` decides (5.2). A returned profile keeps the restore; `pending` or
 *   `unavailable` joins the DID's schedule while the tab is mounted, and the
 *   next positive answer refetches the tab; only a definitive omission (two
 *   in a row) ends the restore. The tab shows stock's error with Retry, never
 *   the takedown text from this alone.
 */

import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {
  classifyRefractError,
  refractCall,
  RefractClearedError,
} from '#/horizon/refract/api'
import {
  askFill,
  refractRestoreEnded,
  waitOnSchedule,
} from '#/horizon/refract/fill'
import {refractActive} from '#/horizon/refract/gate'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {isNotedRestored} from '#/horizon/refract/marker'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type FeedViewPost = app.bsky.feed.defs.FeedViewPost

/** A cursor that came from prism's side. */
const REFRACT_CURSOR = 'refract:'

type AuthorFeedBody = {feed: FeedViewPost[]; cursor?: string}

function feedKeyMatches(did: string) {
  return (query: {queryKey: readonly unknown[]}) =>
    query.queryKey[0] === 'post-feed' &&
    typeof query.queryKey[1] === 'string' &&
    query.queryKey[1].startsWith(`author|${did}|`)
}

function refetchTabs(did: string) {
  void getCurrentClients()?.queryClient?.invalidateQueries({
    predicate: feedKeyMatches(did),
  })
}

function tabsMounted(did: string): () => boolean {
  return () =>
    !!getCurrentClients()
      ?.queryClient?.getQueryCache()
      .findAll({predicate: feedKeyMatches(did)})
      .some(query => query.getObserversCount() > 0)
}

/**
 * Decide what a refract `NotFound` or `InvalidRequest` means for the tab
 * (4.1). Never throws.
 */
async function judgeNotServed(did: string) {
  try {
    const outcome = await askFill(
      {dids: [did]},
      {
        kind: 'tab',
        foreground: true,
        skipPrecheck: true,
        live: tabsMounted(did),
      },
    )
    const verdict = outcome.dids.get(did)
    if (verdict?.kind === 'pending' || verdict?.kind === 'unavailable') {
      void waitOnSchedule(did, {
        kind: 'tab',
        hold: false,
        live: tabsMounted(did),
        late: {
          live: tabsMounted(did),
          onAnswer: next => {
            if (next.kind === 'positive') refetchTabs(did)
          },
        },
      }).catch(() => {})
    }
  } catch {
    // A failed fill keeps the profile and gives the tab Retry.
  }
}

class RefractAuthorFeedAPI implements FeedAPI {
  constructor(
    private readonly stock: FeedAPI,
    private readonly did: string,
    private readonly filter: string,
  ) {}

  private refractPage(
    cursor: string | undefined,
    limit: number,
  ): Promise<FeedAPIResponse> {
    return refractCall<AuthorFeedBody>(
      REFRACT_METHODS.getAuthorFeed,
      {
        actor: this.did,
        filter: this.filter || undefined,
        cursor,
        limit: Math.min(100, Math.max(1, limit)),
        includePins: this.filter === 'posts_and_author_threads',
      },
      {foreground: true},
    ).then(({body}) => ({
      feed: Array.isArray(body.feed) ? body.feed : [],
      cursor: body.cursor ? `${REFRACT_CURSOR}${body.cursor}` : undefined,
    }))
  }

  private async onRefractError(error: unknown) {
    const kind = classifyRefractError(error)
    if (kind === 'restore-ended') {
      try {
        refractRestoreEnded(this.did)
      } catch (cleared) {
        if (!(cleared instanceof RefractClearedError)) throw cleared
      }
    } else if (kind === 'not-found' || kind === 'invalid') {
      await judgeNotServed(this.did)
    }
  }

  async fetch({
    cursor,
    limit,
    signal,
  }: {
    cursor: string | undefined
    limit: number
    signal?: AbortSignal
  }): Promise<FeedAPIResponse> {
    if (cursor?.startsWith(REFRACT_CURSOR)) {
      try {
        return await this.refractPage(
          cursor.slice(REFRACT_CURSOR.length),
          limit,
        )
      } catch (error) {
        await this.onRefractError(error)
        throw error
      }
    }
    if (cursor !== undefined) return this.stock.fetch({cursor, limit, signal})
    const refract = this.refractPage(undefined, limit).then(
      page => ({page}),
      (error: unknown) => ({error}),
    )
    try {
      return await this.stock.fetch({cursor, limit, signal})
    } catch (stockError) {
      const result = await refract
      if ('page' in result) return result.page
      await this.onRefractError(result.error)
      throw stockError
    }
  }

  async peekLatest(): Promise<FeedViewPost> {
    try {
      return await this.stock.peekLatest()
    } catch (error) {
      const page = await this.refractPage(undefined, 1).catch(() => undefined)
      if (page?.feed[0]) return page.feed[0]
      throw error
    }
  }
}

/**
 * The stock author feed, or the same with prism's restored pages for a DID
 * noted restored (4.1). Any other feed is returned as it is.
 */
export function refractAuthorFeedApi(feedDesc: string, api: FeedAPI): FeedAPI {
  if (!feedDesc.startsWith('author|')) return api
  if (!refractActive()) return api
  const [, did, filter] = feedDesc.split('|')
  if (!did || !isNotedRestored(did)) return api
  return new RefractAuthorFeedAPI(api, did, filter ?? '')
}
