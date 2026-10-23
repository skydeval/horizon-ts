/*
 * Thread mutes with prism (2H design 7, P-16, H-5).
 *
 * - A private thread root is muted and unmuted on prism only (Mute 1, Mute
 *   3): the public AppView holds no private thread, and prism serves
 *   `app.bsky.graph.muteThread` and `unmuteThread` for any root.
 * - A public root's mute and unmute are also sent to prism for a member
 *   (Mute 2, Mute 4, fire and forget): prism drops private notifications by
 *   each reply's own `reply.root`, so a private branch under a muted public
 *   thread would otherwise still notify.
 * - Re-sync (H-5): where a read shows Bluesky's mute state of a public root
 *   beside prism's, and they differ, prism is moved to Bluesky's, so a public
 *   thread muted or unmuted in another client follows on prism.
 *
 * Every write here needs `private.interactions` answered in this run (4.7).
 */

import {type AtUriString} from '@atproto/syntax'

import {logger} from '#/logger'
import {reportedPrismWrite} from '#/horizon/private/api/reads'
import {privateInteractionsServed} from '#/horizon/private/server-support'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {
  getCurrentClients,
  requireCurrentClients,
} from '#/horizon/routing/current-clients'
import {isPrivateMember} from '#/horizon/routing/membership'
import {PRIVATE_READING} from '#/horizon/switches'
import {app} from '#/lexicons'

/**
 * Mute or unmute the thread at `rootUri` on prism with the current account's
 * prism client. Resolves to `{}`, as the stock mutation's call does; throws
 * as the call does.
 */
export async function muteThreadOnPrism(
  rootUri: string,
  mute: boolean,
): Promise<{}> {
  const prism = requireCurrentClients().prismClient
  const root = rootUri as AtUriString
  if (mute) {
    await reportedPrismWrite(app.bsky.graph.muteThread.main, {
      send: () => prism.call(app.bsky.graph.muteThread, {root}),
    })
  } else {
    await reportedPrismWrite(app.bsky.graph.unmuteThread.main, {
      send: () => prism.call(app.bsky.graph.unmuteThread, {root}),
    })
  }
  return {}
}

/**
 * Whether a public root's mute is mirrored to prism for the current account:
 * `PRIVATE_READING` on, a member, and prism's thread mutes answered in this
 * run.
 */
function mirrors(rootUri: string): boolean {
  if (!PRIVATE_READING || isPrivatePostUri(rootUri)) return false
  const did = getCurrentClients()?.did
  return isPrivateMember(did) && privateInteractionsServed({forWrite: true})
}

function sendQuietly(rootUri: string, mute: boolean, why: string) {
  muteThreadOnPrism(rootUri, mute).catch((error: unknown) => {
    logger.warn(why, {rootUri, mute, safeMessage: error})
  })
}

/**
 * After the stock mutation muted or unmuted the public thread at `rootUri`
 * on the public AppView (Mute 2, Mute 4): the same on prism, for a member,
 * fire and forget. A failure is logged and never fails the mutation.
 */
export function mirrorThreadMute(rootUri: string | undefined, mute: boolean) {
  if (!rootUri || !mirrors(rootUri)) return
  sendQuietly(rootUri, mute, 'thread mute: mirror to prism failed')
}

/** Roots re-synced in this run, per account, so a read never repeats the write. */
const resynced = new Map<string, boolean>()

/**
 * A read showed the public root `rootUri` as Bluesky's AppView has it
 * (`stockMuted`, the stock view's `viewer.threadMuted`) and as prism has it
 * (`prismMuted`, a private reply's `viewer.threadMuted` under that root).
 * When both are known and differ, prism is moved to Bluesky's state (H-5),
 * once per root and state in this run.
 */
export function resyncPublicThreadMute(
  rootUri: string,
  stockMuted: boolean | undefined,
  prismMuted: boolean | undefined,
) {
  if (stockMuted === undefined || prismMuted === undefined) return
  if (stockMuted === prismMuted || !mirrors(rootUri)) return
  const key = `${getCurrentClients()?.did}|${rootUri}`
  if (resynced.get(key) === stockMuted) return
  resynced.set(key, stockMuted)
  sendQuietly(rootUri, stockMuted, 'thread mute: re-sync to prism failed')
}

/**
 * Forget the re-sync record (tests, account change).
 */
export function resetThreadMuteResync() {
  resynced.clear()
}
