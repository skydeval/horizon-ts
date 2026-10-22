import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {repoRouteForDid, resetWriteRoutes} from '#/horizon/routing/write-route'
import {
  assertOwnAudienceExists,
  AudienceChangedError,
  audienceEditAvailable,
  type AudienceEntry,
  audienceLabel,
  AudienceNameInvalidError,
  audiencesQueryKey,
  CACHED_AUDIENCE_CONFIRM_MS,
  createListAudience,
  deleteAudience,
  findOrCreateStandingAudience,
  isEditableAudience,
  listAudiences,
  normalizeMembers,
  orderAudiences,
  pickStandingAudience,
  postAudienceLabel,
  PrivateAudienceMissingError,
  readAudienceRecord,
  readAudienceRecordAt,
  updateListAudience,
} from '../api/audiences'
import {
  type PostingWriter,
  PrivateKryphocronHostError,
  PrivateRouteUnavailableError,
} from '../api/writer'
import {
  AUDIENCE,
  type Call,
  DID,
  fakeClient,
  OTHER_AUDIENCE,
  OTHER_DID,
  type Reply,
} from './fixtures'

const COLLECTION = 'tools.kryphocron.policy.audience'

i18n.loadAndActivate({locale: 'en', messages: {}})

function entry(
  rkey: string,
  value: Record<string, unknown>,
): {uri: string; cid: string; value: Record<string, unknown>} {
  return {
    uri: `at://${DID}/${COLLECTION}/${rkey}`,
    cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
    value: {$type: COLLECTION, ...value},
  }
}

let records: ReturnType<typeof entry>[] = []
let createdUri = `at://${DID}/${COLLECTION}/3knewaudience`

/** Answers ahead of the defaults below, for one test. */
let extraHandler: ((call: Call) => Reply | undefined) | undefined

function pdsHandler(call: Call): Reply {
  const extra = extraHandler?.(call)
  if (extra) return extra
  if (call.nsid === 'com.atproto.repo.listRecords') {
    return {status: 200, body: {records}}
  }
  if (call.nsid === 'tools.kryphocron.policy.manageAudience') {
    return {status: 200, body: {uri: createdUri, cid: 'commitcid'}}
  }
  return {status: 404, body: {error: 'NotFound'}}
}

/**
 * The account's clients, published with `pdsUrl` (default: the jest setup's
 * locus origin, 2K T-12).
 */
function setup(pdsUrl = 'https://pds.example') {
  const pds = fakeClient(DID, pdsHandler)
  const prism = fakeClient(DID, () => ({
    status: 200,
    body: {status: 'indexed'},
  }))
  const queryClient = new QueryClient()
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl,
    pdsClient: pds.client,
    prismClient: prism.client,
    appviewClient: prism.client,
  })
  return {
    pds,
    prism,
    queryClient,
    clients: {did: DID, pdsClient: pds.client, prismClient: prism.client},
  }
}

beforeEach(() => {
  records = []
  createdUri = `at://${DID}/${COLLECTION}/3knewaudience`
  extraHandler = undefined
  resetWriteRoutes()
})

describe('reading audience records', () => {
  it('treats an absent mode as list and tolerates missing timestamps', () => {
    expect(readAudienceRecord(`at://${DID}/${COLLECTION}/3ka`, {})).toEqual({
      uri: `at://${DID}/${COLLECTION}/3ka`,
      rkey: '3ka',
      mode: 'list',
      name: undefined,
      members: [],
    })
  })

  it('keeps DIDs only and unknown modes as they are', () => {
    const read = readAudienceRecord(`at://${DID}/${COLLECTION}/3ka`, {
      mode: 'mutuals',
      members: [OTHER_DID, 'alice.test', 7],
    })
    expect(read?.mode).toBe('mutuals')
    expect(read?.members).toEqual([OTHER_DID])
  })

  it('lists every record from the PDS', async () => {
    records = [entry('3kb', {mode: 'everyone'})]
    const {pds} = setup()
    const listed = await listAudiences(pds.client, DID)
    expect(listed).toHaveLength(1)
    expect(pds.calls[0].nsid).toBe('com.atproto.repo.listRecords')
    expect(pds.calls[0].params.get('collection')).toBe(COLLECTION)
    expect(pds.calls[0].params.get('limit')).toBe('100')
  })
})

