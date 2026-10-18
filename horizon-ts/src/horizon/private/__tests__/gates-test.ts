import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/private/adapt/pds', () => ({
  authorPdsUrl: () => Promise.resolve(undefined),
}))

import {type Client} from '@atproto/lex'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'
import {
  evaluatePrivateGates,
  fetchPrivateGateEvaluation,
  needsRelationship,
  privateGatesQueryKey,
  readPrivateGates,
  readRootThreadgate,
  rootUriOf,
} from '../api/gates'
import {replySummary} from '../composer/interaction'
import {
  postSettingsAudience,
  postSettingsChanges,
} from '../settings/post-settings'
import {clearPrivateStores} from '../store'
import {type Call, DID, fakeClient, OTHER_DID, privateUri} from './fixtures'

const READER = 'did:plc:readerccccccccccccccccccc'
const ROOT = privateUri('3kroot2222222', OTHER_DID)
const REPLY = privateUri('3kreply222222', DID)
const NOW = '2026-10-15T12:00:00.000Z'

type Threadgate = app.bsky.feed.threadgate.Main
type Postgate = app.bsky.feed.postgate.Main

function threadgate(allow?: {$type: string; list?: string}[]): Threadgate {
  return {
    $type: 'app.bsky.feed.threadgate',
    post: ROOT,
    createdAt: NOW,
    ...(allow ? {allow} : {}),
  } as Threadgate
}

function postgate(disabled: boolean, post = REPLY): Postgate {
  return {
    $type: 'app.bsky.feed.postgate',
    post,
    createdAt: NOW,
    embeddingRules: disabled
      ? [{$type: 'app.bsky.feed.postgate#disableRule'}]
      : [],
  } as Postgate
}

const RULE = {
  mention: {$type: 'app.bsky.feed.threadgate#mentionRule'},
  follower: {$type: 'app.bsky.feed.threadgate#followerRule'},
  following: {$type: 'app.bsky.feed.threadgate#followingRule'},
  list: {
    $type: 'app.bsky.feed.threadgate#listRule',
    list: `at://${OTHER_DID}/app.bsky.graph.list/3klist2222222`,
  },
}

function evaluate(
  overrides: Partial<Parameters<typeof evaluatePrivateGates>[0]> = {},
) {
  return evaluatePrivateGates({
    reader: READER,
    rootAuthor: OTHER_DID,
    postAuthor: DID,
    threadgate: undefined,
    postgate: undefined,
    ...overrides,
  })
}

describe('evaluatePrivateGates (7.4.2)', () => {
  it('allows replies without a threadgate or without allow', () => {
    expect(evaluate().replyDisabled).toBe(false)
    expect(evaluate({threadgate: threadgate()}).replyDisabled).toBe(false)
  })

  it('an empty allow disables replies for a reader but not the root’s author', () => {
    expect(evaluate({threadgate: threadgate([])}).replyDisabled).toBe(true)
    expect(
      evaluate({threadgate: threadgate([]), reader: OTHER_DID}).replyDisabled,
    ).toBe(false)
  })

  it('a follower rule is met when the reader follows the root’s author', () => {
    const gate = threadgate([RULE.follower])
    const met = {following: true, followedBy: false}
    const unmet = {following: false, followedBy: true}
    expect(evaluate({threadgate: gate, relationship: met}).replyDisabled).toBe(
      false,
    )
    expect(
      evaluate({threadgate: gate, relationship: unmet}).replyDisabled,
    ).toBe(true)
    // Undecidable without the relationship: fail-open.
    expect(evaluate({threadgate: gate}).replyDisabled).toBe(false)
  })

  it('a following rule is met when the root’s author follows the reader', () => {
    const gate = threadgate([RULE.following])
    expect(
      evaluate({
        threadgate: gate,
        relationship: {following: false, followedBy: true},
      }).replyDisabled,
    ).toBe(false)
    expect(
      evaluate({
        threadgate: gate,
        relationship: {following: true, followedBy: false},
      }).replyDisabled,
    ).toBe(true)
  })

  it('a mention rule is decided only from known mention facets', () => {
    const gate = threadgate([RULE.mention])
    expect(evaluate({threadgate: gate}).replyDisabled).toBe(false)
    expect(
      evaluate({threadgate: gate, mentionedDids: [READER]}).replyDisabled,
    ).toBe(false)
    expect(
      evaluate({threadgate: gate, mentionedDids: [DID]}).replyDisabled,
    ).toBe(true)
  })

  it('a list rule cannot be decided and allows', () => {
    expect(
      evaluate({
        threadgate: threadgate([RULE.list]),
        relationship: {following: false, followedBy: false},
      }).replyDisabled,
    ).toBe(false)
  })

  it('mixed rules allow when one is met', () => {
    const gate = threadgate([RULE.mention, RULE.follower])
    expect(
      evaluate({
        threadgate: gate,
        mentionedDids: [],
        relationship: {following: true, followedBy: false},
      }).replyDisabled,
    ).toBe(false)
    expect(
      evaluate({
        threadgate: gate,
        mentionedDids: [],
        relationship: {following: false, followedBy: false},
      }).replyDisabled,
    ).toBe(true)
  })

  it('a disabling postgate disables quotes for a reader, not for the post’s author', () => {
    expect(evaluate({postgate: postgate(true)}).embeddingDisabled).toBe(true)
    expect(
      evaluate({postgate: postgate(true), reader: DID}).embeddingDisabled,
    ).toBe(false)
    expect(evaluate({postgate: postgate(false)}).embeddingDisabled).toBe(false)
  })

  it('needs the relationship only for follower and following rules', () => {
    expect(needsRelationship(threadgate([RULE.mention, RULE.list]))).toBe(false)
    expect(needsRelationship(threadgate([RULE.following]))).toBe(true)
    expect(needsRelationship(undefined)).toBe(false)
  })
})

