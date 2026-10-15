/*
 * A small `did:web` document fetch for the AppView switcher.
 *
 * Adapted from the Witchsky client (MIT),
 * src/state/queries/resolve-identity.ts (`findService`) and
 * src/state/preferences/custom-appview-did.tsx (`normalizeAppViewUrl`,
 * `didWebFromAppViewUrl`).
 */

/**
 * The parts of a DID document the switcher reads.
 */
export type DidDocument = {
  id?: string
  service?: {id?: string; type?: string; serviceEndpoint?: unknown}[]
}

/**
 * Trim a typed address, add `https://` when missing (`http://` for
 * `localhost`), and drop a trailing slash. Returns `''` for empty input.
 */
export function normalizeAppViewUrl(input: string | undefined): string {
  if (!input) return ''
  let next = input.trim()
  if (!next) return ''
  if (!next.startsWith('http://') && !next.startsWith('https://')) {
    next =
      next === 'localhost' || next.startsWith('localhost:')
        ? `http://${next}`
        : `https://${next}`
  }
  try {
    const parsed = new URL(next)
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname)
  } catch {
    return next
  }
}

/**
 * The `did:web` for an address's host, or `undefined` when it has none. A
 * port is percent-encoded, as `did:web` requires.
 */
export function didWebFromUrl(url: string): string | undefined {
  try {
    const {hostname, port} = new URL(normalizeAppViewUrl(url))
    if (!hostname) return undefined
    return `did:web:${hostname}${port ? `%3A${port}` : ''}`
  } catch {
    return undefined
  }
}

/**
 * Find a service entry by id (`#bsky_appview`) and, optionally, type.
 */
export function findService(
  doc: DidDocument | undefined,
  id: string,
  type?: string,
) {
  if (!doc || !Array.isArray(doc.service)) return undefined
  return doc.service.find(
    service =>
      typeof service?.serviceEndpoint === 'string' &&
      (service.id === id || service.id === `${doc.id ?? ''}${id}`) &&
      (!type || service.type === type),
  )
}

/**
 * Fetch the DID document of a `did:web` from its host's
 * `/.well-known/did.json`. Returns `undefined` when it cannot be read.
 */
export async function fetchDidWebDocument(
  did: string,
): Promise<DidDocument | undefined> {
  if (!did.startsWith('did:web:')) return undefined
  const host = decodeURIComponent(did.slice('did:web:'.length))
  const scheme =
    host === 'localhost' || host.startsWith('localhost:') ? 'http' : 'https'
  try {
    const response = await fetch(`${scheme}://${host}/.well-known/did.json`)
    if (!response.ok) return undefined
    const doc: DidDocument | null = await response.json()
    return doc && typeof doc === 'object' ? doc : undefined
  } catch {
    return undefined
  }
}
