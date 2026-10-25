/*
 * The system-account calls' shape and errors (system accounts design 5.2,
 * 5.3), shared by the direct transport (`prism.ts`) and the development
 * stand-in (`prism-stub.ts`).
 */

import {type Client} from '@atproto/lex'
import {type NsidString} from '@atproto/syntax'

import {type ListAnswer} from './list-store'

/** The proof-only method name (5.2): no route serves it. */
export const CONFIRM_SYSTEM_ACCOUNT_LXM =
  'app.nearhorizon.account.confirmSystemAccount' as NsidString

/**
 * Why a call failed, as the dialogs say it (5.3):
 * - `unknown`: sent, no answer (a timeout, a network error, a 5xx): prism
 *   may have committed, so the list is read before reporting.
 * - `unreachable`: nothing was sent, or prism could not be reached.
 * - `proof`: the added account's server didn't confirm it.
 * - `full`: the cap.
 * - `limited`: a rate limit; `retryAt` when known. Nothing is sent to
 *   prism for that account before `retryAt`.
 * - `unavailable`: prism answers `501 MethodNotImplemented`, the feature
 *   is off there (prism's reply): not a crash, the section says so.
 * - `refused`: any other refusal.
 */
export type SystemAccountsFailure =
  | 'unknown'
  | 'unreachable'
  | 'proof'
  | 'full'
  | 'limited'
  | 'unavailable'
  | 'refused'

export class SystemAccountsError extends Error {
  constructor(
    readonly reason: SystemAccountsFailure,
    readonly retryAt?: number,
    /** What failed underneath, for the log only. */
    cause?: unknown,
  ) {
    super(`system accounts: ${reason}`, cause === undefined ? {} : {cause})
    this.name = 'SystemAccountsError'
  }
}

/** The calls, as the rest of the feature uses them. */
export type SystemAccountsApi = {
  getSystemAccounts(pdsClient: Client): Promise<ListAnswer>
  /** `mintProof` is called again for the one resend after a 401. */
  addSystemAccount(
    pdsClient: Client,
    account: string,
    mintProof: () => Promise<string>,
  ): Promise<{rev: string}>
  removeSystemAccount(
    pdsClient: Client,
    account: string,
  ): Promise<{rev: string}>
  getSystemAccountStatus(pdsClient: Client): Promise<{registered: boolean}>
  leaveSystemAccounts(pdsClient: Client): Promise<void>
  /** The proof, minted by the added account's own PDS client. */
  mintProof(addedPdsClient: Client): Promise<string>
}