/**
 * A fake PDS per DID: `records` by `<collection>/<rkey>`, or an error reply.
 */
function pdsFor(
  did: string,
  records: Record<string, unknown>,
  calls: {did: string; call: Call}[],
) {
  return fakeClient(did, call => {
    calls.push({did, call})
    const key = `${call.params.get('collection')}/${call.params.get('rkey')}`
    if (!(key in records)) {
      return {status: 400, body: {error: 'RecordNotFound', message: 'none'}}
    }
    const value = records[key]
    if (value instanceof Error) return value
    return {
      status: 200,
      body: {uri: `at://${did}/${key}`, value},
    }
  }).client
}

describe('readPrivateGates and readRootThreadgate', () => {
  it('reads the threadgate from the root author’s PDS and the postgate from the post author’s', async () => {
    const calls: {did: string; call: Call}[] = []
    const clients: Record<string, Client> = {
      [OTHER_DID]: pdsFor(
        OTHER_DID,
        {'app.bsky.feed.threadgate/3kroot2222222': threadgate([])},
        calls,
      ),
      [DID]: pdsFor(
        DID,
        {'app.bsky.feed.postgate/3kreply222222': postgate(true)},
        calls,
      ),
    }
    const asked: string[] = []
    const gates = await readPrivateGates(ROOT, REPLY, did => {
      asked.push(did)
      return Promise.resolve(clients[did])
    })
    expect(asked.sort()).toEqual([DID, OTHER_DID].sort())
    expect(gates.threadgate?.allow).toEqual([])
    expect(gates.postgate?.embeddingRules).toEqual([
      {$type: 'app.bsky.feed.postgate#disableRule'},
    ])
    expect(calls.find(c => c.did === OTHER_DID)?.call.params.get('repo')).toBe(
      OTHER_DID,
    )
  })

  it('treats RecordNotFound as no gate', async () => {
    const calls: {did: string; call: Call}[] = []
    const gates = await readPrivateGates(ROOT, REPLY, did =>
      Promise.resolve(pdsFor(did, {}, calls)),
    )
    expect(gates).toEqual({threadgate: undefined, postgate: undefined})
  })

  it('ignores a gate whose post names another URI (a public post at the same rkey)', async () => {
    const calls: {did: string; call: Call}[] = []
    const other = `at://${OTHER_DID}/app.bsky.feed.post/3kroot2222222`
    const gates = await readPrivateGates(ROOT, REPLY, did =>
      Promise.resolve(
        pdsFor(
          did,
          {
            'app.bsky.feed.threadgate/3kroot2222222': {
              ...threadgate([]),
              post: other,
            },
            'app.bsky.feed.postgate/3kreply222222': postgate(true, other),
          },
          calls,
        ),
      ),
    )
    expect(gates).toEqual({threadgate: undefined, postgate: undefined})
  })

  it('readRootThreadgate reads from the root author’s PDS and throws on failure', async () => {
    const asked: string[] = []
    const calls: {did: string; call: Call}[] = []
    const gate = await readRootThreadgate(ROOT, did => {
      asked.push(did)
      return Promise.resolve(
        pdsFor(
          did,
          {
            'app.bsky.feed.threadgate/3kroot2222222': threadgate([
              RULE.mention,
            ]),
          },
          calls,
        ),
      )
    })
    expect(asked).toEqual([OTHER_DID])
    expect(gate?.allow).toEqual([RULE.mention])
    await expect(
      readRootThreadgate(ROOT, did =>
        Promise.resolve(
          pdsFor(
            did,
            {'app.bsky.feed.threadgate/3kroot2222222': new Error('offline')},
            calls,
          ),
        ),
      ),
    ).rejects.toBeDefined()
  })
})

