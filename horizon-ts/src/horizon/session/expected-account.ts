/*
 * The account an OAuth sign-in was started for, and the check that the
 * authorization server signed in that account and not another.
 *
 * The library sends the requested handle as `login_hint`, but a server may
 * ignore it and authorize whichever account is signed in to its own web pages
 * (aurora-locus does). The library checks only that the issuer matches, which
 * passes when both accounts live on the same server, so Horizon checks the
 * returned DID itself.
 */

import {type OAuthSession} from '@atproto/oauth-client-browser'

import {getOAuthClient} from '#/horizon/session/oauth-client'

/**
 * The DID the user asked to sign in as, or `undefined` when the identifier
 * names a server (no particular account) or cannot be resolved here (the
 * library then reports the failure itself).
 */
export async function resolveExpectedDid(
  identifier: string,
): Promise<string | undefined> {
  const value = identifier.trim()
  if (!value || /^https?:\/\//i.test(value)) return undefined
  if (value.startsWith('did:')) return value
  try {
    const identity = await getOAuthClient().identityResolver.resolve(value)
    return identity.did
  } catch {
    return undefined
  }
}

/**
 * The OAuth `state` carrying the expected DID through a page-mode round trip.
 */
export function encodeExpectedDidState(did: string | undefined) {
  return did ? JSON.stringify({expectedDid: did}) : undefined
}

/**
 * The expected DID from a callback's `state`, if any.
 */
export function decodeExpectedDidState(
  state: string | null | undefined,
): string | undefined {
  if (!state) return undefined
  try {
    const value: unknown = JSON.parse(state)
    if (
      value &&
      typeof value === 'object' &&
      'expectedDid' in value &&
      typeof value.expectedDid === 'string'
    ) {
      return value.expectedDid
    }
  } catch {
    // Not Horizon's state: no expectation.
  }
  return undefined
}

/**
 * The server signed in a different account from the one asked for.
 */
export class AccountMismatchError extends Error {
  constructor(
    readonly expectedDid: string,
    readonly actualDid: string,
    readonly expectedHandle: string | undefined,
    readonly actualHandle: string | undefined,
  ) {
    super(`OAuth signed in ${actualDid}, not the requested ${expectedDid}`)
    this.name = 'AccountMismatchError'
  }
}

async function handleFor(did: string): Promise<string | undefined> {
  try {
    const identity = await getOAuthClient().identityResolver.resolve(did)
    return identity.handle === 'handle.invalid' ? undefined : identity.handle
  } catch {
    return undefined
  }
}

/**
 * Throw {@link AccountMismatchError} when `session` is not for `expectedDid`.
 * The mismatched session is signed out first, unless `keepDid` says Horizon
 * already holds that account (its stored session must not be lost).
 */
export async function assertExpectedAccount(
  session: OAuthSession,
  expectedDid: string | undefined,
  keepDid: (did: string) => boolean,
) {
  if (!expectedDid || session.did === expectedDid) return
  const actualDid = session.did
  if (!keepDid(actualDid)) {
    try {
      await session.signOut()
    } catch {
      // Revocation is best effort; the local session is deleted either way.
    }
  }
  const [expectedHandle, actualHandle] = await Promise.all([
    handleFor(expectedDid),
    handleFor(actualDid),
  ])
  throw new AccountMismatchError(
    expectedDid,
    actualDid,
    expectedHandle,
    actualHandle,
  )
}
