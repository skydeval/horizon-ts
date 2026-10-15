/*
 * Horizon's own device keys on web, in `localStorage`, outside Bluesky's
 * storage schema. Bluesky's device storage does not tell other tabs about a
 * change, so this module subscribes to the `storage` event itself.
 */

const listeners = new Map<string, Set<() => void>>()
let listening = false

function notify(key: string) {
  listeners.get(key)?.forEach(listener => listener())
}

function listen() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('storage', event => {
    if (event.key === null) {
      // The whole store was cleared.
      listeners.forEach((_set, key) => notify(key))
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
