/*
 * The stock mute mutations' hooks into the device's mute copy
 * (`mutes/cache.ts`). The account is the one current when the mutation
 * starts, so a mutation that answers after an account switch changes only
 * the copy of the account that made it.
 */

import {type Client} from '@atproto/lex'

import {noteAccountMute, noteListMute} from '#/horizon/mutes/cache'
import {getCurrentDid} from '#/horizon/routing/current-clients'

async function tracked<T>(
  settle: ((ok: boolean) => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const result = await run()
    settle?.(true)
    return result
  } catch (error) {
    settle?.(false)
    throw error
  }
}

/**
 * Run a full mute (`muted`) or an unmute of `subject`, the device copy
 * changed at once and put back if `run` fails.
 */
export function withAccountMuteNoted<T>(
  subject: string,
  muted: boolean,
  run: () => Promise<T>,
): Promise<T> {
  const did = getCurrentDid()
  return tracked(did ? noteAccountMute(did, subject, muted) : undefined, run)
}

/**
 * Run a mute list subscribe (`muted`) or unsubscribe of `uri`, the device
 * copy changed at once (a subscribe once its members are read with
 * `appview`) and put back if `run` fails.
 */
export function withListMuteNoted<T>(
  uri: string,
  muted: boolean,
  appview: Client,
  run: () => Promise<T>,
): Promise<T> {
  const did = getCurrentDid()
  return tracked(did ? noteListMute(did, uri, muted, appview) : undefined, run)
}
