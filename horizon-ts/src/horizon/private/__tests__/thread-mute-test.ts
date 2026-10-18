import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMember = true
jest.mock('#/horizon/routing/membership', () => ({
  isPrivateMember: (did?: string) => !!did && mockMember,
  reportPrismError: () => {},
}))
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  loadPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {
  mirrorThreadMute,
  muteThreadOnPrism,
  resetThreadMuteResync,
  resyncPublicThreadMute,
} from '../api/thread-mute'
import {DID, fakeClient, OTHER_DID, privateUri, type Reply} from './fixtures'

const PRIVATE_ROOT = privateUri('3kroot2222222', OTHER_DID)
const PUBLIC_ROOT = `at://${OTHER_DID}/app.bsky.feed.post/3kroot2222222`

let prism: ReturnType<typeof fakeClient>
let prismReply: Reply

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

beforeEach(() => {
  mockMember = true
  prismReply = {status: 200, body: {}}
  prism = fakeClient(DID, () => prismReply)
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'reader.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: {} as never,
  })
  resetPrismFeatures()
  resetThreadMuteResync()
  answerPrismFeatures(DID, ['private', 'private.interactions'])
})

describe('thread mutes with prism (2H design 7, T10)', () => {
  it('a private root is muted and unmuted on prism', async () => {
    expect(await muteThreadOnPrism(PRIVATE_ROOT, true)).toEqual({})
    expect(await muteThreadOnPrism(PRIVATE_ROOT, false)).toEqual({})
    expect(prism.calls.map(call => call.nsid)).toEqual([
      'app.bsky.graph.muteThread',
      'app.bsky.graph.unmuteThread',
    ])
    expect(prism.calls[0].body).toEqual({root: PRIVATE_ROOT})
  })

  it('a prism failure rejects the private mutation', async () => {
    prismReply = {status: 500, body: {error: 'InternalServerError'}}
    await expect(muteThreadOnPrism(PRIVATE_ROOT, true)).rejects.toThrow()
  })

  it("a public root's mute is mirrored for a member with the feature", async () => {
    mirrorThreadMute(PUBLIC_ROOT, true)
    mirrorThreadMute(PUBLIC_ROOT, false)
    await settle()
    expect(prism.calls.map(call => call.nsid)).toEqual([
      'app.bsky.graph.muteThread',
      'app.bsky.graph.unmuteThread',
    ])
  })

  it('a mirror failure is swallowed', async () => {
    prismReply = {status: 500, body: {error: 'InternalServerError'}}
    expect(() => mirrorThreadMute(PUBLIC_ROOT, true)).not.toThrow()
    await settle()
    expect(prism.calls).toHaveLength(1)
  })

  it('no mirror for a non-member, without the feature, before this run\u{2019}s answer, or for a private root', async () => {
    mockMember = false
    mirrorThreadMute(PUBLIC_ROOT, true)
    mockMember = true
    resetPrismFeatures()
    answerPrismFeatures(DID, ['private'])
    mirrorThreadMute(PUBLIC_ROOT, true)
    resetPrismFeatures()
    loadPrismFeatures(DID, ['private', 'private.interactions'])
    mirrorThreadMute(PUBLIC_ROOT, true)
    answerPrismFeatures(DID, ['private', 'private.interactions'])
    mirrorThreadMute(PRIVATE_ROOT, true)
    await settle()
    expect(prism.calls).toEqual([])
  })

  it('re-sync moves prism to Bluesky\u{2019}s state once (H-5)', async () => {
    resyncPublicThreadMute(PUBLIC_ROOT, false, true)
    resyncPublicThreadMute(PUBLIC_ROOT, false, true)
    resyncPublicThreadMute(PUBLIC_ROOT, true, true)
    resyncPublicThreadMute(PUBLIC_ROOT, undefined, false)
    await settle()
    expect(prism.calls.map(call => call.nsid)).toEqual([
      'app.bsky.graph.unmuteThread',
    ])
    resyncPublicThreadMute(PUBLIC_ROOT, true, false)
    await settle()
    expect(prism.calls.map(call => call.nsid)).toEqual([
      'app.bsky.graph.unmuteThread',
      'app.bsky.graph.muteThread',
    ])
  })
})
