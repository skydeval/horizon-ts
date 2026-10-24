/*
 * The compose's "Posting as" choice (Phase 5 design 8.1, 8.2, PP-5): one
 * record for the open composer, as the visibility record is (`private/
 * composer/state.ts`). Every post of a thread goes from the same account with
 * the same members.
 *
 * - `did`: the account the compose posts from; the current account until
 *   another is chosen.
 * - `members`: the chosen member rkeys, read for `did` only; none means "post
 *   as the account". A draft restored with members holds them in
 *   `heldMembers` until that account's member list answers.
 * - `hold`: the posting account's reads (8.2, "Publish waits for the posting
 *   account"): `pending` and `failed` keep Publish off; `signedOut` is a
 *   draft written as an account that is not signed in here.
 * - `resetPending`: an account was picked in the control and its reset has
 *   not applied yet; the drop-down's sections, the Public | Private control
 *   and the members group are held (P5R4-L1, P5R5-N1).
 *
 * Kept apart from `gates.ts` (which runs the reads) so the write paths can
 * read the choice without importing any query or React module.
 */

import {useSyncExternalStore} from 'react'

import {type ListedMember} from '#/horizon/identity/reads'
import {type app} from '#/lexicons'

/** What keeps Publish off while the posting account is read. */
export type PostingHold =
  | {kind: 'none'}
  | {kind: 'pending'}
  | {kind: 'failed'}
  | {kind: 'signedOut'; handle: string | undefined}

/** The posting account's plural records, read for that account. */
export type PostingAccountData = {
  did: string
  isSystem: boolean
  /** Ascending rkey, each read as a record for `did`. */
  members: ListedMember[]
}

/** A note the composer shows about a restored draft's reply settings. */
export type PostingDraftNote = 'foreign-lists' | 'foreign-lists-nobody'

export type PostingState = {
  /** A composer is open. */
  active: boolean
  /** The signed-in account the composer opened as. */
  currentDid: string | undefined
  currentHandle: string | undefined
  /** The account the compose posts from. */
  did: string | undefined
  handle: string | undefined
  members: readonly string[]
  /** A restored draft's members, until the posting account's list answers. */
  heldMembers: readonly string[] | undefined
  /** The user changed the member selection since the last start. */
  touched: boolean
  hold: PostingHold
  resetPending: boolean
  data: PostingAccountData | undefined
  /** The posting account's own interaction settings, once read. */
  settings: app.bsky.actor.defs.PostInteractionSettingsPref | undefined
  draftNote: PostingDraftNote | undefined
  /** A video is attached to some post of the compose (8.5). */
  hasVideo: boolean
  /** Bumped by every account change and restore; stale reads are dropped. */
  generation: number
}

const IDLE: PostingState = {
  active: false,
  currentDid: undefined,
  currentHandle: undefined,
  did: undefined,
  handle: undefined,
  members: [],
  heldMembers: undefined,
  touched: false,
  hold: {kind: 'none'},
  resetPending: false,
  data: undefined,
  settings: undefined,
  draftNote: undefined,
  hasVideo: false,
  generation: 0,
}

let state: PostingState = IDLE
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function subscribePosting(listener: () => void) {
  return subscribe(listener)
}

export function getPostingState(): PostingState {
  return state
}

/** Replace parts of the record; listeners are called. */
export function updatePosting(change: Partial<PostingState>) {
  const next = {...state, ...change}
  state = next
  listeners.forEach(listener => listener())
}

/** The record, kept current. */
export function usePostingState(): PostingState {
  return useSyncExternalStore(subscribe, getPostingState)
}

/** Start a compose session as `did` (the composer opening). */
export function startPostingRecord(did: string, handle: string | undefined) {
  state = {
    ...IDLE,
    active: true,
    currentDid: did,
    currentHandle: handle,
    did,
    handle,
    generation: state.generation + 1,
  }
  listeners.forEach(listener => listener())
}

/** End the compose session (the composer closing). */
export function endPostingRecord() {
  state = {...IDLE, generation: state.generation + 1}
  listeners.forEach(listener => listener())
}

/** Test-only: forget everything. */
export function resetPostingRecord() {
  state = IDLE
  listeners.forEach(listener => listener())
}

/** Whether the compose posts from an account other than the current one. */
export function isPostingAsOther(s: PostingState = state): boolean {
  return s.active && !!s.did && s.did !== s.currentDid
}

/**
 * Whether the posting account lets Publish through: nothing pending,
 * failed or signed out, and no reset waiting to apply. A value for
 * `canPost`, through {@link usePostingAllows}.
 */
export function postingAllowsFor(s: PostingState): boolean {
  if (!s.active) return true
  return s.hold.kind === 'none' && !s.resetPending && !s.heldMembers
}

function getPostingAllows(): boolean {
  return postingAllowsFor(state)
}

/**
 * `false` while the posting account's hold is on (8.2), kept current: a
 * subscription, so `canPost` takes it as a value and React Compiler never
 * keeps a stale `true` (P5R7-N1).
 */
export function usePostingAllows(): boolean {
  return useSyncExternalStore(subscribe, getPostingAllows)
}

function getResetPending(): boolean {
  return state.active && state.resetPending
}

/** Whether a reset is waiting to apply (non-React). */
export function isResetPending(): boolean {
  return getResetPending()
}

/** Whether a reset is waiting to apply, kept current. */
export function useIsResetPending(): boolean {
  return useSyncExternalStore(subscribe, getResetPending)
}

function getPostingAsCurrent(): boolean {
  return !isPostingAsOther()
}

/**
 * Whether the compose posts from the current account, kept current (the
 * stock interaction dialog's "Save these options", PA-12a).
 */
export function useIsPostingAsCurrent(): boolean {
  return useSyncExternalStore(subscribe, getPostingAsCurrent)
}

function getPostingHeld(): boolean {
  return state.active && state.hold.kind === 'pending'
}

/** Whether the posting account's reads are in flight (the Post spinner). */
export function useIsPostingHeld(): boolean {
  return useSyncExternalStore(subscribe, getPostingHeld)
}
