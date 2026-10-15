/*
 * What the sign-in form shows about an earlier OAuth attempt on this page
 * load: a callback error, or a sign-in that left for the server and never
 * came back. Module state, so a remount of the form keeps them.
 */

import {
  consumeOAuthCallbackError,
  type PendingSignIn,
} from '#/horizon/session/oauth-return-url'

let stalled: PendingSignIn | undefined
let callbackError: string | undefined

/**
 * Remember a sign-in that never returned (read at launch by `HorizonHost`).
 */
export function setStalledSignIn(record: PendingSignIn | undefined) {
  stalled = record
}

/**
 * The sign-in that never returned, if any.
 */
export function getStalledSignIn(): PendingSignIn | undefined {
  return stalled
}

/**
 * Forget the stalled sign-in (the user tried again or signed in).
 */
export function clearStalledSignIn() {
  stalled = undefined
}

/**
 * The error a failed callback left for the form. Taken from session storage
 * into module state, so a remount of the form still shows it.
 */
export function getCallbackError(): string | undefined {
  const fresh = consumeOAuthCallbackError()
  if (fresh) callbackError = fresh
  return callbackError
}

/**
 * Forget the callback error (superseded by a new attempt).
 */
export function clearCallbackError() {
  callbackError = undefined
}
