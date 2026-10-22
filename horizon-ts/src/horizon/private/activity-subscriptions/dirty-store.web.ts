/*
 * The dirty set on web (activity subscriptions design 2.2): `localStorage`
 * through Horizon's local store, synchronous, other tabs through the
 * `storage` event, as the appearance device value has
 * (`appearance/device-store.web.ts`). `dirty-store.ts` is the native
 * implementation; both export the same functions.
 *
 * One key per (account, subject): `horizon-activity-subs-dirty:<did>:<subject>`,
 * whose value is an opaque random token, never flags or times. One key per
 * subject, so two tabs never read-modify-write one shared value.
 */

import {
  DIRTY_PREFIX,
  dirtyKey,
  parseDirtyKey,
  parseReconciledKey,
  RECONCILED_PREFIX,
  reconciledKey,
} from '#/horizon/private/activity-subscriptions/common'
import {
  listLocalKeys,
  readLocal,
  subscribeLocalPrefix,
  writeLocal,
} from '#/horizon/session/local-store.web'

/** The subject's token, or `undefined` when it is not dirty. */
export function readToken(did: string, subject: string): string | undefined {
  return readLocal(dirtyKey(did, subject))
}

/** Mark the subject dirty with `token`. */
export function writeToken(did: string, subject: string, token: string) {
  writeLocal(dirtyKey(did, subject), token)
}

/** The subject is levelled: remove its key. */
export function removeToken(did: string, subject: string) {
  writeLocal(dirtyKey(did, subject), undefined)
}

/** Every dirty subject of `did`. */
export function listSubjects(did: string): string[] {
  const subjects: string[] = []
  for (const key of listLocalKeys(`${DIRTY_PREFIX}${did}:`)) {
    const parsed = parseDirtyKey(key)
    if (parsed && parsed.did === did) subjects.push(parsed.subject)
  }
  return subjects
}

/**
 * Call `listener` whenever a dirty key changes, in this tab or another one.
 * A cleared store is heard as no key.
 */
export function subscribeDirty(
  listener: (did: string, subject: string) => void,
): () => void {
  return subscribeLocalPrefix(DIRTY_PREFIX, key => {
    const parsed = parseDirtyKey(key)
    if (parsed) listener(parsed.did, parsed.subject)
  })
}

/** When `did`'s last complete reconcile ended (ms since the epoch). */
export function readReconciled(did: string): number | undefined {
  const raw = readLocal(reconciledKey(did))
  const at = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(at) ? at : undefined
}

export function writeReconciled(did: string, at: number) {
  writeLocal(reconciledKey(did), String(at))
}

export function clearReconciled(did: string) {
  writeLocal(reconciledKey(did), undefined)
}

/**
 * Every account with a dirty key or a `reconciled:<did>` record, so an
 * account that holds only its record is found too.
 */
export function listDids(): string[] {
  const dids = new Set<string>()
  for (const key of listLocalKeys(DIRTY_PREFIX)) {
    const parsed = parseDirtyKey(key)
    if (parsed) dids.add(parsed.did)
  }
  for (const key of listLocalKeys(RECONCILED_PREFIX)) {
    const did = parseReconciledKey(key)
    if (did) dids.add(did)
  }
  return Array.from(dids)
}

/** Forget a removed account: its dirty keys and its record. */
export function clearDid(did: string) {
  for (const subject of listSubjects(did)) removeToken(did, subject)
  clearReconciled(did)
}
