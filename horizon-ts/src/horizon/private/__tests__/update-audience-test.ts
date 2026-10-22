import {beforeAll, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockEncodeAudienceChange = false
jest.mock('#/horizon/private/server-support', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/private/server-support')},
    {
      ENCODE_AUDIENCE_CHANGE: {
        get: () => mockEncodeAudienceChange,
        enumerable: true,
      },
    },
  ),
)

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {computeCid} from '#/lib/api/computeCid'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {PrivateAudienceMissingError} from '../api/audiences'
import {
  audienceChangeOffered,
  canChangePostAudience,
  changePrivatePostAudience,
  PrivatePostChangedError,
  readOwnPostForSettings,
} from '../api/update-audience'
import {PrivateRouteUnavailableError} from '../api/writer'
import {
  addPendingPost,
  clearPrivateStores,
  getPendingPost,
  getPrivatePostFacts,
  setPrivatePostFacts,
} from '../store'
import {
  AUDIENCE,
  type Call,
  DID,
  fakeClient,
  privateUri,
  type Reply,
} from './fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

const AUD = 'tools.kryphocron.policy.audience'
const FOLLOWERS = `at://${DID}/${AUD}/3kfollowers2`
const POST = privateUri('3kpost222222')

let cids: string[] = []

beforeAll(async () => {
  cids = await Promise.all([1, 2, 3].map(n => computeCid({n} as never)))
})

let pdsHandler: (call: Call) => Reply
let pds: ReturnType<typeof fakeClient>
let prism: ReturnType<typeof fakeClient>

function clients() {
  return {did: DID, pdsClient: pds.client, prismClient: prism.client}
}

beforeEach(() => {
  clearPrivateStores()
  pdsHandler = call => {
    switch (call.nsid) {
      case 'com.atproto.repo.listRecords':
        return {
          status: 200,
          body: {
            records: [
              {
                uri: FOLLOWERS,
                cid: cids[2],
                value: {$type: AUD, mode: 'followers'},
              },
              {
                uri: AUDIENCE,
                cid: cids[2],
                value: {$type: AUD, mode: 'list', name: 'Close', members: []},
              },
            ],
          },
        }
      case 'tools.kryphocron.feed.updatePostPrivate':
        return {status: 200, body: {uri: POST, cid: cids[1]}}
      default:
        return {status: 501, body: {error: 'MethodNotImplemented'}}
    }
  }
  pds = fakeClient(DID, call => pdsHandler(call))
  prism = fakeClient(DID, () => ({status: 200, body: {status: 'indexed'}}))
  // Pending posts are the signed-in account's.
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl: 'https://pds.example',
    pdsClient: pds.client,
    prismClient: prism.client,
    appviewClient: prism.client,
  })
  clearPrivateStores()
})

describe('canChangePostAudience (7.8.1, A-13)', () => {
  it('allows a top-level post and a branch root, and no other reply', () => {
    expect(canChangePostAudience({isReply: false, parentUri: undefined})).toBe(
      true,
    )
    expect(
      canChangePostAudience({
        isReply: true,
        parentUri: `at://${DID}/app.bsky.feed.post/3kpublic22222`,
      }),
    ).toBe(true)
    expect(
      canChangePostAudience({isReply: true, parentUri: privateUri('3kp')}),
    ).toBe(false)
    expect(canChangePostAudience({isReply: true, parentUri: undefined})).toBe(
      false,
    )
  })
})

