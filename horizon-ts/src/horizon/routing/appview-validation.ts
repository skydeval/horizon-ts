/*
 * Validating a custom public AppView for the switcher.
 *
 * Adapted from the Witchsky client (MIT),
 * src/screens/Login/components/AppServerDialog.tsx (normalise, `did:web`,
 * `#bsky_appview` of type `BskyAppView`, the PDS probe); prism is refused.
 */

import {createServiceClient} from '#/lib/lexClient'
import {
  type DidDocument,
  didWebFromUrl,
  fetchDidWebDocument,
  findService,
  normalizeAppViewUrl,
} from '#/horizon/routing/did-web'
import {PRISM_DID} from '#/horizon/routing/prism'
import {type PublicAppviewChoice} from '#/horizon/routing/public-appview'
import {com} from '#/lexicons'

/**
 * prism's production DID, which can never be the public AppView.
 */
const HORIZON_PRISM_DID = 'did:web:prism.nearhorizon.app'

/**
 * Whether a DID is prism's (the production DID or the development override).
 */
export function isPrismDid(did: string): boolean {
  return did === HORIZON_PRISM_DID || did === PRISM_DID
}

/**
 * The outcome of validating a custom public AppView.
 */
export type AppViewValidation =
  | {ok: true; choice: PublicAppviewChoice}
  | {ok: false; reason: 'empty' | 'invalid' | 'prism' | 'pds' | 'not-found'}

/**
 * What validation needs from the network; injectable for tests.
 */
export type AppViewValidationDeps = {
  fetchDocument: (did: string) => Promise<DidDocument | undefined>
  answersDescribeServer: (url: string) => Promise<boolean>
}

async function answersDescribeServer(url: string) {
  try {
    await createServiceClient(url).call(com.atproto.server.describeServer, {})
    return true
  } catch {
    return false
  }
}

const defaultDeps: AppViewValidationDeps = {
  fetchDocument: fetchDidWebDocument,
  answersDescribeServer,
}

/**
 * Validate a typed public AppView address: normalise it, derive its
 * `did:web`, refuse prism, and require a `#bsky_appview` service of type
 * `BskyAppView` in its DID document. An address with no AppView that has a
 * PDS service or answers `describeServer` is a PDS.
 */
export async function validatePublicAppview(
  input: string,
  deps: AppViewValidationDeps = defaultDeps,
): Promise<AppViewValidation> {
  const url = normalizeAppViewUrl(input)
  if (!url) return {ok: false, reason: 'empty'}
  const did = didWebFromUrl(url)
  if (!did) return {ok: false, reason: 'invalid'}
  if (isPrismDid(did)) return {ok: false, reason: 'prism'}
  const doc = await deps.fetchDocument(did)
  const appview = findService(doc, '#bsky_appview', 'BskyAppView')
  if (appview && typeof appview.serviceEndpoint === 'string') {
    return {ok: true, choice: {did, url: appview.serviceEndpoint}}
  }
  if (
    findService(doc, '#atproto_pds', 'AtprotoPersonalDataServer') ||
    (await deps.answersDescribeServer(url))
  ) {
    return {ok: false, reason: 'pds'}
  }
  return {ok: false, reason: 'not-found'}
}
