/*
 * What a person types to sign in, made into what the OAuth client accepts: a
 * handle, a DID or a server address. The client takes only a bare handle, so
 * an `@` in front, or the invisible direction marks a handle carries when it
 * is copied from a profile, made a valid handle fail as "invalid" while the
 * DID worked (a tester, 2026-10-27).
 */

/*
 * Zero-width and direction-control characters: U+200B to U+200F, U+202A to
 * U+202E, U+2060 to U+2069 and U+FEFF. Copied text often carries them.
 */
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g

/** A profile link: bsky.app, Horizon or any app's `/profile/<name>` page. */
const PROFILE_LINK = /^https?:\/\/[^/]+\/profile\/([^/?#]+)/i

/**
 * `input` as the sign-in field should send it: invisible characters and
 * surrounding space removed; a pasted profile link becomes its handle or
 * DID; a leading `@` is dropped; a handle is lowercased. A server address
 * (`https://…` that isn't a profile link) and a DID are otherwise kept.
 */
export function cleanSignInIdentifier(input: string): string {
  let value = input.replace(INVISIBLE, '').trim()
  const profile = PROFILE_LINK.exec(value)
  if (profile) {
    try {
      value = decodeURIComponent(profile[1])
    } catch {
      value = profile[1]
    }
  }
  value = value.replace(/^@+/, '').trim()
  if (/^https?:\/\//i.test(value) || value.startsWith('did:')) return value
  return value.toLowerCase()
}
