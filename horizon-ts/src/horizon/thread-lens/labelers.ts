/*
 * The reader's labelers on the Thread Lens calls (prism `threadLens.labelers`,
 * prism #887).
 *
 * - The request. With the feature listed for the call's account, every
 *   `getThread` and `resolve` carries the `atproto-accept-labelers` value the
 *   account's stock AppView reads carry: the app-wide authorities with
 *   `;redact`, then the account's subscribed labelers, built as the lex
 *   client builds it. Only that header is added; the direct and the proxied
 *   call carry the same one (the PDS proxy forwards it to prism).
 * - The answer. prism names the labelers it applied in
 *   `atproto-content-labelers`. An answer whose header names every labeler
 *   sent is one whose post views carry the reader's labels
 *   (`readerLabels`); anything else (no header, a header prism ignored for
 *   its size, more labelers than prism takes, a labeler the upstream did not
 *   apply) reads as not applied, and labels come from the public-view pass
 *   alone, as before.
 */

import {type Client} from '@atproto/lex'
import {isValidDid} from '@atproto/syntax'

import {getCurrentClients} from '#/horizon/routing/current-clients'
import {servesFeature} from '#/horizon/routing/features'

/** The request header naming the reader's labelers. */
export const ACCEPT_LABELERS = 'atproto-accept-labelers'

/** The response header naming the labelers applied. */
export const CONTENT_LABELERS = 'atproto-content-labelers'

function entriesOf(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

/**
 * The `atproto-accept-labelers` value `client` sends on its own reads, as
 * the lex client builds it (`buildXrpcRequestHeaders`): its app labelers
 * (the class-wide ones unless the client sets its own) with `;redact`, its
 * labelers, then any its default headers name; `undefined` with none.
 */
export function stockLabelersHeader(client: Client): string | undefined {
  const own = client.xrpcDefaults.appLabelers
  const appLabelers =
    own === undefined ? (client.constructor as typeof Client).appLabelers : own
  const combined = new Set<string>()
  for (const did of appLabelers ?? []) combined.add(`${did};redact`)
  for (const did of client.labelers) combined.add(did)
  for (const entry of entriesOf(client.headers.get(ACCEPT_LABELERS))) {
    combined.add(entry)
  }
  return combined.size > 0 ? Array.from(combined).join(', ') : undefined
}

/**
 * The header value for a lens call of `did`: the stock reads' value when
 * prism lists `threadLens.labelers` for `did` and `did` is the current
 * account (whose AppView client holds its labelers); else `undefined`, and
 * the call carries none.
 */
export function lensLabelersHeader(did: string): string | undefined {
  if (!servesFeature('threadLens.labelers', did)) return undefined
  const clients = getCurrentClients()
  if (!clients || clients.did !== did) return undefined
  return stockLabelersHeader(clients.appviewClient)
}

function didsOf(value: string | null | undefined): Set<string> {
  const dids = new Set<string>()
  for (const entry of entriesOf(value)) {
    const did = entry.split(';')[0].trim()
    if (isValidDid(did)) dids.add(did)
  }
  return dids
}

/**
 * Whether an answer to a call that sent `sent` carries the reader's labels:
 * its `atproto-content-labelers` (`applied`) names every labeler `sent`
 * named.
 */
export function lensLabelsApplied(
  sent: string | undefined,
  applied: string | null | undefined,
): boolean {
  const asked = didsOf(sent)
  if (asked.size === 0) return false
  const named = didsOf(applied)
  for (const did of asked) {
    if (!named.has(did)) return false
  }
  return true
}
