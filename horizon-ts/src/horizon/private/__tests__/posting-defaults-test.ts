import {beforeEach, describe, expect, it, jest} from '@jest/globals'

import {postingDefaultsRecord} from '#/horizon/lexicons/posting-defaults'
import {
  AUDIENCE,
  BLOB_CID,
  type Call,
  DID,
  fakeClient,
  OTHER_AUDIENCE,
  RECORD_CID,
} from '#/horizon/private/__tests__/fixtures'
import {
  fetchPostingDefaults,
  readDeviceDefaults,
  writePostingDefaults,
} from '#/horizon/private/defaults/query'
import {
  buildPostingDefaultsRecord,
  DEFAULT_PRIVATE_DEFAULTS,
  isOwnAudienceUri,
  parsePostingDefaultsRecord,
  type PrivateDefaults,
} from '#/horizon/private/defaults/record'

// The fake PDS answers real CIDs, which the client validates.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
  useMaybePdsClient: () => undefined,
}))
jest.mock('#/components/Toast', () => ({show: jest.fn()}))
jest.mock('#/logger', () => ({
  logger: {warn: jest.fn(), error: jest.fn(), info: jest.fn()},
}))

const COLLECTION = 'app.nearhorizon.actor.postingDefaults'
const NOW = new Date('2026-10-19T12:00:00.000Z')

const FOLLOWERS: PrivateDefaults = {
  startAs: 'private',
  audience: {kind: 'mode', mode: 'followers'},
}

type Stored = {value: Record<string, unknown>; cid: string} | null

/** A fake PDS with Bluesky's swap semantics for the one record. */
function pds(initial: Stored = null) {
  const server = {
    stored: initial,
    calls: [] as Call[],
    swapFailuresLeft: 0,
  }
  let next = 0
  const {client} = fakeClient(DID, call => {
    server.calls.push(call)
    if (call.nsid === 'com.atproto.repo.getRecord') {
      if (!server.stored) {
        return {status: 400, body: {error: 'RecordNotFound', message: 'none'}}
      }
      return {
        status: 200,
        body: {
          uri: `at://${DID}/${COLLECTION}/self`,
          cid: server.stored.cid,
          value: server.stored.value,
        },
      }
    }
    if (call.nsid === 'com.atproto.repo.putRecord') {
      const swap = call.body?.swapRecord
      const current = server.stored?.cid ?? null
      if (
        server.swapFailuresLeft > 0 ||
        (swap !== undefined && swap !== current)
      ) {
        server.swapFailuresLeft = Math.max(0, server.swapFailuresLeft - 1)
        return {status: 400, body: {error: 'InvalidSwap', message: 'swap'}}
      }
      const cid = next++ % 2 === 0 ? RECORD_CID : BLOB_CID
      server.stored = {value: call.body!.record as Record<string, unknown>, cid}
      return {status: 200, body: {uri: `at://${DID}/${COLLECTION}/self`, cid}}
    }
    return {status: 404, body: {error: 'MethodNotImplemented'}}
  })
  return {server, client}
}

function puts(calls: Call[]) {
  return calls.filter(c => c.nsid === 'com.atproto.repo.putRecord')
}