describe('changePrivatePostAudience', () => {
  it('sends updatePostPrivate with the swap, takes the CID from the answer, asks prism and updates the facts', async () => {
    setPrivatePostFacts(POST, {audienceUri: FOLLOWERS, isPending: false})
    const result = await changePrivatePostAudience({
      queryClient: new QueryClient(),
      clients: clients(),
      postUri: POST,
      swapCid: cids[0],
      audience: {kind: 'list', uri: AUDIENCE},
    })
    const update = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.feed.updatePostPrivate',
    )
    expect(update?.body).toEqual({
      repo: DID,
      rkey: '3kpost222222',
      audienceList: AUDIENCE,
      swapRecord: cids[0],
    })
    // prism's answer carries no caughtUp here, so it reads false (5.7).
    expect(result).toEqual({
      audienceUri: AUDIENCE,
      cid: cids[1],
      caughtUp: false,
    })
    // No getRecord: the answer carries the record CID (A-1).
    expect(pds.calls.map(c => c.nsid)).not.toContain(
      'com.atproto.repo.getRecord',
    )
    expect(prism.calls.map(c => c.nsid)).toContain(
      'app.nearhorizon.index.requestRecord',
    )
    expect(getPrivatePostFacts(POST)).toEqual({
      audienceUri: AUDIENCE,
      isPending: false,
      audiencePin: {uri: AUDIENCE, until: expect.any(Number)},
    })
  })

  it('returns caughtUp true when prism answers it', async () => {
    prism = fakeClient(DID, () => ({
      status: 200,
      body: {status: 'indexed', caughtUp: true},
    }))
    const result = await changePrivatePostAudience({
      queryClient: new QueryClient(),
      clients: clients(),
      postUri: POST,
      swapCid: cids[0],
      audience: {kind: 'list', uri: AUDIENCE},
    })
    expect(result.caughtUp).toBe(true)
  })

  it('a standing mode resolves to the account’s standing audience', async () => {
    await changePrivatePostAudience({
      queryClient: new QueryClient(),
      clients: clients(),
      postUri: POST,
      swapCid: cids[0],
      audience: {kind: 'mode', mode: 'followers'},
    })
    const update = pds.calls.find(
      c => c.nsid === 'tools.kryphocron.feed.updatePostPrivate',
    )
    expect(update?.body?.audienceList).toBe(FOLLOWERS)
  })

  it('updates a pending post’s CID and record, so a reply names the current version', async () => {
    addPendingPost({
      uri: POST,
      cid: cids[0],
      did: DID,
      record: {
        $type: 'tools.kryphocron.feed.postPrivate',
        text: 'hi',
        createdAt: '2026-10-16T00:00:00.000Z',
        audienceList: FOLLOWERS,
      } as never,
      audienceUri: FOLLOWERS,
      postView: {uri: POST, cid: cids[0]} as never,
      feedItem: {post: {uri: POST, cid: cids[0]}} as never,
      createdAt: '2026-10-16T00:00:00.000Z',
      expiresAt: Date.now() + 60_000,
    })
    await changePrivatePostAudience({
      queryClient: new QueryClient(),
      clients: clients(),
      postUri: POST,
      swapCid: cids[0],
      audience: {kind: 'list', uri: AUDIENCE},
    })
    const pending = getPendingPost(POST)
    expect(pending?.cid).toBe(cids[1])
    expect(pending?.record.audienceList).toBe(AUDIENCE)
    expect(pending?.postView.cid).toBe(cids[1])
    expect(getPrivatePostFacts(POST)?.isPending).toBe(true)
  })

  it('a 409 is PrivatePostChangedError and changes nothing', async () => {
    setPrivatePostFacts(POST, {audienceUri: FOLLOWERS, isPending: false})
    const base = pdsHandler
    pdsHandler = call =>
      call.nsid === 'tools.kryphocron.feed.updatePostPrivate'
        ? {status: 409, body: {error: 'InvalidSwap', message: 'swap'}}
        : base(call)
    const error = await changePrivatePostAudience({
      queryClient: new QueryClient(),
      clients: clients(),
      postUri: POST,
      swapCid: cids[0],
      audience: {kind: 'list', uri: AUDIENCE},
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivatePostChangedError)
    expect((error as Error).message).toBe(
      'This post changed since you opened its settings. Close and try again.',
    )
    expect(getPrivatePostFacts(POST)?.audienceUri).toBe(FOLLOWERS)
    expect(prism.calls).toHaveLength(0)
  })

  it('a list the account no longer has is refused before any update', async () => {
    await expect(
      changePrivatePostAudience({
        queryClient: new QueryClient(),
        clients: clients(),
        postUri: POST,
        swapCid: cids[0],
        audience: {kind: 'list', uri: `at://${DID}/${AUD}/3kgone222222`},
      }),
    ).rejects.toBeInstanceOf(PrivateAudienceMissingError)
    expect(pds.calls.map(c => c.nsid)).not.toContain(
      'tools.kryphocron.feed.updatePostPrivate',
    )
  })
})

describe('Who can see by posting route (2K 8.1, T-13b)', () => {
  it('is offered on locus, never on checking or none, and on encode only with ENCODE_AUDIENCE_CHANGE', () => {
    mockEncodeAudienceChange = false
    expect(audienceChangeOffered('locus')).toBe(true)
    expect(audienceChangeOffered('checking')).toBe(false)
    expect(audienceChangeOffered('none')).toBe(false)
    expect(audienceChangeOffered('encode')).toBe(false)
    mockEncodeAudienceChange = true
    expect(audienceChangeOffered('encode')).toBe(true)
    expect(audienceChangeOffered('none')).toBe(false)
    mockEncodeAudienceChange = false
  })

  it('on any other PDS the change is refused before any read or write', async () => {
    clearCurrentClients()
    publishCurrentClients({
      did: DID,
      handle: 'alice.test',
      pdsUrl: 'https://pds.stock.example',
      pdsClient: pds.client,
      prismClient: prism.client,
      appviewClient: prism.client,
    })
    await expect(
      changePrivatePostAudience({
        queryClient: new QueryClient(),
        clients: clients(),
        postUri: POST,
        swapCid: cids[0],
        audience: {kind: 'mode', mode: 'followers'},
      }),
    ).rejects.toBeInstanceOf(PrivateRouteUnavailableError)
    expect(pds.calls).toEqual([])
    expect(prism.calls).toEqual([])
  })
})

describe('readOwnPostForSettings', () => {
  it('reads the record CID and whether it is a branch root from the PDS', async () => {
    pdsHandler = () => ({
      status: 200,
      body: {
        uri: POST,
        cid: cids[2],
        value: {
          $type: 'tools.kryphocron.feed.postPrivate',
          text: 'branch',
          createdAt: '2026-10-16T00:00:00.000Z',
          audienceList: FOLLOWERS,
          reply: {
            root: {
              uri: `at://${DID}/app.bsky.feed.post/3kroot2222222`,
              cid: cids[0],
            },
            parent: {
              uri: `at://${DID}/app.bsky.feed.post/3kpar22222222`,
              cid: cids[0],
            },
          },
        },
      },
    })
    const read = await readOwnPostForSettings(pds.client, POST)
    expect(read?.cid).toBe(cids[2])
    expect(read?.fields.audienceList).toBe(FOLLOWERS)
    expect(
      canChangePostAudience({
        isReply: read?.fields.isReply ?? false,
        parentUri: read?.fields.parent?.uri,
      }),
    ).toBe(true)
  })

  it('answers nothing when the PDS read fails', async () => {
    pdsHandler = () => ({status: 500, body: {error: 'Oops'}})
    await expect(readOwnPostForSettings(pds.client, POST)).resolves.toBe(
      undefined,
    )
  })
})
