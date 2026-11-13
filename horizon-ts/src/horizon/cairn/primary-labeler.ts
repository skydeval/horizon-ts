/*
 * The cairn primary labeler: a built-in moderation labeler, like Bluesky's.
 *
 * An operator who runs cairn sets `EXPO_PUBLIC_CAIRN_URL` to its address.
 * Without it, nothing here does anything. With it, Horizon asks cairn which
 * labeler is its primary (`tools.cairn.instance.getPrimaryLabeler`) and puts
 * only that one on the app's labelers (`Client.appLabelers`): always applied,
 * not removable, and offered in every report. Any other cairn labeler stays an
 * ordinary subscription.
 *
 * The answer is kept on the device, so an outage keeps moderation in place.
 * When cairn says there is no published primary, or the labeler's service
 * record is gone, it is dropped. It is checked again at launch, every few
 * minutes and when the app comes back to the front.
 */

import {useSyncExternalStore} from 'react'

import {PUBLIC_BSKY_SERVICE} from '#/lib/constants'
import {readLocal, writeLocal} from '#/horizon/session/local-store'

const STORE_KEY = 'horizon:cairnPrimaryLabeler'

/** The operator's cairn address, or undefined when the operator has none. */
export function cairnUrl(
  raw: string | undefined = process.env.EXPO_PUBLIC_CAIRN_URL,
): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function isDid(value: unknown): value is string {
  return (
    typeof value === 'string' && /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(value)
  )
}

let primary: string | undefined
let loaded = false
const listeners = new Set<() => void>()

function current(): string | undefined {
  if (!loaded) {
    loaded = true
    const stored = cairnUrl() ? readLocal(STORE_KEY) : undefined
    primary = isDid(stored) ? stored : undefined
  }
  return primary
}

function set(next: string | undefined) {
  if (current() === next) return
  primary = next
  writeLocal(STORE_KEY, next)
  listeners.forEach(listener => listener())
}

/**
 * The primary labeler's DID while it applies, else undefined (no cairn
 * address, never answered, or not published).
 */
export function cairnPrimaryLabeler(): string | undefined {
  return cairnUrl() ? current() : undefined
}

/** Listen for the primary changing. Returns the unsubscribe function. */
export function subscribeCairnPrimaryLabeler(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The primary labeler's DID, for render. */
export function useCairnPrimaryLabeler(): string | undefined {
  return useSyncExternalStore(
    subscribeCairnPrimaryLabeler,
    cairnPrimaryLabeler,
    cairnPrimaryLabeler,
  )
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** What one check found. */
export type PrimaryCheck =
  {kind: 'primary'; did: string} | {kind: 'none'} | {kind: 'unknown'}

/** Errors with which cairn says there is no primary to show. */
const NO_PRIMARY = ['NotPublished', 'NotFound']

async function askCairn(base: string, fetchImpl: Fetch): Promise<PrimaryCheck> {
  let response: Response
  try {
    response = await fetchImpl(
      `${base}/xrpc/tools.cairn.instance.getPrimaryLabeler`,
    )
  } catch {
    return {kind: 'unknown'}
  }
  let body: {did?: unknown; error?: unknown} | undefined
  try {
    body = (await response.json()) as {did?: unknown; error?: unknown}
  } catch {
    body = undefined
  }
  if (response.ok) {
    return isDid(body?.did)
      ? {kind: 'primary', did: body.did}
      : {kind: 'unknown'}
  }
  if (
    response.status >= 400 &&
    response.status < 500 &&
    typeof body?.error === 'string' &&
    NO_PRIMARY.includes(body.error)
  ) {
    return {kind: 'none'}
  }
  return {kind: 'unknown'}
}

/** Whether the labeler's service record can be found: yes, no or unknown. */
async function serviceExists(
  did: string,
  fetchImpl: Fetch,
): Promise<boolean | undefined> {
  try {
    const response = await fetchImpl(
      `${PUBLIC_BSKY_SERVICE}/xrpc/app.bsky.labeler.getServices?dids=${encodeURIComponent(did)}`,
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as {views?: unknown[]}
    return Array.isArray(body.views) ? body.views.length > 0 : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask cairn for its primary and apply the answer: a published primary is
 * kept, "none" (or a missing service record) drops it, and anything else
 * (network, server errors, a malformed answer) keeps the last one.
 */
export async function checkCairnPrimaryLabeler(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  base: string | undefined = cairnUrl(),
): Promise<PrimaryCheck> {
  if (!base) return {kind: 'unknown'}
  const answer = await askCairn(base, fetchImpl)
  if (answer.kind === 'none') {
    set(undefined)
    return answer
  }
  if (answer.kind === 'primary') {
    const exists = await serviceExists(answer.did, fetchImpl)
    if (exists === false) {
      set(undefined)
      return {kind: 'none'}
    }
    if (exists === true || current() === answer.did) {
      set(answer.did)
      return answer
    }
    // Service record unknown and the DID is new: wait for a later check
    return {kind: 'unknown'}
  }
  return answer
}

/** For tests: forget the in-memory state so the next read reloads it. */
export function resetCairnPrimaryLabelerForTests() {
  primary = undefined
  loaded = false
  listeners.clear()
}
