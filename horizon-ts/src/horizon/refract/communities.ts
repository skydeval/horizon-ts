/*
 * Which authors a quote card asks about (skydeval, 2026-10-27): only those
 * whose PDS is a refracted community's, by prism's own host patterns
 * (`app.nearhorizon.refract.getCommunities`). Any other author's missing
 * quote is just "Deleted", with no call.
 *
 * The match is prism's: the PDS endpoint's host, lowercased, port dropped;
 * `*.x` matches a host ending in `.x` with a non-empty label in front (not
 * `x` itself), any other pattern the host exactly. The list is kept for an
 * hour; a failed fetch is tried again after five minutes.
 *
 * When Horizon can't tell (the list hasn't loaded or prism doesn't serve the
 * method, or the author's PDS doesn't resolve), the card asks `fill` as
 * before: `fill` stays the source of truth whenever the host could match.
 * The author's PDS comes from the cached DID-document lookup
 * (`authorPdsUrl`, 6 h), so an author who just moved onto a community is
 * missed until it refreshes; prism accepted that.
 */

import {authorPdsUrl} from '#/horizon/private/adapt/pds'
import {refractCall} from '#/horizon/refract/api'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'

const LIST_TTL_MS = 60 * 60_000
const RETRY_MS = 5 * 60_000

type ListState =
  | {kind: 'loaded'; patterns: string[]; at: number}
  | {kind: 'failed'; at: number}

let list: ListState | undefined
let inFlight: Promise<string[] | undefined> | undefined

/** The host of a PDS endpoint, lowercased, without its port. */
export function pdsHostOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname.toLowerCase() || undefined
  } catch {
    return undefined
  }
}

/** Whether `host` matches one of prism's community patterns. */
export function matchesCommunityHost(
  host: string,
  patterns: readonly string[],
): boolean {
  const name = host.toLowerCase()
  return patterns.some(raw => {
    const pattern = raw.toLowerCase()
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      return name.endsWith(suffix) && name.length > suffix.length
    }
    return name === pattern
  })
}

function readPatterns(body: unknown): string[] {
  const communities = (body as {communities?: unknown})?.communities
  if (!Array.isArray(communities)) return []
  const out: string[] = []
  for (const community of communities) {
    const patterns = (community as {pdsPatterns?: unknown})?.pdsPatterns
    if (!Array.isArray(patterns)) continue
    for (const pattern of patterns) {
      if (typeof pattern === 'string' && pattern) out.push(pattern)
    }
  }
  return out
}

/**
 * The community host patterns, or `undefined` when they aren't known
 * (not loaded, or the last fetch failed in the past five minutes).
 */
export function communityPatterns(): Promise<string[] | undefined> {
  const now = Date.now()
  if (list?.kind === 'loaded' && now - list.at < LIST_TTL_MS) {
    return Promise.resolve(list.patterns)
  }
  if (list?.kind === 'failed' && now - list.at < RETRY_MS) {
    return Promise.resolve(undefined)
  }
  if (inFlight) return inFlight
  inFlight = refractCall<unknown>(
    REFRACT_METHODS.getCommunities,
    {},
    {foreground: true},
  )
    .then(answer => {
      const patterns = readPatterns(answer.body)
      list = {kind: 'loaded', patterns, at: Date.now()}
      return patterns
    })
    .catch(() => {
      list = {kind: 'failed', at: Date.now()}
      return undefined
    })
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}

/**
 * Whether a quote card should ask `fill` about `did`'s post: yes when its
 * PDS matches a community, or when Horizon can't tell; no otherwise.
 */
export async function quoteNeedsFill(did: string): Promise<boolean> {
  const [patterns, pds] = await Promise.all([
    communityPatterns(),
    authorPdsUrl(did),
  ])
  if (!patterns || !pds) return true
  const host = pdsHostOf(pds)
  if (!host) return true
  return matchesCommunityHost(host, patterns)
}

/** Test-only: forget the list. */
export function resetCommunities() {
  list = undefined
  inFlight = undefined
}