describe('the record (lexicon and lenient reads)', () => {
  it('a built record validates against the schema', () => {
    const record = buildPostingDefaultsRecord(null, FOLLOWERS, NOW)
    expect(postingDefaultsRecord.safeValidate(record).success).toBe(true)
    expect(record).toEqual({
      $type: COLLECTION,
      version: 1,
      private: {startAs: 'private', audience: {mode: 'followers'}},
      updatedAt: NOW.toISOString(),
    })
    const list = buildPostingDefaultsRecord(
      null,
      {startAs: 'public', audience: {kind: 'list', uri: AUDIENCE}},
      NOW,
    )
    expect(postingDefaultsRecord.safeValidate(list).success).toBe(true)
    expect(list.private).toEqual({
      startAs: 'public',
      audience: {mode: 'list', list: AUDIENCE},
    })
  })

  it('reads a record back as written', () => {
    const record = buildPostingDefaultsRecord(null, FOLLOWERS, NOW)
    expect(parsePostingDefaultsRecord(record, DID)?.defaults).toEqual(FOLLOWERS)
  })

  it('another collection or a non-object is no record', () => {
    expect(parsePostingDefaultsRecord({$type: 'app.bsky.feed.post'}, DID)).toBe(
      null,
    )
    expect(parsePostingDefaultsRecord('x', DID)).toBe(null)
  })

  it('missing or unknown fields fall back to the defaults', () => {
    expect(parsePostingDefaultsRecord({}, DID)?.defaults).toEqual(
      DEFAULT_PRIVATE_DEFAULTS,
    )
    expect(
      parsePostingDefaultsRecord({private: {startAs: 'sometimes'}}, DID)
        ?.defaults,
    ).toEqual(DEFAULT_PRIVATE_DEFAULTS)
  })

  it('a bad audience is never widened: it reads as Only me', () => {
    const only = {kind: 'mode', mode: 'nobody'}
    for (const audience of [
      {mode: 'mutuals'},
      {mode: 'list'},
      {mode: 'list', list: 'not a uri'},
      // Another account's audience is never a default.
      {mode: 'list', list: OTHER_AUDIENCE},
      {mode: 'list', list: `at://${DID}/app.bsky.graph.list/3kxyz`},
      'everyone',
    ]) {
      expect(
        parsePostingDefaultsRecord(
          {private: {startAs: 'private', audience}},
          DID,
        )?.defaults.audience,
      ).toEqual(only)
    }
  })

  it('an absent audience stays unchosen when read and written back (round 2 list)', () => {
    const read = parsePostingDefaultsRecord(
      {private: {startAs: 'private'}},
      DID,
    )?.defaults
    expect(read).toEqual({startAs: 'private'})
    expect(read).not.toHaveProperty('audience')
    const record = buildPostingDefaultsRecord(
      {private: {startAs: 'public', extra: true}},
      read!,
      NOW,
    )
    expect(record.private).toEqual({startAs: 'private', extra: true})
    // A chosen one is written; choosing none never widens a read one.
    expect(
      buildPostingDefaultsRecord(
        {private: {startAs: 'public', audience: {mode: 'nobody'}}},
        {startAs: 'public', audience: {kind: 'mode', mode: 'nobody'}},
        NOW,
      ).private,
    ).toEqual({startAs: 'public', audience: {mode: 'nobody'}})
  })

  it('only the owner own audience records count', () => {
    expect(isOwnAudienceUri(AUDIENCE, DID)).toBe(true)
    expect(isOwnAudienceUri(OTHER_AUDIENCE, DID)).toBe(false)
  })

  it('a write keeps the fields it does not know', () => {
    const raw = {
      version: 3,
      future: {a: 1},
      private: {startAs: 'public', extra: true},
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const record = buildPostingDefaultsRecord(raw, FOLLOWERS, NOW)
    expect(record).toMatchObject({
      version: 3,
      future: {a: 1},
      private: {startAs: 'private', extra: true, audience: {mode: 'followers'}},
      updatedAt: NOW.toISOString(),
    })
  })
})

describe('reading and writing in the account own repo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reads its own repo only; RecordNotFound gives the defaults', async () => {
    const {server, client} = pds()
    expect(await fetchPostingDefaults(client, DID)).toEqual(
      DEFAULT_PRIVATE_DEFAULTS,
    )
    const call = server.calls[0]
    expect(call.nsid).toBe('com.atproto.repo.getRecord')
    expect(call.params.get('repo')).toBe(DID)
    expect(call.params.get('collection')).toBe(COLLECTION)
    expect(call.params.get('rkey')).toBe('self')
  })

  it('writes to its own repo, swapped on the CID read, and keeps a device copy', async () => {
    const {server, client} = pds({
      value: {$type: COLLECTION, version: 1, kept: 'yes', updatedAt: 'x'},
      cid: RECORD_CID,
    })
    await writePostingDefaults(client, DID, FOLLOWERS, () => NOW)
    const [put] = puts(server.calls)
    expect(put.body).toMatchObject({
      repo: DID,
      collection: COLLECTION,
      rkey: 'self',
      swapRecord: RECORD_CID,
    })
    expect(server.stored?.value).toMatchObject({
      kept: 'yes',
      private: {startAs: 'private', audience: {mode: 'followers'}},
    })
    expect(readDeviceDefaults(DID)).toEqual(FOLLOWERS)
  })

  it('the device copy keeps an unchosen audience unchosen (round 2 list)', async () => {
    const {client} = pds({
      value: {$type: COLLECTION, version: 1, private: {startAs: 'private'}},
      cid: RECORD_CID,
    })
    expect(await fetchPostingDefaults(client, DID)).toEqual({
      startAs: 'private',
    })
    expect(readDeviceDefaults(DID)).toEqual({startAs: 'private'})
  })

  it('with no record, the write requires that none exists', async () => {
    const {server, client} = pds()
    await writePostingDefaults(client, DID, FOLLOWERS, () => NOW)
    expect(puts(server.calls)[0].body?.swapRecord).toBe(null)
  })

  it('a swap failure reads again and retries', async () => {
    const {server, client} = pds()
    server.swapFailuresLeft = 1
    await writePostingDefaults(client, DID, FOLLOWERS, () => NOW)
    expect(puts(server.calls)).toHaveLength(2)
    expect(server.stored?.value).toMatchObject({
      private: {startAs: 'private'},
    })
  })
})
