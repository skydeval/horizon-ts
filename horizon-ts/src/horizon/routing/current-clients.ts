/*
 * The signed-in account's clients, readable outside React. Some private paths
 * run in stock functions that receive no prism client and whose signatures
 * Horizon does not widen (`post()`, `fetchPost`, the thread and feed query
 * functions, `resolveLink`); they read this record instead.
 *
 * `CurrentClientsPublisher` publishes it from `HorizonHost` in a layout
 * effect, so it lags one render after an account change: while the new
 * account's tree renders for the first time the record still names the
 * previous account. A reader that runs during render must check the record
 * against the session (`isCurrentFor`); non-React callers run after the
 * commit and read the published record.
 */

import {useSyncExternalStore} from 'react'
import {type Client} from '@atproto/lex'
import {type QueryClient} from '@tanstack/react-query'

/**
 * The signed-in account and its clients.
 */
export type CurrentClients = {
  did: string
  handle: string
  /** The account's PDS URL as the session knows it, when it does. */
  pdsUrl: string | undefined
  pdsClient: Client
  prismClient: Client
  appviewClient: Client
  /**
   * The chat client, for the outbox's embed resolution (a quoted chat invite
   * link, 2K design PA-28 step 7). The publisher always sets it.
   */
  chatClient?: Client
  /**
   * The account's query client, for the non-React private paths that read
   * or write a cached value (the account's own pinned post, the outbox's
   * job). The publisher always sets it.
   */
  queryClient?: QueryClient
}

/**
 * Thrown by a private function that needs the signed-in clients when none are
 * published (signed out, or called before the first publish). The query
 * layer treats it as an ordinary failure.
 */
export class PrivateClientUnavailableError extends Error {
  constructor() {
    super('No signed-in account is available for this private request')
    this.name = 'PrivateClientUnavailableError'
  }
}

let current: CurrentClients | undefined
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach(listener => listener())
}

/**
 * Publish the signed-in account's clients. Subscribers are called.
 */
export function publishCurrentClients(next: CurrentClients) {
  current = next
  notify()
}

/**
 * Clear the record, but only if it is still `published`, so a newer publish
 * is never cleared by an older publisher's clean-up.
 */
export function clearCurrentClients(published?: CurrentClients) {
  if (published && current !== published) return
  if (current === undefined) return
  current = undefined
  notify()
}

/**
 * Called on every publish and clear. Returns the unsubscribe function.
 */
export function subscribeCurrentClients(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The published record, or `undefined` when signed out.
 */
export function getCurrentClients(): CurrentClients | undefined {
  return current
}

/**
 * The published record, re-rendering on every publish and clear.
 */
export function useCurrentClients(): CurrentClients | undefined {
  return useSyncExternalStore(subscribeCurrentClients, getCurrentClients)
}

/**
 * Whether `record` belongs to the session's current account. A render-time
 * reader uses this to ignore the record during the one render after an
 * account change in which it is stale.
 */
export function isCurrentFor(
  record: CurrentClients | undefined,
  sessionDid: string | undefined,
): record is CurrentClients {
  return !!record && !!sessionDid && record.did === sessionDid
}

/**
 * The published record; throws {@link PrivateClientUnavailableError} without
 * one.
 */
export function requireCurrentClients(): CurrentClients {
  if (!current) throw new PrivateClientUnavailableError()
  return current
}

export function getCurrentDid(): string | undefined {
  return current?.did
}

export function getCurrentPdsClient(): Client | undefined {
  return current?.pdsClient
}

/**
 * The signed-in prism client, or `undefined` when signed out. Never the
 * signed-out prism client: private reads are never made signed out.
 */
export function getCurrentPrismClient(): Client | undefined {
  return current?.prismClient
}

export function getCurrentAppviewClient(): Client | undefined {
  return current?.appviewClient
}
