/*
 * Saved-feed ids on the account's own TID counter (Phase 5 design, Appendix
 * A, P5R4-N2). Apart from `index.ts` because it reads the current account
 * from `#/horizon/routing/current-clients`, which imports React.
 */
import {TID} from '@atproto/common-web'

import {getCurrentDid} from '#/horizon/routing/current-clients'
import {nextTidStr} from '#/horizon/tid-clock'

/**
 * A saved-feed id for `did`'s preferences, minted on that account's own
 * counter. Without `did`, the current account's. Not a record key.
 */
export function nextPreferenceId(did?: string): string {
  const owner = did ?? getCurrentDid()
  if (owner !== undefined) {
    return nextTidStr(owner)
  }
  /*
   * Every caller is a signed-in screen, so this does not happen in practice.
   * A preference id never reaches a repo, so stock is fine here, and failing
   * a feed save over it would help no one.
   */
  return TID.nextStr()
}
