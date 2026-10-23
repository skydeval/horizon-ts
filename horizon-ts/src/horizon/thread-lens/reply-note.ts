/*
 * The composer note's rule (Phase 4 design 8.5), apart from the component so
 * it loads without the UI: the most recently updated lens snapshot of the
 * query client holding the URI, walked up by `parentUri` to a
 * `blocking-you` gap, the result kept per snapshot object and URI.
 */

import {type QueryClient} from '@tanstack/react-query'

import {
  LENS_ROOT,
  lensKeyParams,
  type LensSnapshot,
  snapshotOf,
} from '#/horizon/thread-lens/snapshot'

const walks = new WeakMap<LensSnapshot, Map<string, boolean>>()

/** Tests: how many walks ran. */
let walkCount = 0
export function lensReplyNoteWalkCount(): number {
  return walkCount
}

/** Whether a `blocking-you` gap is above `uri` in `snapshot`. */
function blockedAbove(snapshot: LensSnapshot, uri: string): boolean {
  let byUri = walks.get(snapshot)
  if (!byUri) {
    byUri = new Map()
    walks.set(snapshot, byUri)
  }
  const held = byUri.get(uri)
  if (held !== undefined) return held
  walkCount++
  let result = false
  const seen = new Set<string>([uri])
  let parent = snapshot.nodes.get(uri)?.parentUri
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const node = snapshot.nodes.get(parent)
    if (!node) break
    if (node.kind === 'gap' && node.gap === 'blocking-you') {
      result = true
      break
    }
    parent = node.parentUri
  }
  byUri.set(uri, result)
  return result
}

/** The note's rule over `qc`'s lens entries, for `uri`. A plain read. */
export function lensReplyNoteHolds(qc: QueryClient, uri: string): boolean {
  let best: {snapshot: LensSnapshot; at: number} | undefined
  for (const query of qc.getQueryCache().findAll({queryKey: [LENS_ROOT]})) {
    if (!lensKeyParams(query.queryKey)) continue
    const snapshot = snapshotOf(query.state.data)
    if (!snapshot?.nodes.has(uri)) continue
    const at = query.state.dataUpdatedAt
    if (!best || at > best.at) best = {snapshot, at}
  }
  return best ? blockedAbove(best.snapshot, uri) : false
}
