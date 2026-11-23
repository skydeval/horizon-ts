/*
 * Following's first kryphocron page, fetched ahead (no felt lag). The merge
 * (`timeline-merge.ts`) waits for prism's first private page before Following
 * shows anything, so that read starts as soon as the app knows the account is
 * a member (`PrivatePrefetch`), at start and on coming back to the front,
 * instead of when Following asks.
 *
 * - **Fresh only.** A prefetched page is used for at most
 *   `PRIVATE_PREFETCH_TTL_MS` after it was asked, so what shows is what prism
 *   served moments ago, never an old copy.
 * - **Once.** The first fetch from the top takes it; a later one (a refresh)
 *   reads afresh.
 * - **In memory only**, for one account at a time; a failure is not kept.
 *
 * React-free (the Solid UI imports `timeline-merge.ts`).
 */

import {type PrivateSource} from '#/horizon/private/adapt/feed-view'
import {getPrivateTimelineAnswered} from '#/horizon/private/api/reads'
import {fetchUntilItems} from '#/horizon/private/feed/paging'

/** How long a prefetched first page may be used after it was asked. */
export const PRIVATE_PREFETCH_TTL_MS = 10_000

/** The size of a private timeline page (`timeline-merge.ts`'s, kept equal). */
const PAGE_LIMIT = 30

type Answered = Awaited<ReturnType<typeof getPrivateTimelineAnswered>>

/** A first private page as the merge reads it, with prism's answers. */
export type PrivateFirstPage = {
  items: Answered['body']['feed']
  cursor: string | undefined
  answers: Answered['answer'][]
}

/** Read the first private page from `cursor` (none: the top). */
export async function readPrivatePage(
  prism: PrivateSource['prism'],
  cursor: string | undefined,
): Promise<PrivateFirstPage> {
  const answers: Answered['answer'][] = []
  const page = await fetchUntilItems(async pageCursor => {
    const {body, answer} = await getPrivateTimelineAnswered(prism, {
      limit: PAGE_LIMIT,
      cursor: pageCursor,
    })
    answers.push(answer)
    return {items: body.feed, cursor: body.cursor}
  }, cursor)
  return {items: page.items, cursor: page.cursor, answers}
}

let slot:
  {did: string; askedAt: number; promise: Promise<PrivateFirstPage>} | undefined

/**
 * Start reading the member's first private page, unless a fresh one is
 * already held or in flight. Never throws.
 */
export function prefetchPrivateTop(
  source: PrivateSource,
  now: number = Date.now(),
) {
  if (
    slot &&
    slot.did === source.did &&
    now - slot.askedAt < PRIVATE_PREFETCH_TTL_MS
  ) {
    return
  }
  const entry = {
    did: source.did,
    askedAt: now,
    promise: readPrivatePage(source.prism, undefined),
  }
  entry.promise.catch(() => {
    if (slot === entry) slot = undefined
  })
  slot = entry
}

/**
 * The prefetched first page for `did`, if one is fresh: taken, so only one
 * fetch from the top uses it.
 */
export function takePrefetchedPrivateTop(
  did: string,
  now: number = Date.now(),
): Promise<PrivateFirstPage> | undefined {
  const held = slot
  if (!held || held.did !== did) return undefined
  slot = undefined
  if (now - held.askedAt >= PRIVATE_PREFETCH_TTL_MS) return undefined
  return held.promise
}

/** Forget any prefetched page (sign-out, account switch, tests). */
export function resetPrivatePrefetch() {
  slot = undefined
}
