/*
 * The dirty set on native (activity subscriptions design 2.2): its own
 * synchronous MMKV instance, as the appearance device value has
 * (`appearance/device-store.ts`), because the shared local store is in-memory
 * on native. So a dirty subject, and the reconcile's `reconciled:<did>`
 * record, survive a killed app. `dirty-store.web.ts` is the web
 * implementation; both export the same functions.
 *
 * One key per (account, subject): `horizon-activity-subs-dirty:<did>:<subject>`,
 * whose value is an opaque random token, never flags or times.
 */

import {MMKV} from 'react-native-mmkv'

import {
  DIRTY_PREFIX,
  dirtyKey,
  parseDirtyKey,
  parseReconciledKey,
  RECONCILED_PREFIX,
  reconciledKey,
} from '#/horizon/private/activity-subscriptions/common'

let store: MMKV | undefined

function mmkv() {
  if (!store) store = new MMKV({id: 'horizon_activity_subs'})
  return store
}

/** The subject's token, or `undefined` when it is not dirty. */
export function readToken(did: string, subject: string): string | undefined {
  return mmkv().getString(dirtyKey(did, subject))
}

/** Mark the subject dirty with `token`. */
export function writeToken(did: string, subject: string, token: string) {
  mmkv().set(dirtyKey(did, subject), token)
}

/** The subject is levelled: remove its key. */
export function removeToken(did: string, subject: string) {
  mmkv().delete(dirtyKey(did, subject))
}

/** Every dirty subject of `did`. */
export function listSubjects(did: string): string[] {
  const subjects: string[] = []
  for (const key of mmkv().getAllKeys()) {
    const parsed = parseDirtyKey(key)
    if (parsed && parsed.did === did) subjects.push(parsed.subject)
  }
  return subjects
}

/**
 * Call `listener` whenever a dirty key changes. Native is one process, so
 * only this process's writes are heard.
 */
export function subscribeDirty(
  listener: (did: string, subject: string) => void,
): () => void {
  const subscription = mmkv().addOnValueChangedListener(key => {
    const parsed = parseDirtyKey(key)
    if (parsed) listener(parsed.did, parsed.subject)
  })
  return () => subscription.remove()
}

/** When `did`'s last complete reconcile ended (ms since the epoch). */
export function readReconciled(did: string): number | undefined {
  const raw = mmkv().getString(reconciledKey(did))
  const at = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(at) ? at : undefined
}

export function writeReconciled(did: string, at: number) {
  mmkv().set(reconciledKey(did), String(at))
}

export function clearReconciled(did: string) {
  mmkv().delete(reconciledKey(did))
}

/**
 * Every account with a dirty key or a `reconciled:<did>` record, so an
 * account that holds only its record is found too.
 */
export function listDids(): string[] {
  const dids = new Set<string>()
  for (const key of mmkv().getAllKeys()) {
    if (key.startsWith(DIRTY_PREFIX)) {
      const parsed = parseDirtyKey(key)
      if (parsed) dids.add(parsed.did)
    } else if (key.startsWith(RECONCILED_PREFIX)) {
      const did = parseReconciledKey(key)
      if (did) dids.add(did)
    }
  }
  return Array.from(dids)
}

/** Forget a removed account: its dirty keys and its record. */
export function clearDid(did: string) {
  for (const subject of listSubjects(did)) removeToken(did, subject)
  clearReconciled(did)
}
