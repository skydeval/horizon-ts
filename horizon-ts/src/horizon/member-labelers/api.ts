/*
 * prism's methods for member labelers: labelers that exist only for Horizon
 * members, with no account, host or DID document anywhere on the network.
 *
 * - Called straight at prism with a service token from the member's own PDS,
 *   never through the PDS proxy, and with the direct header prism needs
 *   before it answers as for a member.
 * - Anything that names a labeler goes in a POST body, never a URL.
 * - prism answers anyone it won't serve (not a member, no token, through a
 *   proxy) with an empty answer and 200, so empty means "nothing for you".
 *
 * Nothing an answer carries is logged here.
 */

import {type Client} from '@atproto/lex'
import {type NsidString} from '@atproto/syntax'

import {networkAwareFetch} from '#/state/session/network'
import {PRISM_URL} from '#/horizon/routing/prism'
import {getDirectPrismToken} from '#/horizon/routing/prism-direct'

/** The header prism needs on a direct member call. */
export const DIRECT_HEADER = 'Atproto-Umbrae-Direct'

export const METHODS = {
  getLabelers: 'app.nearhorizon.umbrae.getLabelers',
  getLabels: 'app.nearhorizon.umbrae.getLabels',
  getLabelerImage: 'app.nearhorizon.umbrae.getLabelerImage',
} as const satisfies Record<string, NsidString>

type Method = (typeof METHODS)[keyof typeof METHODS]

/** The most subjects one labels call takes. */
export const LABELS_BATCH = 100

/** A failed call: the HTTP status and the XRPC error name, nothing else. */
export class MemberLabelerCallError extends Error {
  constructor(
    readonly status: number,
    readonly error: string | undefined,
  ) {
    super(`Labeler call failed: ${status}${error ? ` ${error}` : ''}`)
    this.name = 'MemberLabelerCallError'
  }
}

/** A labeler as prism lists it. Record values are passed through as stored. */
export type RawMemberLabeler = {
  did: string
  /** `moderation` or `labels_only`. */
  kind?: string
  /** `active` or `retired` (a retired labeler's labels still show). */
  state?: string
  profile?: {
    displayName?: string
    description?: string
    avatar?: string
    banner?: string
  }
  policies?: {
    policies?: {
      labelValues?: string[]
      labelValueDefinitions?: unknown[]
    }
    reasonTypes?: string[]
    subjectTypes?: string[]
    subjectCollections?: string[]
  }
  reasons?: unknown
}

/** A label as prism answers it: negations and expiry already applied. */
export type RawMemberLabel = {
  src: string
  uri: string
  cid?: string
  val: string
  cts: string
  exp?: string
}

type Fetch = typeof fetch

async function send(
  pdsClient: Client,
  lxm: Method,
  init: {method: 'GET'} | {method: 'POST'; body: unknown},
  fetchImpl: Fetch,
): Promise<Response> {
  const url = new URL(`/xrpc/${lxm}`, PRISM_URL)
  const attempt = async (fresh: boolean) => {
    const token = await getDirectPrismToken(pdsClient, lxm, {fresh})
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      [DIRECT_HEADER]: '1',
    })
    if (init.method === 'POST') headers.set('content-type', 'application/json')
    return fetchImpl(url, {
      method: init.method,
      headers,
      ...(init.method === 'POST' ? {body: JSON.stringify(init.body)} : {}),
    })
  }
  const response = await attempt(false)
  return response.status === 401 ? attempt(true) : response
}

async function errorOf(response: Response): Promise<MemberLabelerCallError> {
  let error: string | undefined
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'error' in body) {
      error = typeof body.error === 'string' ? body.error : undefined
    }
  } catch {
    // No JSON body.
  }
  return new MemberLabelerCallError(response.status, error)
}

/** The member's labelers; `[]` when prism has none for them. */
export async function fetchMemberLabelers(
  pdsClient: Client,
  {fetchImpl = networkAwareFetch}: {fetchImpl?: Fetch} = {},
): Promise<RawMemberLabeler[]> {
  const response = await send(
    pdsClient,
    METHODS.getLabelers,
    {method: 'GET'},
    fetchImpl,
  )
  if (!response.ok) throw await errorOf(response)
  const body = (await response.json()) as {labelers?: unknown}
  if (!Array.isArray(body.labelers)) return []
  return body.labelers.filter(
    (entry): entry is RawMemberLabeler =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as {did?: unknown}).did === 'string',
  )
}

/**
 * The labels this member may see on `subjects` (at most
 * {@link LABELS_BATCH}): record URIs and account DIDs. Account labels come
 * back with `uri` the bare DID.
 */
export async function fetchMemberLabels(
  pdsClient: Client,
  subjects: string[],
  {
    fetchImpl = networkAwareFetch,
    signal,
  }: {fetchImpl?: Fetch; signal?: AbortSignal} = {},
): Promise<RawMemberLabel[]> {
  if (subjects.length === 0) return []
  const response = await send(
    pdsClient,
    METHODS.getLabels,
    {method: 'POST', body: {subjects}},
    signal
      ? (input, init) => fetchImpl(input, {...init, signal})
      : fetchImpl,
  )
  if (!response.ok) throw await errorOf(response)
  const body = (await response.json()) as {labels?: unknown}
  if (!Array.isArray(body.labels)) return []
  return body.labels.filter(
    (label): label is RawMemberLabel =>
      !!label &&
      typeof label === 'object' &&
      typeof (label as RawMemberLabel).src === 'string' &&
      typeof (label as RawMemberLabel).uri === 'string' &&
      typeof (label as RawMemberLabel).val === 'string' &&
      typeof (label as RawMemberLabel).cts === 'string',
  )
}

/** A labeler's avatar or banner, as bytes held in memory. */
export async function fetchMemberLabelerImage(
  pdsClient: Client,
  labeler: string,
  cid: string,
  {fetchImpl = networkAwareFetch}: {fetchImpl?: Fetch} = {},
): Promise<{bytes: ArrayBuffer; type: string}> {
  const response = await send(
    pdsClient,
    METHODS.getLabelerImage,
    {method: 'POST', body: {labeler, cid}},
    fetchImpl,
  )
  if (!response.ok) throw await errorOf(response)
  return {
    bytes: await response.arrayBuffer(),
    type: response.headers.get('content-type') ?? 'image/jpeg',
  }
}
