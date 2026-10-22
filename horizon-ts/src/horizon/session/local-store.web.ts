/*
 * Horizon's own device keys on web, in `localStorage`, outside Bluesky's
 * storage schema. Bluesky's device storage does not tell other tabs about a
 * change, so this module subscribes to the `storage` event itself.
 */

import {logger} from '#/logger'

const listeners = new Map<string, Set<() => void>>()
const prefixListeners = new Map<string, Set<(key: string) => void>>()
let listening = false

function notify(key: string) {
  listeners.get(key)?.forEach(listener => listener())
  prefixListeners.forEach((set, prefix) => {
    if (key.startsWith(prefix)) set.forEach(listener => listener(key))
  })
}

function listen() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('storage', event => {
    if (event.key === null) {
      // The whole store was cleared.
      listeners.forEach((_set, key) => notify(key))
      prefixListeners.forEach((set, prefix) =>
        set.forEach(listener => listener(prefix)),
      )
    } else {
      notify(event.key)
    }
  })
}

/**
 * Read a key, or `undefined` when it is not set or storage is unavailable.
 */
export function readLocal(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Write a key; `undefined` removes it. Listeners in this tab are called at
 * once; other tabs hear it through their `storage` event.
 */
export function writeLocal(key: string, value: string | undefined) {
  try {
    if (value === undefined) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, value)
    }
  } catch {
    // Storage may be unavailable (private mode, quota); the value is lost.
  }
  notify(key)
}

/**
 * Write a key and read it back (2K design PA-28, K8-N8): `false` when the
 * write threw (quota, storage blocked) or the value read back differs, with
 * `outbox: record not saved` logged by the error's name only. Unlike
 * {@link writeLocal}, a failure is never swallowed.
 */
export function writeLocalChecked(
  key: string,
  value: string | undefined,
): boolean {
  let saved = false
  try {
    if (value === undefined) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, value)
    }
    saved = (window.localStorage.getItem(key) ?? undefined) === value
    if (!saved) logger.warn('outbox: record not saved', {name: 'Mismatch'})
  } catch (error) {
    logger.warn('outbox: record not saved', {
      name: error instanceof Error ? error.name : typeof error,
    })
  }
  notify(key)
  return saved
}

/**
 * Every key that starts with `prefix`; `[]` when storage is unavailable.
 */
export function listLocalKeys(prefix: string): string[] {
  try {
    const storage = window.localStorage
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null && key.startsWith(prefix)) keys.push(key)
    }
    return keys
  } catch {
    return []
  }
}

/**
 * Call `listener` whenever the key changes, in this tab or another one.
 * Returns the unsubscribe function.
 */
export function subscribeLocal(key: string, listener: () => void) {
  listen()
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
 * Call `listener` with the key whenever a key starting with `prefix` changes,
 * in this tab (through {@link writeLocal} and {@link writeLocalChecked}) or
 * another one (the `storage` event). A cleared store calls it with `prefix`.
 * Returns the unsubscribe function.
 */
export function subscribeLocalPrefix(
  prefix: string,
  listener: (key: string) => void,
) {
  listen()
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
