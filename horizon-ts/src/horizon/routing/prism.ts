/*
 * prism, Horizon's AppView: fixed and always connected, beside the public
 * AppView.
 */

import {type Client, type Service} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'

import {createLexClient} from '#/lib/lexClient'
import {useMaybePdsClient} from '#/state/session'
import {networkAwareFetch} from '#/state/session/network'

/**
 * prism's DID. `EXPO_PUBLIC_PRISM_DID` overrides it for development.
 */
export const PRISM_DID = (process.env.EXPO_PUBLIC_PRISM_DID ||
  'did:web:prism.nearhorizon.app') as DidString

/**
 * The `atproto-proxy` target for calls proxied to prism through the PDS.
 */
export const PRISM_SERVICE = `${PRISM_DID}#bsky_appview` as Service

/**
 * prism's URL, for signed-out calls made directly. `EXPO_PUBLIC_PRISM_URL`
 * overrides it for development.
 */
export const PRISM_URL: string =
  process.env.EXPO_PUBLIC_PRISM_URL || 'https://prism.nearhorizon.app'

const prismClients = new WeakMap<Client, Client>()

/**
 * The signed-in prism client for a bundle, either session kind: the bundle's
 * own PDS agent (no device headers, no proxy) with `atproto-proxy` set to
 * prism. The PDS mints the service token; the client holds no prism token.
 * Cached against the PDS client, so it lives and dies with the bundle.
 */
export function getPrismClient(pdsClient: Client): Client {
  let client = prismClients.get(pdsClient)
  if (!client) {
    client = createLexClient(pdsClient.agent, {
      service: PRISM_SERVICE,
      appLabelers: null,
    })
    prismClients.set(pdsClient, client)
  }
  return client
}

let signedOutClient: Client | undefined

/**
 * The signed-out prism client, for prism's public reads only. It sends no
 * device headers and no `Authorization`: prism's CORS allows neither the
 * device headers nor anything but `authorization`, `content-type`,
 * `atproto-proxy` and `atproto-accept-labelers`, and an invalid bearer on an
 * optional-auth route is a 401, not an anonymous read.
 */
export function getSignedOutPrismClient(): Client {
  return (signedOutClient ??= createLexClient(
    {service: PRISM_URL, fetch: networkAwareFetch},
    {appLabelers: null},
  ))
}

/**
 * The prism client for the current session, or the signed-out one.
 */
export function usePrismClient(): Client {
  const pdsClient = useMaybePdsClient()
  return pdsClient ? getPrismClient(pdsClient) : getSignedOutPrismClient()
}
