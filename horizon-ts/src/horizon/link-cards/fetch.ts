/*
 * The lookups behind a link card (`status.ts`): the post from Bluesky's
 * public AppView, and from the author's own repo their pronouns and the
 * video file. Every request is public, unauthenticated and short; a failed
 * one leaves its part off the card (no pronouns, no video) or, for the post
 * itself, gives the "not found" card. `fetchImpl` is injected so tests run
 * without the network. Relative imports only (see `status.ts`).
 */

import {buildPostCard, type Card} from './status'

/** Bluesky's public AppView, as a signed-out bsky.app reads it. */
export const PUBLIC_APPVIEW = 'https://public.api.bsky.app'

/** The PLC directory, for a did:plc's document. */
export const PLC_DIRECTORY = 'https://plc.directory'

/** How long any one lookup may take, in ms. */
export const LOOKUP_TIMEOUT_MS = 3000

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

async function getJson(
  fetchImpl: Fetch,
  url: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetchImpl(url, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const body: unknown = await res.json()
    return typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const HANDLE_RE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
const DID_RE = /^did:(plc|web):[A-Za-z0-9._:%-]+$/
const RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/

/** The DID for a profile name from a link (a DID or a handle). */
export async function resolveName(
  name: string,
  fetchImpl: Fetch,
): Promise<string | undefined> {
  if (DID_RE.test(name)) return name
  if (!HANDLE_RE.test(name)) return undefined
  const body = await getJson(
    fetchImpl,
    `${PUBLIC_APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(name)}`,
  )
  const did = typeof body?.did === 'string' ? body.did : undefined
  return did && DID_RE.test(did) ? did : undefined
}

/** The account's PDS, from its DID document. */
export async function resolvePds(
  did: string,
  fetchImpl: Fetch,
): Promise<string | undefined> {
  let docUrl: string
  if (did.startsWith('did:plc:')) {
    docUrl = `${PLC_DIRECTORY}/${did}`
  } else if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length))
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) return undefined
    docUrl = `https://${host}/.well-known/did.json`
  } else {
    return undefined
  }
  const doc = await getJson(fetchImpl, docUrl)
  const services = Array.isArray(doc?.service) ? doc.service : []
  for (const service of services) {
    const s = service as Record<string, unknown>
    if (
      typeof s.id === 'string' &&
      s.id.endsWith('#atproto_pds') &&
      typeof s.serviceEndpoint === 'string' &&
      s.serviceEndpoint.startsWith('https://')
    ) {
      return s.serviceEndpoint.replace(/\/+$/, '')
    }
  }
  return undefined
}

/**
 * The author's pronouns (`app.nearhorizon.actor.pronouns`) as Horizon shows
 * them: a set's forms joined with `/`, sets with ` · `, the first set only
 * when the author asked for that. Undefined when unset or malformed.
 */
export function formatPronounRecord(value: unknown): string | undefined {
  const record = value as {sets?: unknown; displayMode?: unknown} | undefined
  if (!record || !Array.isArray(record.sets)) return undefined
  const sets = record.sets
    .filter((set): set is unknown[] => Array.isArray(set))
    .slice(0, 10)
    .map(set =>
      set
        .filter((form): form is string => typeof form === 'string')
        .slice(0, 12)
        .map(form => form.trim())
        .filter(form => form.length > 0 && form.length <= 240)
        .join('/'),
    )
    .filter(set => set.length > 0)
  if (sets.length === 0) return undefined
  return record.displayMode === 'firstOnly' ? sets[0] : sets.join(' · ')
}

async function fetchPronouns(
  pds: string,
  did: string,
  fetchImpl: Fetch,
): Promise<string | undefined> {
  const body = await getJson(
    fetchImpl,
    `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.nearhorizon.actor.pronouns&rkey=self`,
  )
  return formatPronounRecord(body?.value)
}

/**
 * The card for a public post link, `/profile/<name>/post/<rkey>`. `url` is
 * the link as the card names it.
 */
export async function loadPostCard({
  name,
  rkey,
  url,
  fetchImpl,
}: {
  name: string
  rkey: string
  url: string
  fetchImpl: Fetch
}): Promise<Card> {
  if (!RKEY_RE.test(rkey)) return {kind: 'missing', url}
  const did = await resolveName(name, fetchImpl)
  if (!did) return {kind: 'missing', url}
  const uri = `at://${did}/app.bsky.feed.post/${rkey}`
  const [threadBody, pds] = await Promise.all([
    getJson(
      fetchImpl,
      `${PUBLIC_APPVIEW}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=1`,
    ),
    resolvePds(did, fetchImpl),
  ])
  const pronouns = pds ? await fetchPronouns(pds, did, fetchImpl) : undefined
  return buildPostCard({
    thread: threadBody?.thread,
    url,
    pronouns,
    videoUrl: cid =>
      pds
        ? `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`
        : undefined,
  })
}