describe('standing audiences', () => {
  const entries: AudienceEntry[] = [
    {uri: 'u3', rkey: '3kc', mode: 'followers', members: []},
    {uri: 'u1', rkey: '3ka', mode: 'followers', name: 'Followers', members: []},
    {uri: 'u2', rkey: '3kb', mode: 'followers', members: []},
    {uri: 'u4', rkey: '3kd', mode: 'everyone', members: []},
  ]

  it('picks the oldest unnamed record of the mode and ignores named ones', () => {
    expect(pickStandingAudience(entries, 'followers')?.uri).toBe('u2')
    expect(pickStandingAudience(entries, 'everyone')?.uri).toBe('u4')
    expect(pickStandingAudience(entries, 'nobody')).toBeUndefined()
  })

  it('reuses an existing standing audience without creating one', async () => {
    records = [entry('3kb', {mode: 'everyone'})]
    const {pds, prism, queryClient, clients} = setup()
    const uri = await findOrCreateStandingAudience(
      queryClient,
      clients,
      'everyone',
    )
    expect(uri).toBe(`at://${DID}/${COLLECTION}/3kb`)
    expect(pds.calls.map(c => c.nsid)).toEqual(['com.atproto.repo.listRecords'])
    expect(prism.calls).toHaveLength(0)
  })

  it('creates the record of 5.2 when none exists, and asks prism to index it', async () => {
    records = [entry('3kb', {mode: 'followers', name: 'Followers'})]
    const {pds, prism, queryClient, clients} = setup()
    const uri = await findOrCreateStandingAudience(
      queryClient,
      clients,
      'followers',
    )
    expect(uri).toBe(createdUri)
    const create = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.policy.manageAudience',
    )
    expect(create?.body?.repo).toBe(DID)
    expect(create?.body?.rkey).toBeUndefined()
    const record = create?.body?.record as Record<string, unknown>
    expect(record.$type).toBe(COLLECTION)
    expect(record.mode).toBe('followers')
    expect(record.name).toBeUndefined()
    expect(typeof record.createdAt).toBe('string')
    expect(record.updatedAt).toBe(record.createdAt)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(prism.calls.map(c => c.nsid)).toEqual([
      'app.nearhorizon.index.requestRecord',
    ])
    expect(prism.calls[0].body?.uri).toBe(createdUri)
  })

  it('a failed create throws', async () => {
    const {queryClient, clients} = setup()
    const failing = fakeClient(DID, call =>
      call.nsid === 'com.atproto.repo.listRecords'
        ? {status: 200, body: {records: []}}
        : {status: 500, body: {error: 'InternalServerError'}},
    )
    await expect(
      findOrCreateStandingAudience(
        queryClient,
        {...clients, pdsClient: failing.client},
        'everyone',
      ),
    ).rejects.toBeDefined()
  })
})

describe('list audiences', () => {
  it('creates a named list with de-duplicated members and without the author', async () => {
    const {pds, queryClient, clients} = setup()
    await createListAudience(queryClient, clients, {
      name: '  Close friends ',
      members: [OTHER_DID, OTHER_DID, DID],
    })
    const create = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.policy.manageAudience',
    )
    const record = create?.body?.record as Record<string, unknown>
    expect(record.mode).toBe('list')
    expect(record.name).toBe('Close friends')
    expect(record.members).toEqual([OTHER_DID])
  })

  it('refuses a name over 64 graphemes or empty', async () => {
    const {queryClient, clients} = setup()
    await expect(
      createListAudience(queryClient, clients, {
        name: 'x'.repeat(65),
        members: [],
      }),
    ).rejects.toBeInstanceOf(AudienceNameInvalidError)
    await expect(
      createListAudience(queryClient, clients, {name: '  ', members: []}),
    ).rejects.toBeInstanceOf(AudienceNameInvalidError)
  })

  it('normalizes members', () => {
    expect(normalizeMembers([OTHER_DID, 'bob.test', DID], DID)).toEqual([
      OTHER_DID,
    ])
  })
})

