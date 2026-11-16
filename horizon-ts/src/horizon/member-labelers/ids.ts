/*
 * Member labeler ids. Kept apart from the rest so the request guard, which
 * every lex client loads, imports nothing else.
 */

/** What the member labelers' ids look like. */
export const MEMBER_LABELER_ID =
  /^did:web:[^:/?#\s]+(?::[^:/?#\s]+)*:labeler:[^:/?#\s]+$/

let known = new Set<string>()

/** The ids prism listed for the current account. */
export function setKnownMemberLabelerIds(ids: Iterable<string>) {
  known = new Set(ids)
}

/**
 * Whether `did` names a member labeler: one prism listed, or any id of their
 * shape (so nothing slips out before the list arrives).
 */
export function isMemberLabelerId(did: string | undefined): boolean {
  if (!did) return false
  return known.has(did) || MEMBER_LABELER_ID.test(did)
}
