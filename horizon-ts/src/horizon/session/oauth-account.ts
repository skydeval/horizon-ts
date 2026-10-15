/*
 * The persisted account for an OAuth session.
 *
 * Adapted from the Witchsky client (MIT), src/state/session/oauth-agent.ts
 * (the account mapping: issuer as `service`, `aud` as `pdsUrl`,
 * `isOauthSession`).
 */

import {BSKY_SERVICE} from '#/lib/constants'
import {type SessionAccount} from '#/state/session/types'

/**
 * The `com.atproto.server.getSession` fields the account takes.
 */
export type GetSessionOutput = {
  did: string
  handle: string
  email?: string
  emailConfirmed?: boolean
  emailAuthFactor?: boolean
  active?: boolean
  status?: string
}

/**
 * Build the persisted account for an OAuth session.
 *
 * The field order is that of `sessionDataToSessionAccount`
 * (`src/state/session/session-data.ts`), because the reducer compares accounts
 * with `JSON.stringify`. `service` is the authorization server (it serves
 * `describeServer` and the email checks), `pdsUrl` the resource server the
 * tokens are for. No tokens are stored: they live in the OAuth library.
 */
export function oauthAccountFrom(
  session: {issuer: string; aud: string},
  data: GetSessionOutput,
): SessionAccount {
  const service = new URL(session.issuer).toString()
  return {
    service,
    did: data.did as SessionAccount['did'],
    handle: data.handle,
    email: data.email,
    emailConfirmed: data.emailConfirmed || false,
    emailAuthFactor: data.emailAuthFactor || false,
    refreshJwt: undefined,
    accessJwt: undefined,
    signupQueued: false,
    active: data.active,
    status: data.status,
    pdsUrl: new URL(session.aud).toString(),
    isSelfHosted: !service.startsWith(BSKY_SERVICE),
    isOauthSession: true,
  }
}
