/*
 * The composer's visibility: Public or Private, and the audience. One record,
 * because the stock composer never opens a second composer over an open one.
 *
 * The record lives as long as the composer, not as long as the control:
 * `usePrivateComposeSession`, called once in `ComposePost`, sets it up on
 * mount and resets it on unmount. On web the footer that holds the control
 * moves into the active post once a compose has two posts, so the control
 * remounts and must never touch the record's lifetime.
 */

import {useLayoutEffect, useSyncExternalStore} from 'react'

import {type StandingMode} from '#/horizon/private/api/audiences'
import {getPrivatePostFacts} from '#/horizon/private/store'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {PRIVATE_POSTING} from '#/horizon/switches'

/**
 * Who a private compose is for.
 * - `mode`: a standing audience, found or created at publish time.
 * - `list`: one of the account's list audiences.
 * - `parent`: a reply to a private post, under the parent's audience, which
 *   is read from the parent at publish time. `uri` is the audience the
 *   parent names when it is known already, for display.
 */
export type ComposeAudience =
  | {kind: 'mode'; mode: StandingMode}
  | {kind: 'list'; uri: string}
  | {kind: 'parent'; uri?: string}

export type ComposeVisibility = {
  visibility: 'public' | 'private'
  audience: ComposeAudience
  /** A reply to a private post: Private, under the parent's audience. */
  locked: boolean
}

export const EVERYONE: ComposeAudience = {kind: 'mode', mode: 'everyone'}

export const PUBLIC_COMPOSE: ComposeVisibility = {
  visibility: 'public',
  audience: EVERYONE,
  locked: false,
}

let state: ComposeVisibility = PUBLIC_COMPOSE
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getComposeVisibility(): ComposeVisibility {
  return state
}

/**
 * Replace the record. Listeners are called.
 */
export function setComposeVisibility(next: ComposeVisibility) {
  if (next === state) return
  state = next
  listeners.forEach(listener => listener())
}

/**
 * The control's change: a new visibility or audience. Ignored while locked.
 */
export function chooseComposeVisibility(
  change: Partial<Pick<ComposeVisibility, 'visibility' | 'audience'>>,
) {
  if (state.locked) return
  setComposeVisibility({...state, ...change})
}

/**
 * The record, kept current.
 */
export function useComposeVisibility(): ComposeVisibility {
  return useSyncExternalStore(subscribe, getComposeVisibility)
}

/**
 * Whether the open compose is private (non-React).
 */
export function isPrivateCompose(): boolean {
  return state.visibility === 'private'
}

/**
 * Whether the open compose is private, kept current.
 */
export function useIsPrivateCompose(): boolean {
  return useSyncExternalStore(subscribe, isPrivateCompose)
}

/**
 * Whether `post()` takes the private path: the compose is private, or it
 * replies to a private post whatever the compose says, so a reply to a
 * private post never takes the public path.
 */
export function routesPrivate(replyTo: string | undefined): boolean {
  return PRIVATE_POSTING && (isPrivateCompose() || isPrivatePostUri(replyTo))
}

/**
 * The record a compose starts from: Private and locked under the parent's
 * audience when replying to a private post (whether or not the account is a
 * member right now), else Public with Everyone.
 */
export function initialComposeVisibility(
  replyToUri: string | undefined,
): ComposeVisibility {
  if (PRIVATE_POSTING && replyToUri && isPrivatePostUri(replyToUri)) {
    return {
      visibility: 'private',
      audience: {
        kind: 'parent',
        uri: getPrivatePostFacts(replyToUri)?.audienceUri,
      },
      locked: true,
    }
  }
  return PUBLIC_COMPOSE
}

/**
 * Owns the record for the composer's lifetime: sets it up on mount and resets
 * it to Public on unmount. Called once in `ComposePost`. Returns whether the
 * compose is private, re-rendering the composer when that changes.
 */
export function usePrivateComposeSession(
  replyTo: {uri: string} | undefined,
): boolean {
  const replyToUri = replyTo?.uri
  useLayoutEffect(() => {
    if (!PRIVATE_POSTING) return
    setComposeVisibility(initialComposeVisibility(replyToUri))
    return () => setComposeVisibility(PUBLIC_COMPOSE)
  }, [replyToUri])
  return useIsPrivateCompose()
}
