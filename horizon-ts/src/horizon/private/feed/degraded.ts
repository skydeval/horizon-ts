/*
 * Degraded feed pages (prism busy design 6.4, 6.5). A merge marks the page it
 * returns `privateDegraded` when its private side could not be read in full:
 * a refill failed or was skipped, an answer left out one of the reader's own
 * posts (`unavailable[]`, or a suspect of the likes merge), or an answer
 * carried `degraded: true`. The flag lives on the raw page; the tuners never
 * see it.
 *
 * A degraded page's own misses go with it as `privateAnswer` (plain JSON, so
 * a persisted page stays serialisable), for the carry of the reader's own
 * posts (`carry.ts`) to judge against.
 */

import {type AnswerContext, mergeAnswers} from '#/horizon/private/api/reads'

/** What a degraded page's merged answer said, for the carry (`carry.ts`). */
export type PrivateAnswerNote = {
  did: string
  seq: number
  /** The reader's own URIs prism listed as missed for now. */
  unavailable: string[]
}

/** The fields a merge's response and its page carry. */
export type PrivateDegradedFlags = {
  privateDegraded?: true
  privateAnswer?: PrivateAnswerNote
}

/**
 * The flags of a page whose private side made `answers`, and whose refill
 * failed or was skipped when `incomplete` (or whose answer left out a
 * suspect). Nothing when the page read clean.
 */
export function degradedFlags(
  answers: readonly AnswerContext[],
  incomplete: boolean,
): PrivateDegradedFlags {
  const merged = answers.length > 0 ? mergeAnswers(answers) : undefined
  const degraded =
    incomplete ||
    !!merged?.degraded ||
    (merged?.unavailable.length ?? 0) > 0
  if (!degraded) return {}
  return {
    privateDegraded: true,
    ...(merged && merged.did
      ? {
          privateAnswer: {
            did: merged.did,
            seq: merged.seq,
            unavailable: merged.unavailable.map(item => item.uri),
          },
        }
      : {}),
  }
}

/** Whether a page is marked degraded. */
export function isPageDegraded(page: unknown): boolean {
  return (
    typeof page === 'object' &&
    page !== null &&
    (page as {privateDegraded?: unknown}).privateDegraded === true
  )
}

/** Whether any of `pages` is degraded: `staleTime` is then 0 (6.4, 6.7). */
export function anyPageDegraded(pages: readonly unknown[] | undefined): boolean {
  return !!pages?.some(isPageDegraded)
}

/**
 * The topmost page, by position, with no `since` (the first page or a gap
 * fill; never a prepend), degraded (6.5 and item 7's section 9). A degraded
 * page that `fetchNextPage` put below a clean one never counts. Read by
 * position, not by the `fetchedAt` order the tuners use.
 */
export function isTopPageDegraded(
  pages: readonly {since?: string}[] | undefined,
): boolean {
  const top = pages?.find(page => page.since === undefined)
  return !!top && isPageDegraded(top)
}

/**
 * A list query's `staleTime`: 0 while any page is degraded (6.4, 6.7), else
 * `ms`.
 */
export function degradedStaleTime(ms: number) {
  return (query: {state: {data?: {pages?: readonly unknown[]}}}): number =>
    anyPageDegraded(query.state.data?.pages) ? 0 : ms
}

/** The flags of `res`, a merge's response, for its page. */
export function pageFlagsOf(res: unknown): PrivateDegradedFlags {
  if (!isPageDegraded(res)) return {}
  const answer = (res as {privateAnswer?: PrivateAnswerNote}).privateAnswer
  return {privateDegraded: true, ...(answer ? {privateAnswer: answer} : {})}
}
