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
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {resetWriteRoutes} from '#/horizon/routing/write-route'
import {
  assertOwnAudienceExists,
  AudienceChangedError,
  audienceEditAvailable,
  type AudienceEntry,
  AudienceLimitError,
  AudienceMembersLimitError,
  audiencesQueryKey,
  CACHED_AUDIENCE_CONFIRM_MS,
  createListAudience,
  deleteAudience,
  deleteLeftoverRepoAudiences,
  findOrCreateStandingAudience,
  loadAudiences,
  postAudienceLabel,
  updateListAudience,
} from '../api/audiences'
import {type Call, DID, fakeClient, OTHER_DID, type Reply} from './fixtures'

const COLLECTION = 'tools.kryphocron.policy.audience'
const REPO_CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'
/** The jest setup's locus origin. */
const LOCUS_PDS = 'https://pds.example'
/** Any PDS that is not locus: a stock repo route. */
const STOCK_PDS = 'https://pds.stock.example'

i18n.loadAndActivate({locale: 'en', messages: {}})

const uri = (rkey: string) => `at://${DID}/${COLLECTION}/${rkey}`

/** prism's rows, as `listAudiences` answers them. */
let prismRows: {uri: string; cid: string; record: Record<string, unknown>}[]
/** The repo's records, as `listRecords` answers them. */
let repoRecords: {uri: string; cid: string; value: Record<string, unknown>}[]
let prismExtra: ((call: Call) => Reply | undefined) | undefined

function prismHandler(call: Call): Reply {
  const extra = prismExtra?.(call)
  if (extra) return extra
  switch (call.nsid) {
    case 'app.nearhorizon.private.listAudiences':
      return {status: 200, body: {audiences: prismRows}}
    case 'app.nearhorizon.private.createAudience':
      return {status: 200, body: {uri: uri('3kprismnew'), cid: 'v1'}}
    case 'app.nearhorizon.private.updateAudience':
      return {status: 200, body: {uri: call.body?.uri, cid: 'v2'}}
    case 'app.nearhorizon.private.deleteAudience':
      return {status: 200, body: {}}
    default:
      return {status: 200, body: {status: 'indexed'}}
  }
}

function pdsHandler(call: Call): Reply {
  if (call.nsid === 'com.atproto.repo.listRecords') {
    return {status: 200, body: {records: repoRecords}}
  }
  return {status: 200, body: {}}
}

function setup({
  onPrism = true,
  pdsUrl = STOCK_PDS,
}: {onPrism?: boolean; pdsUrl?: string} = {}) {
  const pds = fakeClient(DID, pdsHandler)
  const prism = fakeClient(DID, prismHandler)
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
  answerPrismFeatures(
    DID,
    onPrism ? ['private', 'private.audiences'] : ['private'],
  )
  return {
    pds,
    prism,
    queryClient,
    clients: {did: DID, pdsClient: pds.client, prismClient: prism.client},
  }
}

function nsids(calls: Call[]) {
  return calls.map(call => call.nsid)
}

