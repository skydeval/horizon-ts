import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; lex payloads check CIDs with the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMenuOn = true

jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {COMPOSER_AUDIENCE_MENU: {get: () => mockMenuOn, enumerable: true}},
  ),
)

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {gatesForNewPost} from '../api/gates'
import {
  createReplyList,
  REPLY_LIST_BATCH,
  ReplyListPartlyCreatedError,
} from '../api/reply-lists'
import {type Call, DID, fakeClient, OTHER_DID, type Reply} from './fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

type Write = {
  collection: string
  rkey: string
  value: Record<string, unknown>
}

function writesOf(call: Call): Write[] {
  return (call.body?.writes ?? []) as Write[]
}

beforeEach(() => {
  mockMenuOn = true
})

describe('createReplyList (5.5)', () => {
  it('writes the list first, then one listitem per de-duplicated member without the author, in one applyWrites', async () => {
    const {client, calls} = fakeClient(DID, () => ({status: 200, body: {}}))
    const queryClient = new QueryClient()
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries')
    const uri = await createReplyList(
      queryClient,
      {pdsClient: client, did: DID},
      {name: '  Close friends ', members: [OTHER_DID, DID, OTHER_DID]},
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].nsid).toBe('com.atproto.repo.applyWrites')
    const writes = writesOf(calls[0])
    expect(writes.map(w => w.collection)).toEqual([
      'app.bsky.graph.list',
      'app.bsky.graph.listitem',
    ])
    expect(uri).toBe(`at://${DID}/app.bsky.graph.list/${writes[0].rkey}`)
    expect(writes[0].value).toMatchObject({
      $type: 'app.bsky.graph.list',
      purpose: 'app.bsky.graph.defs#curatelist',
      name: 'Close friends',
    })
    expect(writes[1].value).toMatchObject({
      $type: 'app.bsky.graph.listitem',
      subject: OTHER_DID,
      list: uri,
    })
    expect(invalidate).toHaveBeenCalledWith({queryKey: ['my-lists']})
  })

  it('writes 200 at a time, the list in the first batch', async () => {
    const {client, calls} = fakeClient(DID, () => ({status: 200, body: {}}))
    const members = Array.from(
      {length: 450},
      (_, i) => `did:plc:member${String(i).padStart(18, 'a')}`,
    )
    await createReplyList(
      new QueryClient(),
      {pdsClient: client, did: DID},
      {name: 'Many', members},
    )
    expect(calls.map(call => writesOf(call).length)).toEqual([
      REPLY_LIST_BATCH,
      REPLY_LIST_BATCH,
      51,
    ])
    expect(writesOf(calls[0])[0].collection).toBe('app.bsky.graph.list')
    expect(
      calls
        .slice(1)
        .flatMap(writesOf)
        .every(w => w.collection === 'app.bsky.graph.listitem'),
    ).toBe(true)
  })

  it('a later batch failing says the list was created', async () => {
    let n = 0
    const {client} = fakeClient(DID, (): Reply =>
      n++ === 0
        ? {status: 200, body: {}}
        : {status: 500, body: {error: 'Oops'}},
    )
    const members = Array.from(
      {length: 250},
      (_, i) => `did:plc:member${String(i).padStart(18, 'a')}`,
    )
    const error = await createReplyList(
      new QueryClient(),
      {pdsClient: client, did: DID},
      {name: 'Many', members},
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ReplyListPartlyCreatedError)
    expect((error as Error).message).toBe(
      'The list was created, but some people could not be added.',
    )
  })

  it('a first batch failing throws as it is; a bad name writes nothing', async () => {
    const {client, calls} = fakeClient(DID, () => ({
      status: 500,
      body: {error: 'Oops'},
    }))
    const error = await createReplyList(
      new QueryClient(),
      {pdsClient: client, did: DID},
      {name: 'A', members: []},
    ).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(ReplyListPartlyCreatedError)
    calls.length = 0
    await expect(
      createReplyList(
        new QueryClient(),
        {pdsClient: client, did: DID},
        {name: '   ', members: []},
      ),
    ).rejects.toBeDefined()
    expect(calls).toHaveLength(0)
  })
})

describe('gatesForNewPost', () => {
  const uris = [
    `at://${DID}/tools.kryphocron.feed.postPrivate/3kone2222222`,
    `at://${DID}/tools.kryphocron.feed.postPrivate/3ktwo2222222`,
  ]
  const postgate = {
    embeddingRules: [{$type: 'app.bsky.feed.postgate#disableRule'}],
  } as never

  it('writes nothing with COMPOSER_AUDIENCE_MENU off', () => {
    mockMenuOn = false
    expect(
      gatesForNewPost({
        threadgate: [{type: 'nobody'}],
        postgate,
        postUris: uris,
        isReply: false,
      }),
    ).toEqual([])
  })

  it('a threadgate for the root only, a postgate per post', () => {
    const writes = gatesForNewPost({
      threadgate: [{type: 'nobody'}],
      postgate,
      postUris: uris,
      isReply: false,
    })
    expect(writes.map(w => [w.collection, w.rkey])).toEqual([
      ['app.bsky.feed.threadgate', '3kone2222222'],
      ['app.bsky.feed.postgate', '3kone2222222'],
      ['app.bsky.feed.postgate', '3ktwo2222222'],
    ])
    expect(writes[0].record).toMatchObject({post: uris[0], allow: []})
  })
})
