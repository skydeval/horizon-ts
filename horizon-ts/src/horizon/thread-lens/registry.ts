/*
 * The gap registry (Phase 4 design 8.4, TL-25): per DID, every URI the lens
 * has drawn as a gap in this run, with its latest kind. It decides lens-only
 * anchors (5.1) and words the gap-only answer (11.3); nothing else reads it.
 *
 * Append-only for the run (a URI resolved into a post later stays), in
 * memory, never persisted, and cleared for an account only when it signs
 * out (`clearLensRegistry`, called from `horizonSignOut`). It outlives cache
 * entries on purpose: a gap screen whose source screen's entry was
 * collected must still not read the stock thread.
 *
 * Registration is by what is drawn (7.2 step 5), always for the DID of the
 * key the call was made for. A private URI in it (a `tier-hidden` gap) never
 * makes an anchor lens-only; that test is the reader's (5.1).
 *
 * Render-time readers subscribe (TL-34): `subscribeLensRegistry` with a
 * version counter, or `useLensGapRegistered`.
 */

import {useSyncExternalStore} from 'react'

const registries = new Map<string, Map<string, string>>()
const listeners = new Set<() => void>()
let version = 0

function notify() {
  version++
  listeners.forEach(listener => listener())
}

/** Add `entries` (URI, kind) to `did`'s registry, latest kind kept. */
export function registerLensGaps(
  did: string,
  entries: Iterable<readonly [uri: string, kind: string]>,
) {
  let registry = registries.get(did)
  let changed = false
  for (const [uri, kind] of entries) {
    if (!registry) {
      registry = new Map()
      registries.set(did, registry)
    }
    if (registry.get(uri) === kind) continue
    registry.set(uri, kind)
    changed = true
  }
  if (changed) notify()
}

/** The kind `did`'s registry holds for `uri`, if any. A plain read. */
export function getLensGapKind(
  did: string | undefined,
  uri: string | undefined,
): string | undefined {
  if (!did || !uri) return undefined
  return registries.get(did)?.get(uri)
}

/** Whether `did`'s registry holds `uri`. A plain read, for non-render code. */
export function hasLensGap(
  did: string | undefined,
  uri: string | undefined,
): boolean {
  return getLensGapKind(did, uri) !== undefined
}

/** Called on every addition. Returns the unsubscribe function. */
export function subscribeLensRegistry(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A number that changes on every addition, for a `getSnapshot`. */
export function lensRegistryVersion(): number {
  return version
}

/**
 * Whether `did`'s registry holds `uri`, re-rendering when it is added. Runs
 * the store read on every render, whatever the caller does with it (5.1's
 * hook order).
 */
export function useLensGapRegistered(
  did: string | undefined,
  uri: string | undefined,
): boolean {
  return useSyncExternalStore(subscribeLensRegistry, () => hasLensGap(did, uri))
}

/** Clear the registries of signed-out accounts (12.1). */
export function clearLensRegistry(dids: Iterable<string>) {
  let changed = false
  for (const did of dids) changed = registries.delete(did) || changed
  if (changed) notify()
}

/** Tests: every registry gone. */
export function resetLensRegistry() {
  registries.clear()
  notify()
}
