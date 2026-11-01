/*
 * Each account's query client, kept while the app runs.
 *
 * Switching accounts remounts the whole app under a new `QueryProvider`.
 * Building a fresh client each time left the app empty (feed, avatar,
 * notifications) until every query had loaded again, as on a cold start.
 * Keeping the client per DID lets a switch back show what that account last
 * saw at once, while the queries refresh as they would on any return.
 *
 * A client only ever holds one DID's data. Its queries are collected after
 * the usual idle time, as in-session ones are, so nothing outlives what a
 * screen left open would have held. Signing an account out, or removing it,
 * drops its client with its persisted cache.
 */

/**
 * The most accounts whose clients are kept at once; the least recently used
 * goes first.
 */
export const MAX_LIVE_QUERY_CLIENTS = 5

const LOGGED_OUT = 'logged-out'

const live = new Map<string, unknown>()

/**
 * The live client for `did` (signed out when undefined), made by `create` if
 * there is none, and marked as the most recently used.
 */
export function takeLiveQueryClient<T>(
  did: string | undefined,
  create: () => T,
): T {
  const key = did ?? LOGGED_OUT
  const kept = live.get(key) as T | undefined
  const entry = kept ?? create()
  live.delete(key)
  live.set(key, entry)
  while (live.size > MAX_LIVE_QUERY_CLIENTS) {
    const oldest = live.keys().next().value
    if (oldest === undefined) break
    live.delete(oldest)
  }
  return entry
}

/**
 * Drop `id`'s live client (a DID, or the signed-out id), so the next mount
 * starts empty.
 */
export function forgetLiveQueryClient(id: string) {
  live.delete(id)
}

/**
 * Drop every live client (tests).
 */
export function resetLiveQueryClients() {
  live.clear()
}
