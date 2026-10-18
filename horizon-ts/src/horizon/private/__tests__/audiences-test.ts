import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {
  type AudienceEntry,
  audienceLabel,
  AudienceNameInvalidError,
  createListAudience,
  findOrCreateStandingAudience,
  listAudiences,
  normalizeMembers,
  orderAudiences,
  pickStandingAudience,
  postAudienceLabel,
  readAudienceRecord,
  readAudienceRecordAt,
} from '../api/audiences'
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

function pdsHandler(call: Call): Reply {
  if (call.nsid === 'com.atproto.repo.listRecords') {
    return {status: 200, body: {records}}
  }
  if (call.nsid === 'tools.kryphocron.policy.manageAudience') {
    return {status: 200, body: {uri: createdUri, cid: 'commitcid'}}
  }
  return {status: 404, body: {error: 'NotFound'}}
}

function setup() {
  const pds = fakeClient(DID, pdsHandler)
  const prism = fakeClient(DID, () => ({
    status: 200,
    body: {status: 'indexed'},
  }))
  const queryClient = new QueryClient()
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
    expect(audienceLabel(e('everyone'), own)).toBe('Everyone')
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
