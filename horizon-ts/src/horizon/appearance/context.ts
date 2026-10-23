/*
 * What the record step (`record-step.ts`) and the removal flow
 * (`removal.ts`) get from the per-account queue in `sync.ts`: the account's
 * clients, its copy, and the queue's own reads, so prism answers go through
 * the late-read rule (storage choice design 5.4) wherever they come from.
 */

import {type Client} from '@atproto/lex'

import {type AccountCopy} from '#/horizon/appearance/device-value'
import {type PrismAppearanceAnswer} from '#/horizon/appearance/prism'
import {type RecordAnswer} from '#/horizon/appearance/resolve'

export type AppearanceQueueContext = {
  did: string
  /** The account's PDS client. */
  client: Client
  getCopy: () => AccountCopy | undefined
  update: (change: (copy: AccountCopy) => AccountCopy) => void
  /**
   * Read `getAppearance` and apply it (section 4). Resolves to the latest
   * applied answer (this one, or a later-sent one already applied), or
   * undefined when the read failed.
   */
  readPrism: () => Promise<PrismAppearanceAnswer | undefined>
  /** Read the record, without applying it. Undefined when unanswered. */
  readRecord: () => Promise<RecordAnswer | undefined>
  /** Remember what this queue now knows the record to be. */
  setRecordRead: (answer: RecordAnswer) => void
  /** Whether the account is still the signed-in one, on the same client. */
  stillCurrent: () => boolean
  /** Whether the member table still applies in this run. */
  stillMember: () => boolean
  /** Run the queue again (a warning's retry action). */
  retry: () => void
  /** Today's "could not be saved to your account" toast, once per run. */
  showBlocked: () => void
}
