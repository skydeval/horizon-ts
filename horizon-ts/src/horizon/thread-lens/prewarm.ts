/*
 * The press-in pre-warm (speed pass, 2026-10-23): pressing a post in a feed
 * or a thread starts its lens `getThread` (and the anchor's public view)
 * before the navigation, so the thread screen's first read finds it in
 * flight. Cheap by construction:
 *
 * - only while the lens is active for the current account (switch, served,
 *   device value on), never for a private URI, never during the account's
 *   429 wait;
 * - one in flight per account, anchor and request body: a second press-in
 *   on the same post starts nothing;
 * - taken once, by the screen's read with the same body (`fetch.ts`), and
 *   dropped after {@link LENS_PREWARM_TTL_MS} when nothing takes it, so a
 *   press that never navigates leaves nothing behind but one request.
 *
 * The call is the ordinary `getLensThread`, so its outcome is reported, a
 * refusal recorded and a 429 wait set exactly as a screen's own read would.
 * A failed pre-warm is not reused: the screen asks again.
 */

import {type QueryClient, useQueryClient} from '@tanstack/react-query'

import {isPrivatePostUri} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {THREAD_LENS} from '#/horizon/switches'
import {
  getLensThread,
  isLensWaiting,
  type LensThreadAnswer,
  type LensThreadBody,
  lensThreadBody,
} from '#/horizon/thread-lens/api'
import {isLensServed} from '#/horizon/thread-lens/availability'
import {getThreadLensPreference} from '#/horizon/thread-lens/preference'
import {warmPublicViews} from '#/horizon/thread-lens/public-views'
import {getLensGapKind} from '#/horizon/thread-lens/registry'
import {markLensTap} from '#/horizon/thread-lens/timing'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** How long an untaken pre-warm is kept. */
export const LENS_PREWARM_TTL_MS = 10_000

type Warm = {
  promise: Promise<LensThreadAnswer>
  timer: ReturnType<typeof setTimeout>
}

const warms = new Map<string, Warm>()

function warmKey(did: string, body: LensThreadBody): string {
  return JSON.stringify([did, body])
}

/** Tests: drop every pre-warm and its timer. */
export function resetLensPrewarms() {
  for (const warm of warms.values()) clearTimeout(warm.timer)
  warms.clear()
}

/** Tests: how many pre-warms are held. */
export function heldLensPrewarmCount(): number {
  return warms.size
}

/**
 * The request depth the thread screen will ask with: tree view's 6 when the
 * account's thread preferences (the stock preferences query, read from the
 * cache) say tree view, else linear view's 10 (5.2).
 */
function screenDepth(qc: QueryClient): number {
  for (const [, data] of qc.getQueriesData({queryKey: ['getPreferences']})) {
    const prefs = (
      data as {threadViewPrefs?: {lab_treeViewEnabled?: boolean}} | undefined
    )?.threadViewPrefs
    if (prefs) return prefs.lab_treeViewEnabled ? 6 : 10
  }
  return 10
}

/**
 * Start the lens read of `post`'s thread, when the lens is active and none
 * is in flight for it. `post` is the AppView's view, so its URI has a DID
 * authority and its public view may be warmed too.
 */
export function prewarmLensThread(qc: QueryClient, post: PostView) {
  const uri = post.uri
  markLensTap(uri)
  if (!THREAD_LENS || isPrivatePostUri(uri) || !uri.startsWith('at://did:')) {
    return
  }
  const clients = getCurrentClients()
  const did = clients?.did
  if (!clients || !did) return
  if (!isLensServed(did) || !getThreadLensPreference(did)) return
  if (isLensWaiting(did)) return
  const body = lensThreadBody({
    kind: 'first',
    anchor: uri,
    depth: screenDepth(qc),
  })
  const key = warmKey(did, body)
  if (warms.has(key)) return
  const promise = getLensThread(clients.prismClient, did, body)
  // Held for the screen; a failure is the screen's to retry, never unhandled.
  promise.catch(() => {})
  const timer = setTimeout(() => {
    if (warms.get(key)?.promise === promise) warms.delete(key)
  }, LENS_PREWARM_TTL_MS)
  warms.set(key, {promise, timer})
  // The anchor's own public view, unless the anchor is lens-only (U-5).
  if (getLensGapKind(did, uri) === undefined && post.cid) {
    warmPublicViews(clients.appviewClient, did, [uri])
  }
}

/** The pre-warm for `did`'s read with `body`, taken once. */
export function takeWarmLensThread(
  did: string,
  body: LensThreadBody,
): Promise<LensThreadAnswer> | undefined {
  const key = warmKey(did, body)
  const warm = warms.get(key)
  if (!warm) return undefined
  warms.delete(key)
  clearTimeout(warm.timer)
  return warm.promise
}

/** The press-in handler for a post, for feed and thread items. */
export function useLensPrewarm(): (post: PostView) => void {
  const qc = useQueryClient()
  return post => prewarmLensThread(qc, post)
}
