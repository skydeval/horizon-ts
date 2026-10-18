/*
 * The private search query (2H design 11.3, P-7): what of a search prism's
 * `searchPosts` can answer. prism matches words (each contained in the
 * decoded text, case-folded) and one `from:<did>`; everything else a search
 * can say is left out, and the list notes it (H-7, P-26).
 *
 * Pure: the author's handle, when one is given, is resolved by the caller.
 */

import {tokenizeQuery} from '#/state/queries/search-posts-params'
import {type SearchFilters} from '#/screens/Search/searchParams'

/**
 * The author a private search keeps: a DID, or a handle to resolve.
 */
export type PrivateSearchAuthor = {did: string} | {handle: string}

export type PrivateSearchTerms = {
  /** The words prism matches, in order. */
  words: string[]
  author: PrivateSearchAuthor | undefined
  /** Something the search said was left out (a filter or operator). */
  ignoredSomething: boolean
}

function authorOf(
  value: string,
  viewerDid: string | undefined,
): PrivateSearchAuthor | undefined {
  const bare = value.startsWith('@') ? value.slice(1) : value
  if (!bare) return undefined
  if (bare === 'me') return viewerDid ? {did: viewerDid} : undefined
  if (bare.startsWith('did:')) return {did: bare}
  return {handle: bare.toLowerCase()}
}

/**
 * The private terms of a search: its plain words, the words of a quoted
 * phrase (prism matches words, not phrases), `#tags` as words (a substring
 * of the text), and one author from `from:`, `fromMe`, `filters.from` or
 * `filters.author`. Any other operator, a negated word, a parenthesised
 * group, a second author and any other filter are left out with
 * `ignoredSomething`.
 */
export function buildPrivateSearchQuery({
  query,
  filters = {},
  fromMe = false,
  viewerDid,
}: {
  query: string
  filters?: SearchFilters
  fromMe?: boolean
  viewerDid: string | undefined
}): PrivateSearchTerms {
  const words: string[] = []
  let author: PrivateSearchAuthor | undefined
  let ignoredSomething = false
  const addAuthor = (next: PrivateSearchAuthor | undefined) => {
    if (!next) {
      ignoredSomething = true
    } else if (!author) {
      author = next
    } else if (JSON.stringify(author) !== JSON.stringify(next)) {
      ignoredSomething = true
    }
  }

  for (const token of tokenizeQuery(query)) {
    if (token.startsWith('(') || token.startsWith('-')) {
      ignoredSomething = true
      continue
    }
    if (token.includes('"')) {
      words.push(
        ...token
          .replaceAll('"', ' ')
          .split(/\s+/)
          .filter(word => word.length > 0),
      )
      continue
    }
    if (token.startsWith('#')) {
      if (token.length > 1) words.push(token)
      continue
    }
    const colon = token.indexOf(':')
    if (colon === -1) {
      words.push(token)
      continue
    }
    const op = token.slice(0, colon)
    const value = token.slice(colon + 1)
    if (op === 'from' && value) {
      addAuthor(authorOf(value, viewerDid))
    } else {
      ignoredSomething = true
    }
  }

  if (fromMe || filters.from === 'me') addAuthor(authorOf('me', viewerDid))
  if (filters.author) addAuthor(authorOf(filters.author, viewerDid))
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'from' || key === 'author') continue
    if (typeof value === 'string' && value) ignoredSomething = true
  }

  return {words, author, ignoredSomething}
}

/**
 * prism's `q` for the terms with the author resolved to `authorDid`, or
 * `undefined` when there is nothing to search (no word and no author).
 */
export function privateSearchQ(
  terms: PrivateSearchTerms,
  authorDid: string | undefined,
): string | undefined {
  const parts = [...terms.words]
  if (authorDid) parts.push(`from:${authorDid}`)
  return parts.length > 0 ? parts.join(' ') : undefined
}
