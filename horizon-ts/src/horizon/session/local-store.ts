/*
 * Horizon's own device keys, outside Bluesky's storage schema. This is the
 * native implementation: its own synchronous MMKV instance, so drafts, the
 * private outbox, membership and the like survive the app closing. In tests
 * MMKV runs in memory. The web implementation (`local-store.web.ts`) uses
 * `localStorage` and follows other tabs.
 */

import {MMKV} from 'react-native-mmkv'

let store: MMKV | undefined
const listeners = new Map<string, Set<() => void>>()
const prefixListeners = new Map<string, Set<(key: string) => void>>()

function mmkv() {
  if (!store) store = new MMKV({id: 'horizon_local'})
  return store
}

function notify(key: string) {
  listeners.get(key)?.forEach(listener => listener())
  prefixListeners.forEach((set, prefix) => {
    if (key.startsWith(prefix)) set.forEach(listener => listener(key))
  })
}

/**
 * Read a key, or `undefined` when it is not set or storage failed.
 */
export function readLocal(key: string): string | undefined {
  try {
    return mmkv().getString(key)
  } catch {
    return undefined
  }
}

function write(key: string, value: string | undefined) {
  if (value === undefined) {
    mmkv().delete(key)
  } else {
    mmkv().set(key, value)
  }
}

/**
 * Write a key; `undefined` removes it. Listeners for the key are called.
 */
export function writeLocal(key: string, value: string | undefined) {
  try {
    write(key, value)
  } catch {
    // Storage failed (e.g. the disk is full); the value is lost.
  }
  notify(key)
}

/**
 * Write a key and read it back (2K design PA-28, K8-N8): `false` when the
 * write threw or the value read back differs. Unlike {@link writeLocal}, a
 * failure is never swallowed.
 */
export function writeLocalChecked(
  key: string,
  value: string | undefined,
): boolean {
  let saved = false
  try {
    write(key, value)
    saved = mmkv().getString(key) === value
  } catch {
    saved = false
  }
  notify(key)
  return saved
}

/**
 * Every key that starts with `prefix`; `[]` when storage failed.
 */
export function listLocalKeys(prefix: string): string[] {
  try {
    return mmkv()
      .getAllKeys()
      .filter(key => key.startsWith(prefix))
  } catch {
    return []
  }
}

/**
 * Call `listener` whenever the key changes. Returns the unsubscribe function.
 * The app is one process, so every change comes through this module.
 */
export function subscribeLocal(key: string, listener: () => void) {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

/**
 * Call `listener` with the key whenever a key starting with `prefix` changes.
 * Returns the unsubscribe function.
 */
export function subscribeLocalPrefix(
  prefix: string,
  listener: (key: string) => void,
) {
  let set = prefixListeners.get(prefix)
  if (!set) {
    set = new Set()
    prefixListeners.set(prefix, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}
