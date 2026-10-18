import {describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  isPrivateMember: (did?: string) => !!did,
  reportPrismError: () => {},
}))

import {type app} from '#/lexicons'
import {fetchPrivateSearchLoad, SEARCH_PAGES_PER_LOAD} from '../search/fetch'
import {mergeSearchResults} from '../search/merge'
import {buildPrivateSearchQuery, privateSearchQ} from '../search/query'
import {DID} from './fixtures'
import {at, fakeAppview, fakePrism, privateView} from './read-fixtures'

type PostView = app.bsky.feed.defs.PostView

const VIEWER = DID

function q(query: string, filters = {}, fromMe = false) {
  const terms = buildPrivateSearchQuery({
    query,
    filters,
    fromMe,
    viewerDid: VIEWER,
  })
  const authorDid =
    terms.author && 'did' in terms.author ? terms.author.did : undefined
  return {...terms, q: privateSearchQ(terms, authorDid)}
}

describe('the private search query (2H design 11.3, T14)', () => {
  it('keeps plain words and tags, splitting quoted phrases', () => {
    const terms = q('hello "big world" #tag')
    expect(terms.q).toBe('hello big world #tag')
    expect(terms.ignoredSomething).toBe(false)
  })

  it('reads the author from from:me, fromMe, filters and a DID', () => {
    expect(q('cats from:me').q).toBe(`cats from:${VIEWER}`)
    expect(q('cats', {}, true).q).toBe(`cats from:${VIEWER}`)
    expect(q('cats', {from: 'me'}).q).toBe(`cats from:${VIEWER}`)
    expect(q('cats from:did:plc:abc').q).toBe('cats from:did:plc:abc')
    expect(q('cats', {author: 'did:plc:abc'}).q).toBe('cats from:did:plc:abc')
    expect(q('from:me').q).toBe(`from:${VIEWER}`)
  })

  it('leaves a handle for the caller to resolve', () => {
    expect(q('cats from:@Alice.test').author).toEqual({handle: 'alice.test'})
    expect(q('cats', {author: 'bob.test'}).author).toEqual({
      handle: 'bob.test',
    })
  })

  it('leaves out other operators, negations, groups and filters', () => {
    for (const [query, filters] of [
      ['cats lang:en', {}],
      ['cats -dogs', {}],
      ['cats (a OR b)', {}],
      ['cats', {lang: 'en'}],
      ['cats', {since: '2026-01-01'}],
      ['cats from:did:plc:a from:did:plc:b', {}],
    ] as const) {
      const terms = q(query, filters)
      expect(terms.q?.startsWith('cats')).toBe(true)
      expect(terms.ignoredSomething).toBe(true)
    }
  })

  it('has nothing to search without a word or an author', () => {
    expect(q('lang:en').q).toBeUndefined()
    expect(q('-dogs').q).toBeUndefined()
  })
})

describe('a private search load (2H design 11.3, T14)', () => {
  it('reads at most three pages while they come back empty', async () => {
    let pages = 0
    const prism = fakePrism({
      handler: nsid => {
        if (nsid !== 'app.nearhorizon.private.searchPosts') return undefined
        pages++
        return {status: 200, body: {posts: [], cursor: `c${pages}`}}
      },
    })
    const appview = fakeAppview()
    const load = await fetchPrivateSearchLoad(
      {did: DID, prism: prism.client, appview: appview.client},
      'cats',
      undefined,
    )
    expect(pages).toBe(SEARCH_PAGES_PER_LOAD)
    expect(load.posts).toEqual([])
    expect(load.cursor).toBe('c3')
    expect(prism.calls[0].params.get('sort')).toBe('latest')
    expect(prism.calls[0].params.get('q')).toBe('cats')
    expect(prism.calls[0].params.get('limit')).toBe('25')
  })

  it('stops at the first page with a match, dropping malformed items', async () => {
    const match = privateView('3kmatch222222', {minutes: 2})
    const prism = fakePrism({
      handler: (nsid, params) => {
        if (nsid !== 'app.nearhorizon.private.searchPosts') return undefined
        return params.get('cursor')
          ? {status: 200, body: {posts: [match, {uri: 'x'}], cursor: 'end'}}
          : {status: 200, body: {posts: [], cursor: 'p2'}}
      },
    })
    const load = await fetchPrivateSearchLoad(
      {did: DID, prism: prism.client, appview: fakeAppview().client},
      'cats',
      undefined,
    )
    expect(load.posts.map(p => p.uri)).toEqual([match.uri])
    expect(load.cursor).toBe('end')
  })
})

describe('merging private results into the tabs (H-2, T14)', () => {
  function post(name: string, minutes: number): PostView {
    return {
      uri: `at://did:plc:x/app.bsky.feed.post/${name}`,
      cid: 'c',
      author: {did: 'did:plc:x', handle: 'x.test'},
      record: {$type: 'app.bsky.feed.post', text: name, createdAt: at(minutes)},
      indexedAt: at(minutes),
    } as PostView
  }
  const names = (posts: PostView[]) => posts.map(p => p.uri.split('/').pop())

  it('merges Latest by time and holds older private results while public has more', () => {
    const pub = [post('p9', 9), post('p5', 5), post('p3', 3)]
    const priv = [post('x7', 7), post('x4', 4), post('x1', 1)]
    const more = mergeSearchResults(pub, priv, {
      sort: 'latest',
      publicHasMore: true,
    })
    expect(names(more.posts)).toEqual(['p9', 'x7', 'p5', 'x4', 'p3'])
    expect(more.held).toBe(1)
    const end = mergeSearchResults(pub, priv, {
      sort: 'latest',
      publicHasMore: false,
    })
    expect(names(end.posts)).toEqual(['p9', 'x7', 'p5', 'x4', 'p3', 'x1'])
    expect(end.held).toBe(0)
  })

  it('spreads private results through Top, one after every two public', () => {
    const pub = ['a', 'b', 'c', 'd', 'e'].map((n, i) => post(n, 10 - i))
    const priv = [post('x1', 1), post('x2', 2), post('x3', 3), post('x4', 4)]
    const more = mergeSearchResults(pub, priv, {
      sort: 'top',
      publicHasMore: true,
    })
    expect(names(more.posts)).toEqual([
      'x1',
      'a',
      'b',
      'x2',
      'c',
      'd',
      'x3',
      'e',
    ])
    expect(more.held).toBe(1)
    const end = mergeSearchResults(pub, priv, {
      sort: 'top',
      publicHasMore: false,
    })
    expect(names(end.posts).slice(-1)).toEqual(['x4'])
    expect(end.held).toBe(0)
  })

  it('leaves the public list untouched without private results', () => {
    const pub = [post('a', 1)]
    expect(
      mergeSearchResults(pub, [], {sort: 'top', publicHasMore: true}).posts,
    ).toBe(pub)
  })
})
