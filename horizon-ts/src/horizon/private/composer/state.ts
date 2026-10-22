/*
 * The composer's visibility: Public or Private, and the audience. One record,
 * because the stock composer never opens a second composer over an open one.
 *
 * The record lives as long as the composer, not as long as the control:
 * `usePrivateComposeSession` (`session.ts`), called once in `ComposePost`,
 * sets it up on mount and resets it on unmount. On web the footer that holds
 * the control moves into the active post once a compose has two posts, so
 * the control remounts and must never touch the record's lifetime.
 *
 * A member's new compose starts from the private posting defaults
 * (Interaction settings > Private posts, `defaults/`): a top-level post
 * starts Public or Private as "New posts start as" says, a quote as the
 * quoted post is (round 2 list, item 6), and every compose that is not
 * locked starts with the "Default audience", used once it is Private. Defaults that arrive after the composer opened (the record read
 * in the background, membership confirmed late) still apply, until anything
 * else sets the record: a choice in the control, or a restored draft.
 */

import {useSyncExternalStore} from 'react'

import {type ComposerOptsPostRef} from '#/state/shell/composer'
import {type StandingMode} from '#/horizon/private/api/audiences'
import {
  type PrivateDefaults,
  UNSET_AUDIENCE,
} from '#/horizon/private/defaults/record'
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
/**
 * Whether the record is still the one the compose session started with, so
 * defaults arriving late may replace it.
 */
let startedFresh = false
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

function replace(next: ComposeVisibility) {
  if (next === state) return
  state = next
  listeners.forEach(listener => listener())
}

/**
 * Replace the record. Listeners are called. Defaults arriving later no
 * longer apply.
 */
export function setComposeVisibility(next: ComposeVisibility) {
  startedFresh = false
  replace(next)
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

function sameAudience(x: ComposeAudience, y: ComposeAudience): boolean {
  if (x.kind === 'mode' && y.kind === 'mode') return x.mode === y.mode
  if (x.kind === 'list' && y.kind === 'list') return x.uri === y.uri
  if (x.kind === 'parent' && y.kind === 'parent') return x.uri === y.uri
  return false
}

function sameVisibility(x: ComposeVisibility, y: ComposeVisibility): boolean {
  return (
    x.visibility === y.visibility &&
    x.locked === y.locked &&
    sameAudience(x.audience, y.audience)
  )
}

/**
 * Start a compose session's record (the composer opening).
 */
export function startComposeVisibility(initial: ComposeVisibility) {
  replace(initial)
  startedFresh = true
}

/**
 * Apply defaults that arrived after the session started, while nothing else
 * has set the record since.
 */
export function applyLateComposeDefaults(
  replyToUri: string | undefined,
  defaults: PrivateDefaults | undefined,
  quoteUri?: string,
) {
  if (!startedFresh || !defaults) return
  const next = initialComposeVisibility(replyToUri, defaults, quoteUri)
  if (!sameVisibility(next, state)) replace(next)
}

/**
 * The record, kept current.
 */
export function useComposeVisibility(): ComposeVisibility {
  return useSyncExternalStore(subscribe, getComposeVisibility)
}

let composeReplyRef: ComposerOptsPostRef | undefined

/**
 * The reply ref the open composer was opened with, kept for the compose
 * session (`usePrivateComposeSession`) so the outbox can capture it at press
 * (2K design PA-28 step 1); `undefined` for a top-level compose or with no
 * composer open.
 */
export function getComposeReplyRef(): ComposerOptsPostRef | undefined {
  return composeReplyRef
}

export function setComposeReplyRef(ref: ComposerOptsPostRef | undefined) {
  composeReplyRef = ref
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
 * member right now). Otherwise, with a member's `defaults` (absent for
 * anyone else):
 * - a reply to a public post starts Public;
 * - a quote (`quoteUri`, the post the composer opened quoting) starts as
 *   the quoted post is, whatever "New posts start as" says: a quote of a
 *   private post Private with the default audience (Everyone while none is
 *   chosen); a quote of a public post Public. Not locked: a public quote
 *   of a private post is allowed, its readers outside the audience see the
 *   stand-in;
 * - any other post starts as "New posts start as" says;
 * and every one of them holds the default audience (Everyone while none is
 * chosen) for when it is made Private. Without defaults, Public with
 * Everyone.
 */
export function initialComposeVisibility(
  replyToUri: string | undefined,
  defaults?: PrivateDefaults,
  quoteUri?: string,
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
  if (!PRIVATE_POSTING || !defaults) return PUBLIC_COMPOSE
  const audience = defaults.audience ?? UNSET_AUDIENCE
  if (!replyToUri && quoteUri && isPrivatePostUri(quoteUri)) {
    return {visibility: 'private', audience, locked: false}
  }
  if (replyToUri || quoteUri) {
    return {visibility: 'public', audience, locked: false}
  }
  return {visibility: defaults.startAs, audience, locked: false}
}