describe('labels', () => {
  const own = {isSelf: true} as const
  const theirs = {isSelf: false, handle: 'bob.test'} as const
  const e = (mode: string, extra: Partial<AudienceEntry> = {}) => ({
    mode,
    members: [],
    ...extra,
  })

  it('a named record shows its name', () => {
    expect(audienceLabel(e('followers', {name: 'Close friends'}), own)).toBe(
      'Close friends',
    )
  })

  it('unnamed records are worded by mode and whose audience it is', () => {
    expect(audienceLabel(e('everyone'), own)).toBe('Horizon members')
    expect(audienceLabel(e('followers'), own)).toBe('Your followers')
    expect(audienceLabel(e('following'), own)).toBe('People you follow')
    expect(audienceLabel(e('nobody'), own)).toBe('Only you')
    expect(audienceLabel(e('followers'), theirs)).toBe('Followers of @bob.test')
    expect(audienceLabel(e('following'), theirs)).toBe(
      'People @bob.test follows',
    )
    expect(audienceLabel(e('nobody'), theirs)).toBe('Only @bob.test')
    expect(audienceLabel(e('mutuals'), own)).toBe('Custom audience')
  })

  it('an unnamed list counts its people', () => {
    expect(audienceLabel(e('list', {members: [OTHER_DID]}), own)).toBe(
      '1 person',
    )
    expect(audienceLabel(e('list', {members: [OTHER_DID, DID]}), own)).toBe(
      '2 people',
    )
  })
})

describe('the Audiences screen order', () => {
  it('standing audiences first in the fixed order, then lists by label', () => {
    const entries: AudienceEntry[] = [
      {uri: 'list-b', rkey: '3k1', mode: 'list', name: 'Zoo', members: []},
      {uri: 'nobody', rkey: '3k2', mode: 'nobody', members: []},
      {uri: 'everyone', rkey: '3k3', mode: 'everyone', members: []},
      {uri: 'list-a', rkey: '3k4', mode: 'list', name: 'Art', members: []},
      {uri: 'everyone-2', rkey: '3k5', mode: 'everyone', members: []},
    ]
    const {standing, lists} = orderAudiences(entries)
    expect(standing.map(x => x.uri)).toEqual(['everyone', 'nobody'])
    expect(lists.map(x => x.uri)).toEqual(['list-a', 'list-b'])
  })
})

describe('the audience label on a post (7.2)', () => {
  const own: AudienceEntry = {
    uri: AUDIENCE,
    rkey: '3kaudience22',
    mode: 'followers',
    members: [],
  }
  const base = {
    currentDid: DID,
    ownAudiences: undefined,
    record: undefined,
    ownerHandle: undefined,
  }

  it('labels one of the account’s own audiences from its list', () => {
    expect(
      postAudienceLabel({...base, audienceUri: AUDIENCE, ownAudiences: [own]}),
    ).toBe('Your followers')
  })

  it('an own audience missing from the list is a custom audience', () => {
    expect(
      postAudienceLabel({...base, audienceUri: AUDIENCE, ownAudiences: []}),
    ).toBe('a custom audience')
  })

  it('shows nothing while the list loads', () => {
    expect(postAudienceLabel({...base, audienceUri: AUDIENCE})).toBe(undefined)
  })

  it('labels another account’s audience in that account’s terms', () => {
    const record: AudienceEntry = {
      uri: OTHER_AUDIENCE,
      rkey: '3kaudience33',
      mode: 'followers',
      members: [],
    }
    expect(
      postAudienceLabel({...base, audienceUri: OTHER_AUDIENCE, record}),
    ).toBe(undefined)
    expect(
      postAudienceLabel({
        ...base,
        audienceUri: OTHER_AUDIENCE,
        record,
        ownerHandle: 'bob.test',
      }),
    ).toBe('Followers of @bob.test')
    expect(
      postAudienceLabel({
        ...base,
        audienceUri: OTHER_AUDIENCE,
        record: {...record, mode: 'list', name: 'Book club'},
      }),
    ).toBe('Book club')
  })

  it('shows nothing when another account’s record was not read', () => {
    expect(postAudienceLabel({...base, audienceUri: OTHER_AUDIENCE})).toBe(
      undefined,
    )
  })

  it('a post with no audience is visible to its owner only', () => {
    expect(postAudienceLabel({...base, audienceUri: undefined})).toBe(
      'Only you',
    )
  })

  it('reads the record with getRecord at the URI’s repo and rkey', async () => {
    const pds = fakeClient(DID, () => ({
      status: 200,
      body: {
        uri: OTHER_AUDIENCE,
        value: {$type: COLLECTION, mode: 'everyone'},
      },
    }))
    const read = await readAudienceRecordAt(pds.client, OTHER_AUDIENCE)
    expect(read?.mode).toBe('everyone')
    expect(pds.calls[0].nsid).toBe('com.atproto.repo.getRecord')
    expect(pds.calls[0].params.get('repo')).toBe(OTHER_DID)
    expect(pds.calls[0].params.get('collection')).toBe(COLLECTION)
    expect(pds.calls[0].params.get('rkey')).toBe('3kaudience33')
  })
})

