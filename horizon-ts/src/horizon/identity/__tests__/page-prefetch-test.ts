import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 4.6, B-6, ID-23: a page's identities are warmed as it
 * arrives, in one batched S-2 call (pronouns, system and the members its
 * fronter posts name; never the front), and a later page that names
 * fronters waits up to 250 ms for them while a first page, a refetch and a
 * pull-to-refresh never wait.
 */

jest.mock(
  '#/state/session/network',
  () => jest.requireActual<{networkMock: unknown}>('./harness').networkMock,
)
jest.mock('#/state/session', () => ({useMaybePdsClient: () => null}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
jest.unmock('multiformats/cid')

import {type QueryClient} from '@tanstack/react-query'

import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'
import * as switches from '#/horizon/switches'
import {
  collectPageIdentities,
  isLaterPage,
  LATER_PAGE_WAIT_MS,
  prefetchPageIdentities,
} from '../page-prefetch'
import {identityQueryKey, setIdentityRunStart} from '../queries'
import {resetIdentityReads} from '../reads'
import {resetIdentitySchedule, setIdentityVisibility} from '../schedule'
import {
  AUTHOR,
  callsOf,
  json,
  MEMBER,
  newQueryClient,
  OTHER,
  prism,
  records,
  resetHarness,
  SPARROW,
  SYSTEM,
  uriOf,
  world,
  worldAnswer,
  WREN,
} from './harness'

const START = 1_790_000_000_000
const QUOTED = 'did:plc:quotedccccccccccccccccc'
let qc: QueryClient

function postView(did: string, rkey: string, fronters?: string[]) {
  return {
    uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    cid: 'bafyreiaaaa',
    author: {did, handle: `${rkey}.example`},
    record: {
      $type: 'app.bsky.feed.post',
      text: 'hi',
      createdAt: '2026-10-24T12:00:00.000Z',
      ...(fronters
        ? {[PLURAL_FRONTERS_KEY]: {members: fronters.map(id => ({id}))}}
        : {}),
    },
    indexedAt: '2026-10-24T12:00:00.000Z',
  }
}

/** A feed page: a reply by AUTHOR (as Wren) to OTHER, quoting QUOTED. */
function feedPage() {
  const post = {
    ...postView(AUTHOR, '3m4kq9post222', [WREN]),
    embed: {
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: `at://${QUOTED}/app.bsky.feed.post/3m4kq9quote22`,
        cid: 'bafyreibbbb',
        author: {did: QUOTED, handle: 'quoted.example'},
        value: {
          $type: 'app.bsky.feed.post',
          text: 'quoted',
          createdAt: '2026-10-24T12:00:00.000Z',
          [PLURAL_FRONTERS_KEY]: {members: [{id: SPARROW}]},
        },
        indexedAt: '2026-10-24T12:00:00.000Z',
      },
    },
  }
  const parent = postView(OTHER, '3m4kq9parent2')
  return [{post, reply: {root: parent, parent}}]
}

beforeEach(() => {
  jest.useFakeTimers({now: START})
  resetHarness()
  resetIdentityReads()
  resetIdentitySchedule()
  setIdentityVisibility({isVisible: () => true, subscribe: () => () => {}})
  setIdentityRunStart(START)
  qc = newQueryClient()
  for (const did of [AUTHOR, QUOTED]) {
    world.records.set(uriOf(did, SYSTEM), records.system())
  }
  world.records.set(uriOf(AUTHOR, MEMBER, WREN), records.member('Wren'))
  world.records.set(uriOf(QUOTED, MEMBER, SPARROW), records.member('Sparrow'))
})

afterEach(() => {
  qc.clear()
  jest.useRealTimers()
})

describe('collectPageIdentities', () => {
  it('finds post authors, quoted authors, reply parents and every named fronter', () => {
    const page = collectPageIdentities(feedPage())
    expect([...page.dids].sort()).toEqual([AUTHOR, OTHER, QUOTED].sort())
    expect(page.fronters).toEqual(
      expect.arrayContaining([
        {did: AUTHOR, rkeys: [WREN]},
        {did: QUOTED, rkeys: [SPARROW]},
      ]),
    )
  })

  it('walks thread items and notification pages as they are', () => {
    const thread = [
      {uri: 'x', depth: 0, value: {post: postView(AUTHOR, '3m4kq9anchor2')}},
    ]
    expect(collectPageIdentities(thread).dids).toEqual([AUTHOR])
    const notifications = [{type: 'reply', post: postView(OTHER, '3m4kq9repl22')}]
    expect(collectPageIdentities(notifications).dids).toEqual([OTHER])
  })

  it('ignores a fronters value that does not read as fronters', () => {
    const bad = postView(AUTHOR, '3m4kq9post222')
    ;(bad.record as Record<string, unknown>)[PLURAL_FRONTERS_KEY] = {
      members: [],
    }
    expect(collectPageIdentities([{post: bad}]).fronters).toEqual([])
  })
})

describe('prefetchPageIdentities', () => {
  it('makes one S-2 call for a page, with the named members, never asking for the front', async () => {
    await prefetchPageIdentities(qc, feedPage())
    await jest.advanceTimersByTimeAsync(100)
    const calls = callsOf('getRecords')
    expect(calls).toHaveLength(1)
    expect([...calls[0].params.getAll('actors')].sort()).toEqual(
      [AUTHOR, OTHER, QUOTED].sort(),
    )
    expect([...calls[0].params.getAll('members')].sort()).toEqual(
      [uriOf(AUTHOR, MEMBER, WREN), uriOf(QUOTED, MEMBER, SPARROW)].sort(),
    )
    expect(
      qc.getQueryData(identityQueryKey('member', {did: AUTHOR, rkey: WREN})),
    ).toMatchObject({kind: 'record'})
    // A second page with the same authors asks nothing more.
    await prefetchPageIdentities(qc, feedPage())
    await jest.advanceTimersByTimeAsync(100)
    expect(callsOf('getRecords')).toHaveLength(1)
  })

  it('a later page that names fronters waits for their answers, at most 250 ms', async () => {
    let release: () => void = () => {}
    prism.answer = call =>
      new Promise(resolve => {
        release = () => resolve(worldAnswer(call))
      })
    let done = false
    void prefetchPageIdentities(qc, feedPage(), {later: true}).then(() => {
      done = true
    })
    await jest.advanceTimersByTimeAsync(LATER_PAGE_WAIT_MS - 10)
    expect(done).toBe(false)
    await jest.advanceTimersByTimeAsync(20)
    expect(done).toBe(true)
    release()
  })

  it('a later page resolves as soon as the answers land', async () => {
    let done = false
    void prefetchPageIdentities(qc, feedPage(), {later: true}).then(() => {
      done = true
    })
    await jest.advanceTimersByTimeAsync(60)
    expect(done).toBe(true)
  })

  it('a first page never waits', async () => {
    prism.answer = () => new Promise<Response>(() => {})
    let done = false
    void prefetchPageIdentities(qc, feedPage()).then(() => {
      done = true
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('a later page without fronters never waits', async () => {
    prism.answer = () => new Promise<Response>(() => {})
    let done = false
    void prefetchPageIdentities(qc, [{post: postView(OTHER, '3m4kq9plain22')}], {
      later: true,
    }).then(() => {
      done = true
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('never throws, and a failed call leaves nothing behind but negative entries', async () => {
    prism.answer = () => json({error: 'InternalServerError'}, 500)
    const done = prefetchPageIdentities(qc, feedPage(), {later: true})
    await jest.advanceTimersByTimeAsync(LATER_PAGE_WAIT_MS + 50)
    await expect(done).resolves.toBeUndefined()
  })

  it('with both switches off asks nothing', async () => {
    jest.replaceProperty(switches, 'PRONOUNS', false)
    jest.replaceProperty(switches, 'PLURAL_DISPLAY', false)
    await prefetchPageIdentities(qc, feedPage(), {later: true})
    await jest.advanceTimersByTimeAsync(100)
    expect(prism.calls).toHaveLength(0)
  })
})

describe('isLaterPage', () => {
  const key = ['feed', 'following']

  it('is a later page only for the cursor the cached last page ends with', () => {
    expect(isLaterPage(qc, key, undefined)).toBe(false)
    qc.setQueryData(key, {
      pages: [{cursor: 'c1'}, {cursor: 'c2'}],
      pageParams: [undefined, {cursor: 'c1'}],
    })
    // fetchNextPage asks with the last page's cursor.
    expect(isLaterPage(qc, key, 'c2')).toBe(true)
    // A refetch asks page 2 again with page 1's cursor.
    expect(isLaterPage(qc, key, 'c1')).toBe(false)
    // A first page has no cursor.
    expect(isLaterPage(qc, key, undefined)).toBe(false)
  })

  it('is not a later page for an uncached query', () => {
    expect(isLaterPage(qc, ['nothing'], 'c1')).toBe(false)
  })
})
