/*
 * Which labelers belong to the operator's cairn: their `#atproto_labeler`
 * endpoint is cairn's address or a host under it. Kept apart from the team
 * query so it loads nothing of the app.
 */

import {cairnUrl} from '#/horizon/cairn/primary-labeler'

type Fetch = typeof fetch

/** The `#atproto_labeler` endpoint in a labeler's DID document. */
export async function labelerEndpoint(
  did: string,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<string | undefined> {
  let url: string
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}`
  } else if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length))
    if (host.includes(':')) return undefined
    url = `https://${host}/.well-known/did.json`
  } else {
    return undefined
  }
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return undefined
    const doc = (await response.json()) as {
      service?: {id?: string; serviceEndpoint?: unknown}[]
    }
    const entry = doc.service?.find(
      each =>
        each.id === '#atproto_labeler' || each.id === `${did}#atproto_labeler`,
    )
    return typeof entry?.serviceEndpoint === 'string'
      ? entry.serviceEndpoint
      : undefined
  } catch {
    return undefined
  }
}

/** Whether `endpoint` is the operator's cairn, or a host under it. */
export function isCairnHosted(
  endpoint: string | undefined,
  base: string | undefined = cairnUrl(),
): boolean {
  if (!endpoint || !base) return false
  try {
    const host = new URL(endpoint).host
    const cairn = new URL(base).host
    return host === cairn || host.endsWith(`.${cairn}`)
  } catch {
    return false
  }
}
