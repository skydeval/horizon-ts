/*
 * Fixtures for the identity suites: a fake prism behind the mocked
 * network-aware fetch (every S-2 call, direct or signed out, reaches it),
 * fake PDS clients whose own fetch handler answers `getServiceAuth`,
 * `getRecord` and `listRecords` from a record map, and the signed-in and
 * signed-out set-ups. No network call is made.
 *
 * Each suite mocks `#/state/session/network` with {@link networkMock}.
 */

import {type Client} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {QueryClient} from '@tanstack/react-query'

import {createLexClient} from '#/lib/lexClient'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'

export const READER = 'did:plc:readeraaaaaaaaaaaaaaaaaa'
export const AUTHOR = 'did:plc:authoraaaaaaaaaaaaaaaaaa'
export const OTHER = 'did:plc:otherbbbbbbbbbbbbbbbbbbb'

export const PRONOUNS = 'app.nearhorizon.actor.pronouns'
export const SYSTEM = 'app.nearhorizon.plural.system'
export const MEMBER = 'app.nearhorizon.plural.member'
export const FRONT = 'app.nearhorizon.plural.front'

export const CID = 'bafyreib5nrnibdfqecagl7fcg4dudgj7qgkgk4tvcq7blwpbrfkha26dia'

export const WREN = '3m4kq2xv7ad2c'
export const SPARROW = '3m4kq3b5nfe2t'

export function uriOf(did: string, collection: string, rkey = 'self') {
  return `at://${did}/${collection}/${rkey}`
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  })
}

/** One request that reached prism. */
export type PrismCall = {
  url: URL
  method: string
  params: URLSearchParams
  headers: Headers
  init: RequestInit | undefined
  at: number
}

/**
 * What prism holds: records by URI, and the URIs or DIDs it answers
 * `unknown` for. Anything else is `none`.
 */
export const world = {
  records: new Map<string, unknown>(),
  unknown: new Set<string>(),
  /** `listMembers`' status for a DID (default `complete`). */
  listStatus: new Map<string, 'complete' | 'partial' | 'unknown'>(),
}

function answerFor(did: string, uri: string) {
  if (world.unknown.has(did) || world.unknown.has(uri)) {
    return {status: 'unknown'}
  }
  const value = world.records.get(uri)
  if (value === undefined) return {status: 'none'}
  return {status: 'record', uri, cid: CID, value}
}

/** prism's answer from {@link world}. */
export function worldAnswer(call: PrismCall): Response {
  if (call.method === 'app.nearhorizon.plural.getRecords') {
    const actors = call.params.getAll('actors')
    const members = call.params.getAll('members')
    return json({
      actors: actors.map(did => ({
        did,
        pronouns: answerFor(did, uriOf(did, PRONOUNS)),
        system: answerFor(did, uriOf(did, SYSTEM)),
        front: answerFor(did, uriOf(did, FRONT)),
      })),
      members: members.map(uri => {
        const did = uri.split('/')[2]
        return {...answerFor(did, uri), uri}
      }),
    })
  }
  if (call.method === 'app.nearhorizon.plural.listMembers') {
    const did = call.params.get('actor') ?? ''
    const status = world.unknown.has(did)
      ? 'unknown'
      : (world.listStatus.get(did) ?? 'complete')
    const prefix = `at://${did}/${MEMBER}/`
    const members =
      status === 'unknown'
        ? []
        : Array.from(world.records.entries())
            .filter(([uri]) => uri.startsWith(prefix))
            .map(([uri, value]) => ({
              uri,
              rkey: uri.slice(prefix.length),
              cid: CID,
              value,
            }))
    return json({actor: did, status, members})
  }
  return json({error: 'MethodNotImplemented'}, 501)
}

export const prism = {
  calls: [] as PrismCall[],
  answer: worldAnswer as (call: PrismCall) => Response | Promise<Response>,
}

/** The `#/state/session/network` mock: every fetch is prism's. */
export const networkMock = {
  networkAwareFetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const call: PrismCall = {
      url,
      method: url.pathname.replace(/^\/xrpc\//, ''),
      params: url.searchParams,
      headers: new Headers(init?.headers),
      init,
      at: Date.now(),
    }
    prism.calls.push(call)
    return Promise.resolve(prism.answer(call))
  },
}

/** Calls of one method. */
export function callsOf(method: 'getRecords' | 'listMembers') {
  return prism.calls.filter(
    call => call.method === `app.nearhorizon.plural.${method}`,
  )
}

function base64url(value: string) {
  return Buffer.from(value).toString('base64url')
}

let minted = 0

