/*
 * Shared fixtures for the private-posting tests. A test that validates CIDs
 * must opt out of the suite's global `multiformats` mocks first:
 * `jest.unmock('multiformats/cid')` and
 * `jest.unmock('multiformats/hashes/hasher')`.
 */

import {type Client, parseCid} from '@atproto/lex'

import {createLexClient} from '#/lib/lexClient'

export const DID = 'did:plc:privateaaaaaaaaaaaaaaaaa'
export const OTHER_DID = 'did:plc:otherbbbbbbbbbbbbbbbbbbbb'
export const AUDIENCE = `at://${DID}/tools.kryphocron.policy.audience/3kaudience22`
export const OTHER_AUDIENCE = `at://${OTHER_DID}/tools.kryphocron.policy.audience/3kaudience33`

/** A dag-cbor CID, as records have. */
export const RECORD_CID =
  'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'
/** A raw CID, as blobs have. */
export const BLOB_CID =
  'bafkreieq5jui4j25lacwomsqgjeswwl3y5zcdrresptwgmfylxo2depppq'

export function blob(size = 1000, mimeType = 'image/jpeg') {
  return {
    $type: 'blob' as const,
    ref: parseCid(BLOB_CID),
    mimeType,
    size,
  }
}

export function privateUri(rkey: string, did = DID) {
  return `at://${did}/tools.kryphocron.feed.postPrivate/${rkey}`
}

/**
 * One request a fake server received.
 */
export type Call = {
  nsid: string
  params: URLSearchParams
  body: Record<string, unknown> | undefined
}

/**
 * What a fake server answers: a status and JSON body, or a network failure.
 */
export type Reply = {status: number; body?: unknown} | Error

/**
 * A lex client signed in as `did` whose requests go to `handler`. Every
 * request is recorded in `calls`, in order.
 */
export function fakeClient(
  did: string,
  handler: (call: Call) => Reply | Promise<Reply>,
): {client: Client; calls: Call[]} {
  const calls: Call[] = []
  const client = createLexClient(
    {
      did: did as `did:${string}:${string}`,
      fetchHandler: async (path: string, init: RequestInit) => {
        const url = new URL(path, 'https://server.example')
        const nsid = url.pathname.replace('/xrpc/', '')
        let body: Record<string, unknown> | undefined
        if (typeof init.body === 'string') {
          body = JSON.parse(init.body) as Record<string, unknown>
        } else if (init.body instanceof Uint8Array) {
          body = JSON.parse(new TextDecoder().decode(init.body)) as Record<
            string,
            unknown
          >
        }
        const call = {nsid, params: url.searchParams, body}
        calls.push(call)
        const reply = await handler(call)
        if (reply instanceof Error) throw reply
        return new Response(JSON.stringify(reply.body ?? {}), {
          status: reply.status,
          headers: {'content-type': 'application/json'},
        })
      },
    },
    {appLabelers: null},
  )
  return {client, calls}
}
