import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMember = true
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => (mockMember ? 'member' : 'not-member'),
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
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {
  fetchPrivateLikesPage,
  fetchPrivateQuotesPage,
  fetchPrivateRepostedByPage,
} from '../api/interactions'
import {DID, OTHER_DID, privateUri, RECORD_CID, type Reply} from './fixtures'
import {at, fakeAppview, fakePrism, privateView} from './read-fixtures'

const POST = privateUri('3kpost2222222', OTHER_DID)
const LIKER = 'did:plc:likerccccccccccccccccccc'
const PUBLIC_QUOTE = `at://${LIKER}/app.bsky.feed.post/3kquote222222`
const MISSING_QUOTE = `at://${LIKER}/app.bsky.feed.post/3kgone2222222`

let prismHandler: (nsid: string, params: URLSearchParams) => Reply | undefined

function setup({
  appview = fakeAppview({
    profiles: [{did: LIKER, handle: 'liker.test', displayName: 'Public Liker'}],
    posts: [
      {
        uri: PUBLIC_QUOTE,
        cid: RECORD_CID,
        author: {did: LIKER, handle: 'liker.test'},
        record: {
          $type: 'app.bsky.feed.post',
          text: 'quoting',
          createdAt: at(1),
        },
        indexedAt: at(1),
      },
    ],
  }),
  publish = true,
}: {appview?: ReturnType<typeof fakeAppview>; publish?: boolean} = {}) {
  const prism = fakePrism({
    handler: (nsid, params) => prismHandler(nsid, params),
  })
  clearCurrentClients()
  if (publish) {
    publishCurrentClients({
      did: DID,
      handle: 'reader.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: prism.client,
      appviewClient: appview.client,
    })
  }
  return {prism, appview}
}

beforeEach(() => {
  mockMember = true
  prismHandler = () => undefined
  resetPrismFeatures()
  answerPrismFeatures(DID, ['private', 'private.interactions'])
})

describe('interaction lists (2H design 8, T11)', () => {
  it('lists likes through prism, drops malformed items and merges actors', async () => {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.getLikes'
        ? {
            status: 200,
            body: {
              uri: POST,
              cursor: 'next',
              likes: [
                {
                  indexedAt: at(2),
                  createdAt: at(2),
                  actor: {did: LIKER, handle: 'liker.test'},
                },
                {indexedAt: at(3), createdAt: at(3)},
              ],
            },
          }
        : undefined
    const {prism} = setup()
    const page = await fetchPrivateLikesPage(POST, 'c1', 30)
    expect(page.cursor).toBe('next')
    expect(page.likes).toHaveLength(1)
    expect(page.likes[0].actor.displayName).toBe('Public Liker')
    expect(prism.calls[0].nsid).toBe('app.nearhorizon.private.getLikes')
    expect(prism.calls[0].params.get('uri')).toBe(POST)
    expect(prism.calls[0].params.get('cursor')).toBe('c1')
    expect(prism.calls[0].params.get('limit')).toBe('30')
  })

  it('lists reposters through prism, merged with public profiles', async () => {
    prismHandler = nsid =>
      nsid === 'app.nearhorizon.private.getRepostedBy'
        ? {
            status: 200,
            body: {
              uri: POST,
              repostedBy: [{did: LIKER, handle: 'liker.test'}, {handle: 'x'}],
            },
          }
        : undefined
    setup()
    const page = await fetchPrivateRepostedByPage(POST, undefined, 30)
    expect(page.repostedBy.map(p => p.displayName)).toEqual(['Public Liker'])
    expect(page.cursor).toBeUndefined()
  })

  it('asks nothing for a non-member, without the feature, or signed out', async () => {
    const {prism} = setup()
    mockMember = false
    expect((await fetchPrivateLikesPage(POST, undefined, 30)).likes).toEqual([])
    mockMember = true
    resetPrismFeatures()
    answerPrismFeatures(DID, ['private'])
    expect(
      (await fetchPrivateRepostedByPage(POST, undefined, 30)).repostedBy,
    ).toEqual([])
    expect((await fetchPrivateQuotesPage(POST, undefined, 30)).posts).toEqual(
      [],
    )
    answerPrismFeatures(DID, ['private', 'private.interactions'])
    clearCurrentClients()
    expect((await fetchPrivateLikesPage(POST, undefined, 30)).likes).toEqual([])
    expect(prism.calls).toEqual([])
  })

  it('lists quotes in prism\u{2019}s order, hydrating public refs in one read and following empty pages', async () => {
    const quoting = privateView('3kquoting2222', {did: OTHER_DID, minutes: 2})
    prismHandler = (nsid, params) => {
      if (nsid !== 'app.nearhorizon.private.getQuotes') return undefined
      if (!params.get('cursor')) {
        return {status: 200, body: {uri: POST, posts: [], cursor: 'p2'}}
      }
      return {
        status: 200,
        body: {
          uri: POST,
          posts: [
            {
              $type: 'app.nearhorizon.private.defs#publicPostRef',
              uri: PUBLIC_QUOTE,
              cid: RECORD_CID,
            },
            {$type: 'app.nearhorizon.private.defs#privatePostView', ...quoting},
            {
              $type: 'app.nearhorizon.private.defs#publicPostRef',
              uri: MISSING_QUOTE,
              cid: RECORD_CID,
            },
            {$type: 'app.nearhorizon.private.defs#somethingElse'},
          ],
          cursor: 'p3',
        },
      }
    }
    const {prism, appview} = setup()
    const page = await fetchPrivateQuotesPage(POST, undefined, 30)
    expect(page.posts.map(p => p.uri)).toEqual([PUBLIC_QUOTE, quoting.uri])
    expect(page.cursor).toBe('p3')
    expect(prism.calls.map(c => c.params.get('cursor'))).toEqual([null, 'p2'])
    const getPosts = appview.calls.filter(
      c => c.nsid === 'app.bsky.feed.getPosts',
    )
    expect(getPosts).toHaveLength(1)
    expect(getPosts[0].params.getAll('uris').sort()).toEqual(
      [MISSING_QUOTE, PUBLIC_QUOTE].sort(),
    )
  })
})