/** A service token living `secs` from now. */
export function token(lxm: string, secs = 3540) {
  minted++
  const iat = Math.floor(Date.now() / 1000)
  return [
    base64url(JSON.stringify({alg: 'ES256K', typ: 'JWT'})),
    base64url(
      JSON.stringify({iss: READER, lxm, iat, exp: iat + secs, n: minted}),
    ),
    'sig',
  ].join('.')
}

export type PdsCall = {did: string; path: string; params: URLSearchParams}

/** The PDS side: calls, records, and the `getServiceAuth` answer. */
export const pds = {
  calls: [] as PdsCall[],
  records: new Map<string, unknown>(),
  /** URIs whose `getRecord` answers 500. */
  fail: new Set<string>(),
  serviceAuth: ((params: URLSearchParams) =>
    json({token: token(params.get('lxm') ?? '')})) as (
    params: URLSearchParams,
  ) => Response | Promise<Response>,
}

export function serviceAuthCalls() {
  return pds.calls.filter(
    call => call.path === '/xrpc/com.atproto.server.getServiceAuth',
  )
}

/**
 * The agent behind each fake PDS client: setting its `did` to `undefined`
 * makes the client sessionless (`PrivateClientUnavailableError` on the
 * next token).
 */
export const agents = new Map<Client, {did: DidString | undefined}>()

/** A PDS client for `did`, answering from {@link pds}. */
export function pdsClientFor(did: string): Client {
  const agent = {
    did: did as DidString | undefined,
    fetchHandler: (path: string) => {
      const url = new URL(path, 'https://pds.example')
      pds.calls.push({did, path: url.pathname, params: url.searchParams})
      if (url.pathname === '/xrpc/com.atproto.server.getServiceAuth') {
        return Promise.resolve(pds.serviceAuth(url.searchParams))
      }
      if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
        const p = url.searchParams
        const uri = uriOf(
          p.get('repo') ?? '',
          p.get('collection') ?? '',
          p.get('rkey') ?? '',
        )
        if (pds.fail.has(uri)) {
          return Promise.resolve(json({error: 'InternalServerError'}, 500))
        }
        const value = pds.records.get(uri)
        if (value === undefined) {
          return Promise.resolve(
            json(
              {error: 'RecordNotFound', message: 'Could not locate record'},
              400,
            ),
          )
        }
        return Promise.resolve(json({uri, cid: CID, value}))
      }
      if (url.pathname === '/xrpc/com.atproto.repo.listRecords') {
        const p = url.searchParams
        const prefix = `at://${p.get('repo')}/${p.get('collection')}/`
        const records = Array.from(pds.records.entries())
          .filter(([uri]) => uri.startsWith(prefix))
          .map(([uri, value]) => ({uri, cid: CID, value}))
          .reverse()
        return Promise.resolve(json({records}))
      }
      return Promise.resolve(json({error: 'Unexpected'}, 500))
    },
  }
  const client = createLexClient(agent, {appLabelers: null})
  agents.set(client, agent)
  return client
}

/** Sign `did` in: publishes its clients, a query client included. */
export function signIn(did: string = READER, queryClient = newQueryClient()) {
  const pdsClient = pdsClientFor(did)
  publishCurrentClients({
    did,
    handle: 'reader.test',
    pdsUrl: 'https://pds.example',
    pdsClient,
    prismClient: pdsClient,
    appviewClient: pdsClient,
    queryClient,
  })
  return {pdsClient, queryClient}
}

export function signOut() {
  clearCurrentClients()
}

export function newQueryClient() {
  return new QueryClient({defaultOptions: {queries: {retry: false}}})
}

/** Records, as prism or a PDS would hold them. */
export const records = {
  pronouns: (sets: string[][], extra: Record<string, unknown> = {}) => ({
    $type: PRONOUNS,
    sets: sets.map(forms => ({forms})),
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }),
  system: (extra: Record<string, unknown> = {}) => ({
    $type: SYSTEM,
    name: 'The Flock',
    ...extra,
  }),
  member: (displayName: string, extra: Record<string, unknown> = {}) => ({
    $type: MEMBER,
    displayName,
    ...extra,
  }),
  front: (ids: string[], extra: Record<string, unknown> = {}) => ({
    $type: FRONT,
    members: ids.map(id => ({id})),
    setAt: '2026-10-24T00:00:00.000Z',
    ...extra,
  }),
}

/** Forget every fixture. */
export function resetHarness() {
  prism.calls.length = 0
  prism.answer = worldAnswer
  world.records.clear()
  world.unknown.clear()
  world.listStatus.clear()
  pds.calls.length = 0
  pds.records.clear()
  pds.fail.clear()
  agents.clear()
  pds.serviceAuth = params => json({token: token(params.get('lxm') ?? '')})
  minted = 0
  signOut()
}
