/*
 * The threadgate writer in lens mode (Phase 4 design 7.1, TH-16). Kept apart
 * from `query.ts` so the stock threadgate updater (`usePostThread/
 * queryCache.ts`) imports only this, the post shadow and the snapshot
 * helpers: `query.ts` imports `queryCache.ts` back, and a light module keeps
 * that cycle out of the stock file's load (risk 3 of the 4A log).
 */

import {type QueryClient, type QueryKey} from '@tanstack/react-query'

import {
  dangerousGetPostShadow,
  updatePostShadow,
} from '#/state/cache/post-shadow'
import {THREAD_LENS} from '#/horizon/switches'
import {heldSnapshotOf} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'

/**
 * On a snapshot, replace the anchor's held view once by `{...view,
 * threadgate}`, a new object, and carry the old object's shadow to it (v5:
 * R3-N3); returns `true`, so the stock `setQueryData` does not run.
 * Otherwise `false`.
 */
export function writeLensThreadgate(
  qc: QueryClient,
  key: QueryKey,
  threadgate: app.bsky.feed.defs.ThreadgateView,
): boolean {
  if (!THREAD_LENS) return false
  const snapshot = heldSnapshotOf(qc.getQueryData(key))
  if (!snapshot) return false
  const anchor = snapshot.nodes.get(snapshot.anchor.prismAnchor)
  if (!anchor || anchor.kind === 'gap') return true
  const old = anchor.view
  const nodes = new Map(snapshot.nodes)
  nodes.set(anchor.uri, {...anchor, view: {...old, threadgate}})
  qc.setQueryData(key, {lens: {...snapshot, nodes}})
  updatePostShadow(qc, old.uri, dangerousGetPostShadow(old) ?? {})
  return true
}