/** Any PDS that is not locus: a stock repo route (2K design 2.2). */
const STOCK_PDS = 'https://pds.stock.example'
const LIST_CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'

function nsids(calls: Call[]) {
  return calls.map(call => call.nsid)
}

describe('audience edit and delete by the repo route (2K 4.7, T-11)', () => {
  const LIST = entry('3klist2222222', {
    mode: 'list',
    name: 'Close friends',
    members: [OTHER_DID],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

  async function listed(pds: ReturnType<typeof setup>['pds']) {
    const entries = await listAudiences(pds.client, DID)
    return entries[0]
  }

  it('is offered on repo route stock, not on locus while AUDIENCE_EDIT is off; lists only are edited', () => {
    expect(audienceEditAvailable('stock')).toBe(true)
    expect(audienceEditAvailable('locus')).toBe(false)
    const list: AudienceEntry = {uri: 'u', rkey: 'r', mode: 'list', members: []}
    expect(isEditableAudience(list)).toBe(true)
    expect(isEditableAudience({...list, mode: 'followers'})).toBe(false)
    expect(isEditableAudience({...list, mode: 'everyone'})).toBe(false)
  })

  it('edits a list with putRecord, swapping on the listed CID, whatever the posting route', async () => {
    records = [LIST]
    extraHandler = call =>
      call.nsid === 'com.atproto.repo.putRecord'
        ? {status: 200, body: {uri: LIST.uri, cid: LIST_CID}}
        : undefined
    const {pds, prism, queryClient, clients} = setup(STOCK_PDS)
    const current = await listed(pds)
    expect(current.cid).toBe(LIST_CID)
    // No membership answer: the posting route is `checking`.
    await updateListAudience(queryClient, clients, {
      entry: current,
      name: ' Best friends ',
      members: [OTHER_DID, DID],
    })
    const put = pds.calls.find(c => c.nsid === 'com.atproto.repo.putRecord')
    expect(put?.body).toMatchObject({
      repo: DID,
      collection: COLLECTION,
      rkey: '3klist2222222',
      swapRecord: LIST_CID,
    })
    const record = put?.body?.record as Record<string, unknown>
    expect(record).toMatchObject({
      $type: COLLECTION,
      mode: 'list',
      name: 'Best friends',
      members: [OTHER_DID],
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    expect(record.updatedAt).not.toBe('2026-10-01T00:00:00.000Z')
    expect(nsids(pds.calls)).not.toContain(
      'tools.kryphocron.policy.manageAudience',
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(nsids(prism.calls)).toEqual(['app.nearhorizon.index.requestRecord'])
  })

  it('a stale CID (InvalidSwap, 400 on a stock PDS) is AudienceChangedError', async () => {
    records = [LIST]
    extraHandler = call =>
      call.nsid === 'com.atproto.repo.putRecord'
        ? {status: 400, body: {error: 'InvalidSwap', message: 'swap'}}
        : undefined
    const {pds, queryClient, clients} = setup(STOCK_PDS)
    const error = await updateListAudience(queryClient, clients, {
      entry: await listed(pds),
      name: 'x',
      members: [],
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AudienceChangedError)
    expect((error as Error).message).toBe(
      'This list changed since you opened it. Close and try again.',
    )
  })

  it('never writes an edit without a swap CID', async () => {
    const {pds, queryClient, clients} = setup(STOCK_PDS)
    await expect(
      updateListAudience(queryClient, clients, {
        entry: {
          uri: LIST.uri,
          rkey: '3klist2222222',
          mode: 'list',
          members: [],
        },
        name: 'x',
        members: [],
      }),
    ).rejects.toBeInstanceOf(AudienceChangedError)
    expect(nsids(pds.calls)).not.toContain('com.atproto.repo.putRecord')
  })

  it('deletes any audience with deleteRecord and drops it from the cached list', async () => {
    records = [LIST, entry('3keveryone22', {mode: 'everyone'})]
    extraHandler = call =>
      call.nsid === 'com.atproto.repo.deleteRecord'
        ? {status: 200, body: {}}
        : undefined
    const {pds, queryClient, clients} = setup(STOCK_PDS)
    queryClient.setQueryData(
      audiencesQueryKey(DID),
      await listAudiences(pds.client, DID),
    )
    const everyone = `at://${DID}/${COLLECTION}/3keveryone22`
    await deleteAudience(queryClient, clients, everyone)
    const del = pds.calls.find(c => c.nsid === 'com.atproto.repo.deleteRecord')
    expect(del?.body).toEqual({
      repo: DID,
      collection: COLLECTION,
      rkey: '3keveryone22',
    })
    expect(
      queryClient
        .getQueryData<AudienceEntry[]>(audiencesQueryKey(DID))
        ?.map(item => item.uri),
    ).toEqual([LIST.uri])
  })

  it('on repo route locus with AUDIENCE_EDIT off, edit and delete write nothing', async () => {
    records = [LIST]
    const {pds, queryClient, clients} = setup()
    const current = await listed(pds)
    pds.calls.length = 0
    await expect(
      updateListAudience(queryClient, clients, {
        entry: current,
        name: 'x',
        members: [],
      }),
    ).rejects.toThrow()
    await expect(
      deleteAudience(queryClient, clients, current.uri),
    ).rejects.toThrow()
    expect(pds.calls).toEqual([])
  })

  it('a create on posting route checking or none is refused before any write', async () => {
    const {pds, queryClient, clients} = setup(STOCK_PDS)
    await expect(
      createListAudience(queryClient, clients, {name: 'x', members: []}),
    ).rejects.toBeInstanceOf(PrivateRouteUnavailableError)
    await expect(
      findOrCreateStandingAudience(queryClient, clients, 'everyone'),
    ).rejects.toBeInstanceOf(PrivateRouteUnavailableError)
    expect(pds.calls).toEqual([])
  })
})

describe('PA-5 on the audience writes (T-8)', () => {
  const LIST = entry('3klist2222222', {mode: 'list', name: 'L-13 test'})
  const REFUSALS = [
    'KryphocronRecordRequiresDedicatedEndpoint',
    'KryphocronRecordNotYetSupported',
  ]

  it.each(REFUSALS)(
    'a 400 %s on a delete or an edit shows PA-5’s text and makes the routes locus',
    async refusal => {
      records = [LIST]
      extraHandler = call =>
        call.nsid === 'com.atproto.repo.deleteRecord' ||
        call.nsid === 'com.atproto.repo.putRecord'
          ? {status: 400, body: {error: refusal, message: 'refused'}}
          : undefined
      const {pds, queryClient, clients} = setup(STOCK_PDS)
      const current = (await listAudiences(pds.client, DID))[0]
      const deleted = await deleteAudience(
        queryClient,
        clients,
        current.uri,
      ).catch((e: unknown) => e)
      expect(deleted).toBeInstanceOf(PrivateKryphocronHostError)
      expect((deleted as Error).message).toBe(
        'Your server has its own way to post privately. Try again.',
      )
      expect(repoRouteForDid(DID)).toBe('locus')
      resetWriteRoutes()
      const edited = await updateListAudience(queryClient, clients, {
        entry: current,
        name: 'x',
        members: [],
      }).catch((e: unknown) => e)
      expect(edited).toBeInstanceOf(PrivateKryphocronHostError)
      expect(repoRouteForDid(DID)).toBe('locus')
    },
  )

  it('a generic 400, and a 400 with another name, change no route', async () => {
    for (const body of [
      {error: 'InvalidRequest', message: 'no'},
      {error: 'KryphocronSomethingElse', message: 'no'},
    ]) {
      extraHandler = call =>
        call.nsid === 'com.atproto.repo.deleteRecord'
          ? {status: 400, body}
          : undefined
      const {queryClient, clients} = setup(STOCK_PDS)
      const error = await deleteAudience(queryClient, clients, LIST.uri).catch(
        (e: unknown) => e,
      )
      expect(error).not.toBeInstanceOf(PrivateKryphocronHostError)
      expect(repoRouteForDid(DID)).toBe('stock')
    }
  })
})

describe('the audience cache on repo route stock (4.7, T-11)', () => {
  const LIST = entry('3klist2222222', {mode: 'list', name: 'Close friends'})
  const FOLLOWERS = entry('3kfollowers2', {mode: 'followers'})

  /** A posting writer double, for a standing audience's create. */
  function writer(): PostingWriter & {created: number} {
    const double = {
      route: 'encode' as const,
      created: 0,
      createPost: () => Promise.resolve({cid: undefined}),
      changeAudience: () => Promise.resolve({cid: 'c'}),
      createAudience: () => {
        double.created++
        return Promise.resolve({uri: createdUri})
      },
    }
    return double
  }

  /** The cached list, listed `ageMs` ago. */
  function cache(
    queryClient: QueryClient,
    entries: ReturnType<typeof entry>[],
    ageMs: number,
  ) {
    queryClient.setQueryData(
      audiencesQueryKey(DID),
      entries.map(item => readAudienceRecord(item.uri, item.value, item.cid)),
      {updatedAt: Date.now() - ageMs},
    )
  }

  function answerGetRecord(reply: Reply) {
    extraHandler = call =>
      call.nsid === 'com.atproto.repo.getRecord' ? reply : undefined
  }

  const OLD = CACHED_AUDIENCE_CONFIRM_MS + 1_000

  it('a hit from a list cached under 10 s is used as is', async () => {
    const {pds, queryClient, clients} = setup(STOCK_PDS)
    cache(queryClient, [LIST], 1_000)
    await assertOwnAudienceExists(queryClient, clients, LIST.uri)
    expect(pds.calls).toEqual([])
  })

  it('an older hit is confirmed with one getRecord: present keeps it', async () => {
    answerGetRecord({
      status: 200,
      body: {uri: LIST.uri, cid: LIST_CID, value: LIST.value},
    })
    const {pds, queryClient, clients} = setup(STOCK_PDS)
    cache(queryClient, [LIST], OLD)
    await assertOwnAudienceExists(queryClient, clients, LIST.uri)
    expect(nsids(pds.calls)).toEqual(['com.atproto.repo.getRecord'])
    expect(pds.calls[0].params.get('rkey')).toBe('3klist2222222')
  })

  it('RecordNotFound: the list is fetched fresh, a list is missing, a standing mode is made again', async () => {
    answerGetRecord({
      status: 400,
      body: {error: 'RecordNotFound', message: 'Could not locate record'},
    })
    // The PDS still lists them: absent wins for the one read.
    records = [LIST, FOLLOWERS]
    const first = setup(STOCK_PDS)
    cache(first.queryClient, [LIST], OLD)
    await expect(
      assertOwnAudienceExists(first.queryClient, first.clients, LIST.uri),
    ).rejects.toBeInstanceOf(PrivateAudienceMissingError)
    expect(nsids(first.pds.calls)).toEqual([
      'com.atproto.repo.getRecord',
      'com.atproto.repo.listRecords',
    ])

    records = []
    const second = setup(STOCK_PDS)
    cache(second.queryClient, [FOLLOWERS], OLD)
    const double = writer()
    const uri = await findOrCreateStandingAudience(
      second.queryClient,
      second.clients,
      'followers',
      double,
    )
    expect(uri).toBe(createdUri)
    expect(double.created).toBe(1)
  })

  it.each([
    ['a network error', new Error('offline')],
    ['a 5xx', {status: 502, body: {error: 'BadGateway'}}],
    ['a 429', {status: 429, body: {error: 'RateLimitExceeded'}}],
  ] as [string, Reply][])(
    '%s on the getRecord: the list fetched fresh decides',
    async (_name, reply) => {
      answerGetRecord(reply)
      records = [LIST]
      const {pds, queryClient, clients} = setup(STOCK_PDS)
      cache(queryClient, [LIST], OLD)
      await assertOwnAudienceExists(queryClient, clients, LIST.uri)
      expect(nsids(pds.calls)).toEqual([
        'com.atproto.repo.getRecord',
        'com.atproto.repo.listRecords',
      ])
      records = []
      cache(queryClient, [LIST], OLD)
      await expect(
        assertOwnAudienceExists(queryClient, clients, LIST.uri),
      ).rejects.toBeInstanceOf(PrivateAudienceMissingError)
    },
  )

  it('when the fresh list fails too, the write fails with the PDS’s error', async () => {
    extraHandler = call =>
      call.nsid === 'com.atproto.repo.getRecord' ||
      call.nsid === 'com.atproto.repo.listRecords'
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    const {queryClient, clients} = setup(STOCK_PDS)
    cache(queryClient, [LIST], OLD)
    const error = await assertOwnAudienceExists(
      queryClient,
      clients,
      LIST.uri,
    ).catch((e: unknown) => e)
    expect(error).toBeDefined()
    expect(error).not.toBeInstanceOf(PrivateAudienceMissingError)
  })

  it('on repo route locus an older hit is trusted, as before', async () => {
    const {pds, queryClient, clients} = setup()
    cache(queryClient, [LIST], OLD)
    await assertOwnAudienceExists(queryClient, clients, LIST.uri)
    expect(pds.calls).toEqual([])
  })
})
