/*
 * Handles the lens has resolved, kept on the device (2026-10-26, Prism's
 * round 5: a link or reload on a handle URL waited 850 ms on
 * `resolveHandle`). A known handle answers at once and is checked again in
 * the background; a changed answer replaces it for the next read. Kept to
 * {@link HANDLE_CACHE_MAX} entries and {@link HANDLE_CACHE_TTL_MS} each, in
 * Horizon's local store under one key, never sent anywhere.
 */

import {readLocal, writeLocal} from '#/horizon/session/local-store'

/** The device key holding the map. */
export const HANDLE_CACHE_KEY = 'horizon:lensHandles'

/** How many handles are kept: the most recently used. */
export const HANDLE_CACHE_MAX = 300

/** How long an entry is trusted without a fresh answer. */
export const HANDLE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Entry = {did: string; at: number}

function readAll(): Record<string, Entry> {
  try {
    const raw = readLocal(HANDLE_CACHE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, Entry>)
      : {}
  } catch {
    return {}
  }
}

/** The DID cached for `handle`, while fresh. */
export function cachedHandleDid(
  handle: string,
  now = Date.now(),
): string | undefined {
  const entry = readAll()[handle.toLowerCase()]
  if (!entry || typeof entry.did !== 'string' || !entry.did.startsWith('did:'))
    return undefined
  if (typeof entry.at !== 'number' || now - entry.at > HANDLE_CACHE_TTL_MS) {
    return undefined
  }
  return entry.did
}

/**
 * Forget every handle (sign-out): the map says whose threads were opened on
 * this device, so it goes with any account that signs out.
 */
export function clearHandleCache() {
  writeLocal(HANDLE_CACHE_KEY, undefined)
}

/** Keep `handle` → `did`, dropping the oldest past the cap. */
export function rememberHandleDid(
  handle: string,
  did: string,
  now = Date.now(),
) {
  if (!did.startsWith('did:')) return
  const all = readAll()
  all[handle.toLowerCase()] = {did, at: now}
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, HANDLE_CACHE_MAX)
  writeLocal(HANDLE_CACHE_KEY, JSON.stringify(Object.fromEntries(kept)))
}
