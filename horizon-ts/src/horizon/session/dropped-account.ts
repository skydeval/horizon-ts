/*
 * Quick reconnect: when an account's session ends, the signed-out view opens
 * straight on that account's sign-in form (handle filled in) instead of the
 * account list, so signing back in is one tap.
 *
 * The logged-out view's state is rebuilt when the current account changes
 * (App's keyed tree), so the dropped account is noted here, outside React,
 * and read when that state is created. A note is used only for a short
 * while, so a later visit to the signed-out view starts as usual.
 */

/** How long after a drop the signed-out view still opens on it. */
const NOTE_MS = 15_000

let note: {did: string; at: number} | undefined

/** Note that `did`'s session just ended. */
export function noteDroppedAccount(did: string, now: number = Date.now()) {
  note = {did, at: now}
}

/** The account whose session ended moments ago, if any. */
export function recentDroppedAccount(
  now: number = Date.now(),
): string | undefined {
  if (!note || now - note.at > NOTE_MS) return undefined
  return note.did
}

/** Tests: forget the note. */
export function resetDroppedAccount() {
  note = undefined
}
