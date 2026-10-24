/*
 * A fake PDS for the identity write suites (Phase 5 design 13, 5C): a lex
 * client whose fetch handler keeps records by URI with a CID each, and
 * answers `getRecord`, `listRecords` (paged), `putRecord` (with
 * `swapRecord`), `createRecord` (failing on an existing rkey),
 * `deleteRecord` and `applyWrites`, recording every write. No network call
 * is made.
 *
 * Suites using it `jest.unmock('multiformats/cid')`.
 */

import {type Client} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {CID} from 'multiformats/cid'
import {create as createDigest} from 'multiformats/hashes/digest'

import {createLexClient} from '#/lib/lexClient'

/** A valid CID, distinct for each `n`. */
export function cidOf(n: number): string {
  const bytes = new Uint8Array(32)
  bytes[0] = n & 0xff
  bytes[1] = (n >> 8) & 0xff
  bytes[2] = 0x5c
  return CID.create(1, 0x71, createDigest(0x12, bytes)).toString()
}

/** One `applyWrites` entry. */
export type ApplyWrite = {
  $type: string
  collection: string
  rkey: string
  value?: unknown
}

/** A write call's body (the fields these suites read). */
export type WriteBody = {
  repo?: string
  collection: string
  rkey: string
  record: Record<string, unknown>
  swapRecord?: string | null
  writes: ApplyWrite[]
}

/** One write call, as the PDS received it. */
export type WriteCall = {
  method: string
  body: WriteBody
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

/** The fake repo: records by URI, each with its CID. */
export function createRepo(did: string) {
  const records = new Map<string, {value: unknown; cid: string}>()
  const writes: WriteCall[] = []
  let version = 0
  /** Methods that answer 500, with how many calls to let through first. */
  const failures = new Map<string, number>()

  const uri = (collection: string, rkey: string) =>
    `at://${did}/${collection}/${rkey}`

  const put = (collection: string, rkey: string, value: unknown) => {
    version += 1
    const cid = cidOf(version)
    records.set(uri(collection, rkey), {value, cid})
    return cid
  }

  const shouldFail = (method: string) => {
    const left = failures.get(method)
    if (left === undefined) return false
    if (left > 0) {
      failures.set(method, left - 1)
      return false
    }
    return true
  }

  const handler = (path: string, init?: RequestInit) =>
    Promise.resolve(respond(path, init))

  const respond = (path: string, init?: RequestInit): Response => {
    const url = new URL(path, 'https://pds.example')
    const method = url.pathname.replace(/^\/xrpc\//, '')
    const params = url.searchParams
    if (method === 'com.atproto.repo.getRecord') {
      const found = records.get(
        uri(params.get('collection') ?? '', params.get('rkey') ?? ''),
      )
      if (!found) {
        return json({error: 'RecordNotFound', message: 'Not found'}, 400)
      }
      return json({
        uri: uri(params.get('collection') ?? '', params.get('rkey') ?? ''),
        cid: found.cid,
        value: found.value,
      })
    }
    if (method === 'com.atproto.repo.listRecords') {
      const prefix = `at://${did}/${params.get('collection')}/`
      const all = Array.from(records.entries())
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
      const limit = Number(params.get('limit') ?? 50)
      const start = Number(params.get('cursor') ?? 0)
      const page = all.slice(start, start + limit)
      const next = start + limit < all.length ? String(start + limit) : null
      return json({
        records: page.map(([key, r]) => ({
          uri: key,
          cid: r.cid,
          value: r.value,
        })),
        ...(next ? {cursor: next} : {}),
      })
    }

    const body = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as WriteBody
    writes.push({method, body})
    if (shouldFail(method)) return json({error: 'InternalServerError'}, 500)

    if (method === 'com.atproto.repo.putRecord') {
      const key = uri(body.collection, body.rkey)
      const existing = records.get(key)
      if ('swapRecord' in body) {
        const swap = body.swapRecord
        if (swap === null ? !!existing : existing?.cid !== swap) {
          return json({error: 'InvalidSwap', message: 'Swap failed'}, 400)
        }
      }
      const cid = put(body.collection, body.rkey, body.record)
      return json({uri: key, cid})
    }
    if (method === 'com.atproto.repo.createRecord') {
      const key = uri(body.collection, body.rkey)
      if (records.has(key)) {
        return json({error: 'InvalidRequest', message: 'Record exists'}, 400)
      }
      const cid = put(body.collection, body.rkey, body.record)
      return json({uri: key, cid})
    }
    if (method === 'com.atproto.repo.deleteRecord') {
      records.delete(uri(body.collection, body.rkey))
      return json({})
    }
    if (method === 'com.atproto.repo.applyWrites') {
      for (const write of body.writes) {
        if (write.$type === 'com.atproto.repo.applyWrites#delete') {
          records.delete(uri(write.collection, write.rkey))
        }
      }
      return json({})
    }
    return json({error: 'Unexpected'}, 500)
  }

  const client: Client = createLexClient(
    {did: did as DidString, fetchHandler: handler},
    {appLabelers: null},
  )

  return {
    client,
    records,
    writes,
    failures,
    /** Seed a record; returns its CID. */
    seed: put,
    get: (collection: string, rkey: string) =>
      records.get(uri(collection, rkey)),
    writesOf: (method: string) =>
      writes.filter(w => w.method === `com.atproto.repo.${method}`),
  }
}
