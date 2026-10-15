/*
 * Horizon's own device keys, outside Bluesky's storage schema. This is the
 * native and test implementation: an in-memory map. The web implementation
 * (`local-store.web.ts`) uses `localStorage` and follows other tabs.
 */

const values = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()

function notify(key: string) {
  listeners.get(key)?.forEach(listener => listener())
}

/**
 * Read a key, or `undefined` when it is not set.
 */
export function readLocal(key: string): string | undefined {
  return values.get(key)
}

/**
 * Write a key; `undefined` removes it. Listeners for the key are called.
 */
export function writeLocal(key: string, value: string | undefined) {
  if (value === undefined) {
    values.delete(key)
  } else {
    values.set(key, value)
  }
  notify(key)
}

/**
 * Call `listener` whenever the key changes, in this tab or another one.
 * Returns the unsubscribe function.
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
