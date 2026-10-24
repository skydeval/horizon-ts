/*
 * The composer note's rule (Phase 4 design 8.5), apart from the component so
 * it loads without the UI: the lens snapshots of the query client holding
 * the URI, most recently updated first, walked up by `parentUri` to a
 * `blocking-you` gap. Each snapshot's walk is kept per snapshot object and
 * URI.
 *
 * The most recent snapshot decides wherever it can: it reaches a
 * `blocking-you` gap (the note), or the top of its chain with every parent
 * held (no note), so a refetch after an unblock clears the note. Only where
 * its chain is cut (a parent it does not hold: a screen anchored lower down
 * whose parents were not all read, or one opened from a post prism had not
 * linked yet) does the walk go on from that parent in the next most recent
 * snapshot holding it, as the thread the reader came from usually does.
 */

import {type QueryClient} from '@tanstack/react-query'

import {
  LENS_ROOT,
  lensKeyParams,
  type LensSnapshot,
  snapshotOf,
} from '#/horizon/thread-lens/snapshot'

/**
 * One snapshot's walk from a URI: a `blocking-you` gap above it, the top of
 * the chain with nothing above it, or the first parent the snapshot lacks.
 */
type Walk = {kind: 'gap'} | {kind: 'top'} | {kind: 'cut'; parentUri: string}

const walks = new WeakMap<LensSnapshot, Map<string, Walk>>()

/** Tests: how many walks ran. */
let walkCount = 0
export function lensReplyNoteWalkCount(): number {
  return walkCount
}

/** The walk up from `uri` in `snapshot`, which holds `uri`. */
function walkUp(snapshot: LensSnapshot, uri: string): Walk {
  let byUri = walks.get(snapshot)
  if (!byUri) {
    byUri = new Map()
    walks.set(snapshot, byUri)
  }
  const held = byUri.get(uri)
  if (held) return held
  walkCount++
  let result: Walk = {kind: 'top'}
  const seen = new Set<string>([uri])
  let parent = snapshot.nodes.get(uri)?.parentUri
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const node = snapshot.nodes.get(parent)
    if (!node) {
      result = {kind: 'cut', parentUri: parent}
      break
    }
    if (node.kind === 'gap' && node.gap === 'blocking-you') {
      result = {kind: 'gap'}
      break
    }
    parent = node.parentUri
  }
  byUri.set(uri, result)
  return result
}

/** `qc`'s lens snapshots, most recently updated first. */
function lensSnapshots(qc: QueryClient): LensSnapshot[] {
  const found: {snapshot: LensSnapshot; at: number}[] = []
  for (const query of qc.getQueryCache().findAll({queryKey: [LENS_ROOT]})) {
    if (!lensKeyParams(query.queryKey)) continue
    const snapshot = snapshotOf(query.state.data)
    if (snapshot) found.push({snapshot, at: query.state.dataUpdatedAt})
  }
  return found.sort((a, b) => b.at - a.at).map(entry => entry.snapshot)
}

/** The note's rule over `qc`'s lens entries, for `uri`. A plain read. */
export function lensReplyNoteHolds(qc: QueryClient, uri: string): boolean {
  const snapshots = lensSnapshots(qc)
  let from = uri
  const visited = new Set<string>()
  while (!visited.has(from)) {
    visited.add(from)
    const snapshot = snapshots.find(s => s.nodes.has(from))
    if (!snapshot) return false
    // Past a cut, the parent itself is the first node above the reply.
    const node = from === uri ? undefined : snapshot.nodes.get(from)
    if (node?.kind === 'gap' && node.gap === 'blocking-you') return true
    const walk = walkUp(snapshot, from)
    if (walk.kind !== 'cut') return walk.kind === 'gap'
    from = walk.parentUri
  }
  return false
}
