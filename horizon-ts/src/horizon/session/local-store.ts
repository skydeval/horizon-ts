/*
 * Horizon's own device keys, outside Bluesky's storage schema. This is the
 * native and test implementation: an in-memory map. The web implementation
 * (`local-store.web.ts`) uses `localStorage` and follows other tabs.
 */

const values = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()
const prefixListeners = new Map<string, Set<(key: string) => void>>()

function notify(key: string) {
  listeners.get(key)?.forEach(listener => listener())
  prefixListeners.forEach((set, prefix) => {
    if (key.startsWith(prefix)) set.forEach(listener => listener(key))
  })
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
 * Write a key and read it back (2K design PA-28, K8-N8). `false` when the
 * write threw or the value read back differs; the map never fails here, so
 * this is `writeLocal` that answers `true`.
 */
export function writeLocalChecked(
  key: string,
  value: string | undefined,
): boolean {
  writeLocal(key, value)
  return values.get(key) === value
}

/**
 * Every key that starts with `prefix`.
 */
export function listLocalKeys(prefix: string): string[] {
  return Array.from(values.keys()).filter(key => key.startsWith(prefix))
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

/**
 * Call `listener` with the key whenever a key starting with `prefix` changes,
 * in this tab or another one. Returns the unsubscribe function.
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
