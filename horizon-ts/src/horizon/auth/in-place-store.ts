/*
 * The in-place sign-in request store: one open request at a time. The window
 * itself is `InPlaceSignIn.tsx`; the store is a module of its own so the
 * sign-in form's parts can open a request without importing the window.
 *
 * Adapted from the Witchsky client (MIT),
 * src/state/session/ephemeral-login.ts (one request at a time, subscribe and
 * cancel). No promise and no credential check: the window is a plain
 * sign-in.
 */

import {useSyncExternalStore} from 'react'

import {type SessionAccount} from '#/state/session/types'

/**
 * An open in-place sign-in request.
 */
export type InPlaceSignInRequest = {
  account: SessionAccount
  /**
   * On web the stock switcher pushes `/` before it resumes; cancelling a
   * window opened after a failed resume goes back to undo that push.
   */
  undoUrlPush: boolean
}

let current: InPlaceSignInRequest | undefined
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The open request, if any.
 */
export function readInPlaceSignIn(): InPlaceSignInRequest | undefined {
  return current
}

/**
 * Open the in-place window for `account`, replacing any open request.
 */
export function openInPlaceSignIn(
  account: SessionAccount,
  {undoUrlPush = false}: {undoUrlPush?: boolean} = {},
) {
  current = {account, undoUrlPush}
  notify()
}

/**
 * Close the open request. A cancel (the user closed the window) leaves the
 * current account as it was and undoes the switcher's URL push.
 */
export function closeInPlaceSignIn({cancelled}: {cancelled: boolean}) {
  const request = current
  if (!request) return
  current = undefined
  notify()
  if (cancelled && request.undoUrlPush && typeof history !== 'undefined') {
    history.back()
  }
}

/**
 * The open request, kept current.
 */
export function useInPlaceSignInRequest() {
  return useSyncExternalStore(subscribe, readInPlaceSignIn)
}
