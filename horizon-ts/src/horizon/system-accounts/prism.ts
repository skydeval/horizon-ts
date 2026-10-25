/*
 * The five system-account calls and the proof (system accounts design 5.2,
 * 5.3, SA-4, SA-18):
 *
 * - Every call goes **direct** to prism, never through a PDS proxy: the read
 *   through the cached direct client, the three writes through the one-shot
 *   client (a fresh token per request, no `exp`, never cached). Only
 *   `getServiceAuth` goes through the PDS, carrying only the `lxm`.
 * - The proof is a one-shot token minted by the added account's own PDS for
 *   the proof-only `lxm` `confirmSystemAccount`.
 * - In the one-shot mode a 401 is not resent with the same body; the add
 *   re-mints both its bearer and its proof and sends once more (SAR3-N5).
 * - prism's reply (`docs/internal/handoff/prism-system-accounts-reply.md`):
 *   `rev` is an integer; `501 MethodNotImplemented` means the feature is
 *   off (`unavailable`); a 429 from the `system_accounts` rate class (1/s,
 *   burst 20, writes cost 4) holds every call for that caller until its
 *   `Retry-After`, so no retry spends the class.
 *
 * The transport is replaceable (`setSystemAccountsApi`) for tests, and in a
 * development build the `SYSTEM_ACCOUNTS_DEV_STUB` switch answers from an
 * in-memory stand-in.
 */

import {type Client, XrpcResponseError} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'

import {IS_DEV} from '#/env'
import {nearhorizon} from '#/horizon/lexicons'
import {
  DirectPrismRateLimitedError,
  getDirectPrismClient,
  getOneShotPrismClient,
  mintOneShotPrismToken,
  rateLimitWaitMs,
} from '#/horizon/routing/prism-direct'
import {SYSTEM_ACCOUNTS_DEV_STUB} from '#/horizon/switches'
import {stubSystemAccountsApi} from './prism-stub'
import {
  CONFIRM_SYSTEM_ACCOUNT_LXM,
  type SystemAccountsApi,
  SystemAccountsError,
} from './prism-types'

export {
  CONFIRM_SYSTEM_ACCOUNT_LXM,
  type SystemAccountsApi,
  SystemAccountsError,
  type SystemAccountsFailure,
} from './prism-types'

/**
 * The wait after a prism 429 whose headers are missing (prism's rate class
 * `system_accounts`: 1/s, burst 20, writes cost 4).
 */
export const SYSTEM_ACCOUNTS_LIMIT_DEFAULT_MS = 4_000

/** No system-account call to prism for this caller DID before this time. */
const limitedUntil = new Map<string, number>()

function callerOf(pdsClient: Client): string {
  try {
    return pdsClient.assertDid
  } catch {
    return ''
  }
}

/**
 * Refuse, without sending, a call for a caller prism asked to wait (its
 * `Retry-After` or `ratelimit-reset`), so no retry spends its rate class.
 */
function assertNotLimited(caller: string) {
  const retryAt = limitedUntil.get(caller)
  if (retryAt === undefined) return
  if (retryAt > Date.now()) throw new SystemAccountsError('limited', retryAt)
  limitedUntil.delete(caller)
}

function classify(
  error: unknown,
  sent: boolean,
  caller: string,
): SystemAccountsError {
  if (error instanceof SystemAccountsError) return error
  if (error instanceof DirectPrismRateLimitedError) {
    return new SystemAccountsError('limited', error.retryAt)
  }
  if (error instanceof XrpcResponseError) {
    if (error.status === 429 || error.error === 'RateLimitExceeded') {
      const retryAt =
        Date.now() +
        rateLimitWaitMs(error.headers, SYSTEM_ACCOUNTS_LIMIT_DEFAULT_MS)
      if (caller) limitedUntil.set(caller, retryAt)
      return new SystemAccountsError('limited', retryAt)
    }
    // prism's answer while the feature is off, before auth (its reply).
    if (error.status === 501 || error.error === 'MethodNotImplemented') {
      return new SystemAccountsError('unavailable')
    }
    if (error.status >= 500) {
      return new SystemAccountsError(sent ? 'unknown' : 'unreachable')
    }
    switch (error.error) {
      case 'InvalidProof':
        return new SystemAccountsError('proof')
      case 'ListFull':
        return new SystemAccountsError('full')
      default:
        return new SystemAccountsError('refused')
    }
  }
  return new SystemAccountsError(
    sent ? 'unknown' : 'unreachable',
    undefined,
    error,
  )
}

