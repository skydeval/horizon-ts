/*
 * The public AppView choice: Bluesky's by default, or one the user picked in
 * the AppView switcher. A Horizon device key, outside Bluesky's storage
 * schema. prism is never the public AppView.
 *
 * Adapted from the Witchsky client (MIT),
 * src/state/preferences/custom-appview-did.tsx (the stored selection and the
 * Bluesky default).
 */

import {useSyncExternalStore} from 'react'
import {type Service} from '@atproto/lex'

import {
  readLocal,
  subscribeLocal,
  writeLocal,
} from '#/horizon/session/local-store'

/**
 * The device key holding the choice.
 */
export const PUBLIC_APPVIEW_KEY = 'horizon.publicAppview'

/**
 * A chosen public AppView: its `did:web` and its `#bsky_appview` endpoint.
 */
export type PublicAppviewChoice = {did: string; url: string}

function parse(raw: string | undefined): PublicAppviewChoice | undefined {
  if (!raw) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value &&
      typeof value === 'object' &&
      'did' in value &&
      'url' in value &&
      typeof value.did === 'string' &&
      typeof value.url === 'string' &&
      value.did.startsWith('did:') &&
      value.url
    ) {
      return {did: value.did, url: value.url}
    }
  } catch {
    // Unreadable: treat as the default.
  }
  return undefined
}

/**
 * The stored choice, or `undefined` for Bluesky's default.
 */
export function readPublicAppviewChoice(): PublicAppviewChoice | undefined {
  return parse(readLocal(PUBLIC_APPVIEW_KEY))
}

/**
 * Store a choice; `undefined` returns to Bluesky's default.
 */
export function writePublicAppviewChoice(
  choice: PublicAppviewChoice | undefined,
) {
  writeLocal(PUBLIC_APPVIEW_KEY, choice ? JSON.stringify(choice) : undefined)
}

/**
 * The `atproto-proxy` target for signed-in AppView reads: the chosen AppView's
 * `#bsky_appview` service, or `fallback` (the stock value) by default.
 */
export function getPublicAppviewService(fallback: Service): Service {
  const choice = readPublicAppviewChoice()
  return choice ? (`${choice.did}#bsky_appview` as Service) : fallback
}

/**
 * The URL signed-out reads go to: the chosen AppView's endpoint, or
 * `fallback` (the stock value) by default.
 */
export function getPublicAppviewUrl(fallback: string): string {
  return readPublicAppviewChoice()?.url ?? fallback
}

/**
 * Whether the public AppView is Bluesky's. Signed-out reads go straight from
 * the browser to the AppView, and only Bluesky's receives Bluesky's device and
 * session identifiers.
 */
export function usesBlueskyPublicAppview(): boolean {
  return readPublicAppviewChoice() === undefined
}

/**
 * Subscribe to the stored choice (this tab and others).
 */
export function subscribePublicAppviewChoice(listener: () => void) {
  return subscribeLocal(PUBLIC_APPVIEW_KEY, listener)
}

/**
 * The stored choice, kept current.
 */
export function usePublicAppviewChoice(): PublicAppviewChoice | undefined {
  const raw = useSyncExternalStore(subscribePublicAppviewChoice, () =>
    readLocal(PUBLIC_APPVIEW_KEY),
  )
  return parse(raw)
}
