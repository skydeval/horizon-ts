/*
 * Who an identifier names, without any account's session (system accounts
 * design 4.2, 4.3 step 2, SA-19): the DID, the handle and the PDS from the
 * DID document. Handles go through the public AppView's `resolveHandle`, DID
 * documents through plc.directory or the did:web host: unauthenticated, so
 * those services see the DID and the device's IP and nothing else (7.3).
 * Never through the current account's clients.
 */

import {type DidDocument, getPdsEndpoint} from '@atproto/common-web'
import {type HandleString} from '@atproto/syntax'

import {getPublicAppviewClient} from '#/state/session/clients'
import {com} from '#/lexicons'

/** An account the identifier names. */
export type ResolvedAccount = {
  did: string
  /** The verified handle, when there is one. */
  handle: string | undefined
  /** The PDS from the DID document. */
  pdsUrl: string | undefined
}

/** The identifier names a server, not an account (4.3 step 2). */
export class ServerIdentifierError extends Error {
  constructor() {
    super('The identifier names a server, not an account')
    this.name = 'ServerIdentifierError'
  }
}

/** The identifier does not name an account that resolves. */
export class UnresolvedIdentifierError extends Error {
  constructor() {
    super('The identifier does not resolve')
    this.name = 'UnresolvedIdentifierError'
  }
}

const TIMEOUT_MS = 20_000

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Normalize as the sign-in form does: trimmed, lowercased, no leading `@`. */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase().replace(/^@/, '')
}

async function fetchDidDocument(
  did: string,
  signal: AbortSignal,
): Promise<DidDocument | undefined> {
  let url: string | undefined
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}`
  } else if (did.startsWith('did:web:')) {
    const domain = did.slice('did:web:'.length)
    if (domain.includes(':')) return undefined
    url = `https://${decodeURIComponent(domain)}/.well-known/did.json`
  }
  if (!url) return undefined
  const res = await fetch(url, {signal})
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) {
      throw new Error(`Network request failed: ${res.status}`)
    }
    return undefined
  }
  return (await res.json()) as DidDocument
}

async function resolveHandleDid(
  handle: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const out = await getPublicAppviewClient().call(
      com.atproto.identity.resolveHandle,
      {handle: handle as HandleString},
      {signal},
    )
    return out.did
  } catch {
    return undefined
  }
}

function claimedHandle(doc: DidDocument): string | undefined {
  const aka = doc.alsoKnownAs?.find(value => value.startsWith('at://'))
  return aka ? aka.slice('at://'.length).toLowerCase() : undefined
}

/**
 * The verified handle of `did`: claimed by its DID document and resolving
 * back to it. `undefined` when either step fails.
 */
export async function handleForDid(did: string): Promise<string | undefined> {
  try {
    return await withTimeout(async signal => {
      const doc = await fetchDidDocument(did, signal)
      const handle = doc ? claimedHandle(doc) : undefined
      if (!handle) return undefined
      return (await resolveHandleDid(handle, signal)) === did
        ? handle
        : undefined
    })
  } catch {
    return undefined
  }
}

/**
 * Resolve a handle or DID typed in the add dialog. Throws
 * {@link ServerIdentifierError} for a server address,
 * {@link UnresolvedIdentifierError} when it names no account, and a network
 * error when the lookup could not be made.
 */
export async function resolveAccount(
  identifier: string,
): Promise<ResolvedAccount> {
  const value = normalizeIdentifier(identifier)
  if (!value) throw new UnresolvedIdentifierError()
  if (/^https?:\/\//.test(value)) throw new ServerIdentifierError()
  return withTimeout(async signal => {
    const did = value.startsWith('did:')
      ? value
      : await resolveHandleDid(value, signal)
    if (!did) {
      if (!value.includes('.')) throw new ServerIdentifierError()
      throw new UnresolvedIdentifierError()
    }
    const doc = await fetchDidDocument(did, signal)
    if (!doc) throw new UnresolvedIdentifierError()
    const claimed = claimedHandle(doc)
    let handle: string | undefined
    if (!value.startsWith('did:')) {
      handle = claimed === value ? value : undefined
    } else if (claimed) {
      handle =
        (await resolveHandleDid(claimed, signal)) === did ? claimed : undefined
    }
    return {did, handle, pdsUrl: getPdsEndpoint(doc) ?? undefined}
  })
}