function is401(error: unknown): boolean {
  return error instanceof XrpcResponseError && error.status === 401
}

/**
 * A one-shot write: re-minted and sent once more on a 401 only (a 401 is
 * refused before prism's commit and before its rate class is the reason),
 * never on a 429, and never while the caller is held back.
 */
async function oneShot<T>(caller: string, send: () => Promise<T>): Promise<T> {
  assertNotLimited(caller)
  try {
    return await send()
  } catch (error) {
    if (!is401(error)) throw classify(error, true, caller)
  }
  try {
    return await send()
  } catch (error) {
    throw classify(error, true, caller)
  }
}

/** A read, once. */
async function read<T>(caller: string, send: () => Promise<T>): Promise<T> {
  assertNotLimited(caller)
  try {
    return await send()
  } catch (error) {
    throw classify(error, false, caller)
  }
}

const directApi: SystemAccountsApi = {
  async getSystemAccounts(pdsClient) {
    const out = await read(callerOf(pdsClient), () =>
      getDirectPrismClient(pdsClient).call(
        nearhorizon.accountGetSystemAccounts,
        {},
      ),
    )
    return {
      accounts: out.accounts.map(a => ({did: a.did, addedAt: a.addedAt})),
      // An integer on the wire; the cache keeps it as decimal text.
      rev: String(out.rev),
    }
  },
  async addSystemAccount(pdsClient, account, mintProof) {
    const caller = callerOf(pdsClient)
    const out = await oneShot(caller, async () => {
      // Both mints and the call run back to back (5.3).
      const proof = await mintProof().catch(error => {
        throw classify(error, false, caller)
      })
      return getOneShotPrismClient(pdsClient).call(
        nearhorizon.accountAddSystemAccount,
        {account: account as DidString, proof},
      )
    })
    return {rev: String(out.rev)}
  },
  async removeSystemAccount(pdsClient, account) {
    const out = await oneShot(callerOf(pdsClient), () =>
      getOneShotPrismClient(pdsClient).call(
        nearhorizon.accountRemoveSystemAccount,
        {account: account as DidString},
      ),
    )
    return {rev: String(out.rev)}
  },
  async getSystemAccountStatus(pdsClient) {
    const out = await read(callerOf(pdsClient), () =>
      getDirectPrismClient(pdsClient).call(
        nearhorizon.accountGetSystemAccountStatus,
        {},
      ),
    )
    return {registered: out.registered}
  },
  async leaveSystemAccounts(pdsClient) {
    await oneShot(callerOf(pdsClient), () =>
      getOneShotPrismClient(pdsClient).call(
        nearhorizon.accountLeaveSystemAccounts,
        {},
      ),
    )
  },
  mintProof(addedPdsClient) {
    return mintOneShotPrismToken(addedPdsClient, CONFIRM_SYSTEM_ACCOUNT_LXM)
  },
}

let override: SystemAccountsApi | undefined

/** Test-only: answer every call from `api` (undefined resets). */
export function setSystemAccountsApi(api: SystemAccountsApi | undefined) {
  override = api
}

/** Test-only: forget the rate-limit holds. */
export function resetSystemAccountsLimits() {
  limitedUntil.clear()
}

/** Whether the development stand-in answers (development builds only). */
export function systemAccountsStubActive(isDev: boolean = IS_DEV): boolean {
  return isDev && SYSTEM_ACCOUNTS_DEV_STUB
}

/** The calls in use now. */
export function systemAccountsApi(): SystemAccountsApi {
  if (override) return override
  if (systemAccountsStubActive()) return stubSystemAccountsApi
  return directApi
}
