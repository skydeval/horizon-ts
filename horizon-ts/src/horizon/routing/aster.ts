/*
 * The aster grant, per account, from prism's `getMembership` answer: the
 * `permissions.aster` flag and the top-level `aster.labels`. Held in memory
 * for this run only, never written to the device record. An answer without
 * both clears it, as does prism refusing an aster call.
 */

import {useSyncExternalStore} from 'react'

/** The three labels prism sends with the grant, by what they label. */
export type AsterLabels = {
  /** The placeholder's action. */
  action: string
  /** The action that puts the placeholder back. */
  undo: string
  /** The line above an aster node. */
  marker: string
}

const grants = new Map<string, AsterLabels>()
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach(listener => listener())
}

function labelsOf(value: unknown): AsterLabels | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const labels = (value as {labels?: unknown}).labels
  if (typeof labels !== 'object' || labels === null) return undefined
  const {action, undo, marker} = labels as Record<string, unknown>
  const ok = (text: unknown): text is string =>
    typeof text === 'string' && text.trim().length > 0 && text.length <= 64
  return ok(action) && ok(undo) && ok(marker)
    ? {action, undo, marker}
    : undefined
}

/**
 * Record `did`'s grant from one `getMembership` answer: held only when
 * `permissions.aster` is exactly `true` and all three labels are present.
 */
export function answerAster(
  did: string,
  permissions: unknown,
  aster: unknown,
): void {
  const flag =
    typeof permissions === 'object' &&
    permissions !== null &&
    (permissions as {aster?: unknown}).aster === true
  const labels = flag ? labelsOf(aster) : undefined
  const held = grants.get(did)
  if (labels) {
    if (
      held?.action === labels.action &&
      held.undo === labels.undo &&
      held.marker === labels.marker
    ) {
      return
    }
    grants.set(did, labels)
    notify()
  } else if (held) {
    grants.delete(did)
    notify()
  }
}

/** Forget `did`'s grant, for a refused aster call. */
export function clearAster(did: string): void {
  if (grants.delete(did)) notify()
}

/** `did`'s labels when it holds the grant in this run. */
export function getAsterLabels(
  did: string | undefined,
): AsterLabels | undefined {
  return did ? grants.get(did) : undefined
}

export function subscribeAster(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** {@link getAsterLabels}, re-rendering on change. */
export function useAsterLabels(
  did: string | undefined,
): AsterLabels | undefined {
  return useSyncExternalStore(subscribeAster, () => getAsterLabels(did))
}

/** Tests: forget every grant. */
export function resetAster(): void {
  grants.clear()
  notify()
}
