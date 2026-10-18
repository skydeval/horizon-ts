/*
 * Paging prism's private lists. prism's `getAuthorFeed`, `getTimeline`,
 * `getReplies` and `getQuotes` read a bounded number of candidates per
 * request, so a page can come back short or empty and still carry a cursor
 * (prism reply-2, "Also changing (paging)"; P-17). Only an absent cursor ends
 * a list. Every private list and merge therefore keeps requesting while a
 * cursor comes back and the page has nothing to show, up to a cap per load,
 * so a long run of empty pages hands back to the list (which asks again when
 * it wants more) instead of looping.
 */

/**
 * How many pages one load requests at most while they come back empty.
 */
export const MAX_PAGES_PER_LOAD = 10

/**
 * Request pages from `cursor` until one has an item `keep` accepts, the
 * cursor is absent (the end), or {@link MAX_PAGES_PER_LOAD} pages were read.
 * A page that answers the cursor it was asked with is treated as the end, so
 * a server that repeats itself cannot loop.
 *
 * Returns the kept items of every page read, and the cursor to continue from
 * (`undefined` at the end).
 */
export async function fetchUntilItems<T>(
  fetchPage: (
    cursor: string | undefined,
  ) => Promise<{items: T[]; cursor?: string}>,
  cursor: string | undefined,
  {
    keep = () => true,
    maxPages = MAX_PAGES_PER_LOAD,
  }: {keep?: (item: T) => boolean; maxPages?: number} = {},
): Promise<{items: T[]; cursor: string | undefined; pages: number}> {
  const items: T[] = []
  let next = cursor
  let pages = 0
  while (pages < maxPages) {
    const asked = next
    const page = await fetchPage(asked)
    pages++
    items.push(...page.items.filter(keep))
    next = page.cursor && page.cursor !== asked ? page.cursor : undefined
    if (items.length > 0 || !next) break
  }
  return {items, cursor: next, pages}
}
