/*
 * The Private notifications list reads prism directly rather than through
 * the reader's PDS, so the list and its posts skip the proxy hop and never
 * pass the PDS. prism checks a direct call exactly as it checks getPosts:
 * the service token's signature against the reader's DID document, aud,
 * lxm (the one method) and exp. When no token can be had (a PDS that won't
 * mint one, a rate limit), the read goes through the PDS as before.
 */

import {useEffect} from 'react'
import {AppState} from 'react-native'
import {type Client} from '@atproto/lex'
import {type NsidString} from '@atproto/syntax'

import {getCurrentClients} from '#/horizon/routing/current-clients'
import {
  type DirectPrefetchOptions,
  getDirectPrismClient,
  getDirectPrismToken,
  PRIVATE_GET_POSTS_LXM,
  startDirectTokenPrefetch,
} from '#/horizon/routing/prism-direct'

/**
 * prism's private notifications list.
 */
export const PRIVATE_LIST_NOTIFICATIONS_LXM =
  'app.nearhorizon.private.listNotifications' as NsidString

/**
 * The list's tokens, minted ahead and kept fresh while the app is in the
 * foreground, so opening the list has no minting hop. Every posting route:
 * these are reads.
 */
export const NOTIFICATIONS_DIRECT_PREFETCH: DirectPrefetchOptions = {
  methods: [PRIVATE_LIST_NOTIFICATIONS_LXM, PRIVATE_GET_POSTS_LXM],
  routes: 'any',
}

/**
 * The client to call `lxm` with for `source`'s account: prism directly when
 * a token is cached or can be minted, else `source.prism` (through the PDS).
 */
export async function privateReadClient(
  source: {did: string; prism: Client},
  lxm: NsidString,
): Promise<Client> {
  const current = getCurrentClients()
  if (!current || current.did !== source.did) return source.prism
  try {
    await getDirectPrismToken(current.pdsClient, lxm)
  } catch {
    return source.prism
  }
  return getDirectPrismClient(current.pdsClient)
}

/**
 * Mints the list's tokens ahead while `active` (a member with the private
 * notifications list) and the app is in the foreground.
 */
export function usePrivateNotificationsTokenPrefetch(active: boolean) {
  useEffect(() => {
    if (!active) return
    return startDirectTokenPrefetch(NOTIFICATIONS_DIRECT_PREFETCH, {
      isForeground: () => AppState.currentState === 'active',
      subscribe: listener => {
        const subscription = AppState.addEventListener('change', listener)
        return () => subscription.remove()
      },
    })
  }, [active])
}