describe('fetchPrivateGateEvaluation', () => {
  beforeEach(() => {
    clearPrivateStores()
    clearCurrentClients()
  })

  it('reads the relationship for a follower rule and evaluates as the current account', async () => {
    const appview = fakeClient(READER, call => {
      if (call.nsid !== 'app.bsky.graph.getRelationships') {
        return {status: 501, body: {error: 'MethodNotImplemented'}}
      }
      return {
        status: 200,
        body: {
          actor: READER,
          relationships: [
            {
              $type: 'app.bsky.graph.defs#relationship',
              did: OTHER_DID,
            },
          ],
        },
      }
    })
    publishCurrentClients({
      did: READER,
      handle: 'reader.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: appview.client,
    })
    const calls: {did: string; call: Call}[] = []
    const evaluation = await fetchPrivateGateEvaluation(ROOT, REPLY, did =>
      Promise.resolve(
        pdsFor(
          did,
          {
            'app.bsky.feed.threadgate/3kroot2222222': threadgate([
              RULE.follower,
            ]),
            'app.bsky.feed.postgate/3kreply222222': postgate(true),
          },
          calls,
        ),
      ),
    )
    expect(evaluation).toEqual({replyDisabled: true, embeddingDisabled: true})
    const rel = appview.calls.find(
      c => c.nsid === 'app.bsky.graph.getRelationships',
    )
    expect(rel?.params.get('actor')).toBe(READER)
    expect(rel?.params.getAll('others')).toEqual([OTHER_DID])
  })

  it('fails open on a relationship failure', async () => {
    const appview = fakeClient(READER, () => ({status: 500, body: {}}))
    publishCurrentClients({
      did: READER,
      handle: 'reader.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: {} as never,
      appviewClient: appview.client,
    })
    const calls: {did: string; call: Call}[] = []
    const evaluation = await fetchPrivateGateEvaluation(ROOT, REPLY, did =>
      Promise.resolve(
        pdsFor(
          did,
          {
            'app.bsky.feed.threadgate/3kroot2222222': threadgate([
              RULE.following,
            ]),
          },
          calls,
        ),
      ),
    )
    expect(evaluation.replyDisabled).toBe(false)
  })
})

describe('gate helpers', () => {
  it('keys every post of a thread under the root', () => {
    expect(privateGatesQueryKey(ROOT, REPLY).slice(0, 2)).toEqual(
      privateGatesQueryKey(ROOT),
    )
  })

  it('finds the root of a reply, else the post itself', () => {
    expect(rootUriOf(REPLY, {reply: {root: {uri: ROOT}}})).toBe(ROOT)
    expect(rootUriOf(ROOT, {text: 'x'})).toBe(ROOT)
  })

  it('summarises who can reply', () => {
    expect(replySummary([{type: 'everybody'}])).toBe('anyone')
    expect(replySummary([{type: 'nobody'}])).toBe('nobody')
    expect(replySummary([{type: 'mention'}])).toBe('limited')
  })
})

describe('the post settings dialog’s helpers (7.8)', () => {
  const STANDING = `at://${DID}/tools.kryphocron.policy.audience/3kstanding222`
  const LIST = `at://${DID}/tools.kryphocron.policy.audience/3klist2222222`
  const audiences = [
    {uri: STANDING, rkey: '3kstanding222', mode: 'followers', members: []},
    {
      uri: LIST,
      rkey: '3klist2222222',
      mode: 'list',
      name: 'Close',
      members: [],
    },
  ]

  it('shows a standing audience as its mode, a list as a list, a reply as its conversation’s', () => {
    expect(
      postSettingsAudience({audienceUri: STANDING, isReply: false, audiences}),
    ).toEqual({kind: 'mode', mode: 'followers'})
    expect(
      postSettingsAudience({audienceUri: LIST, isReply: false, audiences}),
    ).toEqual({kind: 'list', uri: LIST})
    expect(
      postSettingsAudience({audienceUri: LIST, isReply: true, audiences}),
    ).toEqual({kind: 'parent', uri: LIST})
    expect(
      postSettingsAudience({audienceUri: undefined, isReply: false, audiences}),
    ).toEqual({kind: 'mode', mode: 'nobody'})
  })

  it('saves only what changed', () => {
    const loadedPostgate = postgate(false)
    expect(
      postSettingsChanges({
        loadedThreadgate: [{type: 'everybody'}],
        editedThreadgate: [{type: 'everybody'}],
        loadedPostgate,
        editedPostgate: postgate(false),
      }),
    ).toEqual({threadgate: undefined, postgate: undefined})
    const changed = postSettingsChanges({
      loadedThreadgate: [{type: 'mention'}],
      editedThreadgate: [{type: 'everybody'}],
      loadedPostgate,
      editedPostgate: postgate(true),
    })
    expect(changed.threadgate).toEqual([{type: 'everybody'}])
    expect(changed.postgate?.embeddingRules).toEqual([
      {$type: 'app.bsky.feed.postgate#disableRule'},
    ])
  })
})