const LIST_RECORD = {
  $type: COLLECTION,
  mode: 'list',
  name: 'Close friends',
  members: [OTHER_DID],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

beforeEach(() => {
  prismRows = []
  repoRecords = []
  prismExtra = undefined
  resetWriteRoutes()
  resetPrismFeatures()
})

describe('where audiences are read from', () => {
  it('reads prism, every page, once it lists private.audiences', async () => {
    const {pds, prism, clients} = setup()
    prismExtra = call => {
      if (call.nsid !== 'app.nearhorizon.private.listAudiences') return
      return call.params.get('cursor')
        ? {
            status: 200,
            body: {
              audiences: [
                {uri: uri('3kb'), cid: 'v1', record: {mode: 'nobody'}},
              ],
            },
          }
        : {
            status: 200,
            body: {
              cursor: 'next',
              audiences: [{uri: uri('3ka'), cid: 'v9', record: LIST_RECORD}],
            },
          }
    }
    const entries = await loadAudiences(clients)
    expect(entries.map(entry => [entry.rkey, entry.mode, entry.cid])).toEqual([
      ['3ka', 'list', 'v9'],
      ['3kb', 'nobody', 'v1'],
    ])
    expect(entries[0].members).toEqual([OTHER_DID])
    expect(nsids(prism.calls)).toEqual([
      'app.nearhorizon.private.listAudiences',
      'app.nearhorizon.private.listAudiences',
    ])
    expect(nsids(pds.calls)).toEqual([])
  })

  it('reads the repo until prism lists the feature', async () => {
    const {pds, prism, clients} = setup({onPrism: false})
    repoRecords = [{uri: uri('3ka'), cid: REPO_CID, value: LIST_RECORD}]
    const entries = await loadAudiences(clients)
    expect(entries).toHaveLength(1)
    expect(nsids(pds.calls)).toEqual(['com.atproto.repo.listRecords'])
    expect(nsids(prism.calls)).toEqual([])
  })
})

describe('writes on prism', () => {
  it('creates a standing audience on prism, with no repo write and no requestRecord', async () => {
    const {pds, prism, queryClient, clients} = setup({pdsUrl: LOCUS_PDS})
    const created = await findOrCreateStandingAudience(
      queryClient,
      clients,
      'followers',
    )
    expect(created).toBe(uri('3kprismnew'))
    const create = prism.calls.find(
      call => call.nsid === 'app.nearhorizon.private.createAudience',
    )
    expect(create?.body?.record).toMatchObject({
      $type: COLLECTION,
      mode: 'followers',
    })
    // The list read that found none, then the create; no requestRecord.
    expect(nsids(prism.calls)).toEqual([
      'app.nearhorizon.private.listAudiences',
      'app.nearhorizon.private.createAudience',
    ])
    expect(nsids(pds.calls)).toEqual([])
  })

  it('creates a list on prism with its members cleaned', async () => {
    const {pds, prism, queryClient, clients} = setup()
    await createListAudience(queryClient, clients, {
      name: '  Close friends ',
      members: [OTHER_DID, OTHER_DID, DID, 'alice.test'],
    })
    const create = prism.calls.find(
      call => call.nsid === 'app.nearhorizon.private.createAudience',
    )
    expect(create?.body?.record).toMatchObject({
      mode: 'list',
      name: 'Close friends',
      members: [OTHER_DID],
    })
    expect(nsids(pds.calls)).toEqual([])
  })

  it('words prism’s audience cap', async () => {
    const {queryClient, clients} = setup()
    prismExtra = call =>
      call.nsid === 'app.nearhorizon.private.createAudience'
        ? {status: 400, body: {error: 'LimitReached', message: 'cap'}}
        : undefined
    await expect(
      createListAudience(queryClient, clients, {
        name: 'One more',
        members: [OTHER_DID],
      }),
    ).rejects.toBeInstanceOf(AudienceLimitError)
  })

  it('refuses more than 1000 people before sending anything', async () => {
    const {prism, queryClient, clients} = setup()
    const members = Array.from(
      {length: 1001},
      (_, i) => `did:plc:${String(i).padStart(24, 'a')}`,
    )
    await expect(
      createListAudience(queryClient, clients, {name: 'Everyone', members}),
    ).rejects.toBeInstanceOf(AudienceMembersLimitError)
    expect(nsids(prism.calls)).toEqual([])
  })

  const LISTED: AudienceEntry = {
    uri: uri('3klist'),
    rkey: '3klist',
    mode: 'list',
    name: 'Close friends',
    members: [OTHER_DID],
    cid: 'v7',
    createdAt: '2026-10-01T00:00:00.000Z',
  }

  it('edits a list on prism, swapped on the listed token, on locus too', async () => {
    const {pds, prism, queryClient, clients} = setup({pdsUrl: LOCUS_PDS})
    expect(audienceEditAvailable('locus', true)).toBe(true)
    await updateListAudience(queryClient, clients, {
      entry: LISTED,
      name: 'Closest',
      members: [OTHER_DID],
    })
    const update = prism.calls.find(
      call => call.nsid === 'app.nearhorizon.private.updateAudience',
    )
    expect(update?.body).toMatchObject({
      uri: LISTED.uri,
      swapCid: 'v7',
      record: {name: 'Closest', createdAt: LISTED.createdAt},
    })
    expect(nsids(pds.calls)).toEqual([])
  })

  it('reads a stale token as a changed list', async () => {
    const {queryClient, clients} = setup()
    prismExtra = call =>
      call.nsid === 'app.nearhorizon.private.updateAudience'
        ? {status: 400, body: {error: 'InvalidSwap', message: 'swap'}}
        : undefined
    await expect(
      updateListAudience(queryClient, clients, {
        entry: LISTED,
        name: 'Closest',
        members: [],
      }),
    ).rejects.toBeInstanceOf(AudienceChangedError)
  })

  it('deletes on prism and drops the entry from the cache', async () => {
    const {pds, prism, queryClient, clients} = setup({pdsUrl: LOCUS_PDS})
    queryClient.setQueryData(audiencesQueryKey(DID), [LISTED])
    await deleteAudience(queryClient, clients, LISTED.uri)
    expect(
      prism.calls.find(
        call => call.nsid === 'app.nearhorizon.private.deleteAudience',
      )?.body,
    ).toEqual({uri: LISTED.uri})
    expect(nsids(pds.calls)).toEqual([])
  })

  it('checks an older cached hit against a fresh prism list, not the repo', async () => {
    const {pds, prism, queryClient, clients} = setup()
    prismRows = [{uri: LISTED.uri, cid: 'v7', record: LIST_RECORD}]
    await loadAudiences(clients)
    queryClient.setQueryData(audiencesQueryKey(DID), [LISTED], {
      updatedAt: Date.now() - CACHED_AUDIENCE_CONFIRM_MS - 1,
    })
    prismRows = []
    await expect(
      assertOwnAudienceExists(queryClient, clients, LISTED.uri),
    ).rejects.toThrow()
    expect(nsids(pds.calls)).toEqual([])
    expect(
      nsids(prism.calls).filter(
        nsid => nsid === 'app.nearhorizon.private.listAudiences',
      ),
    ).toHaveLength(2)
  })
})

describe('the repo copies left behind', () => {
  it('deletes each one on a stock PDS', async () => {
    const {pds, clients} = setup()
    repoRecords = [
      {uri: uri('3ka'), cid: REPO_CID, value: LIST_RECORD},
      {uri: uri('3kb'), cid: REPO_CID, value: {mode: 'followers'}},
    ]
    expect(await deleteLeftoverRepoAudiences(clients)).toBe(2)
    const deletes = pds.calls.filter(
      call => call.nsid === 'com.atproto.repo.deleteRecord',
    )
    expect(deletes.map(call => call.body?.rkey)).toEqual(['3ka', '3kb'])
  })

  it('deletes through aurora’s procedure on locus', async () => {
    const {pds, clients} = setup({pdsUrl: LOCUS_PDS})
    repoRecords = [{uri: uri('3ka'), cid: REPO_CID, value: LIST_RECORD}]
    expect(await deleteLeftoverRepoAudiences(clients)).toBe(1)
    expect(
      pds.calls.find(
        call => call.nsid === 'tools.kryphocron.policy.deleteAudience',
      )?.body,
    ).toEqual({repo: DID, rkey: '3ka'})
  })

  it('touches nothing until prism lists the feature', async () => {
    const {pds, clients} = setup({onPrism: false})
    repoRecords = [{uri: uri('3ka'), cid: REPO_CID, value: LIST_RECORD}]
    expect(await deleteLeftoverRepoAudiences(clients)).toBe(0)
    expect(nsids(pds.calls)).toEqual([])
  })
})

describe('another account’s unnamed audience', () => {
  const source = {
    audienceUri: `at://${OTHER_DID}/${COLLECTION}/3kx`,
    currentDid: DID,
    ownAudiences: [],
    record: undefined,
    ownerHandle: 'bob.test',
  }

  it('reads “a custom audience” once prism holds audiences', () => {
    expect(postAudienceLabel({...source, recordsHeld: 'prism'})).toBe(
      'a custom audience',
    )
  })

  it('waits for the record while audiences are repo records', () => {
    expect(postAudienceLabel(source)).toBeUndefined()
  })
})
