import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {type AtUriString} from '@atproto/syntax'
import {QueryClient} from '@tanstack/react-query'
import {act, renderHook} from '@testing-library/react-native'

/*
 * T-5's registry cases (prism busy design 4, BR-5): verdicts, the suspect
 * clock, the own-post PDS check, `served` and its order, `isSyncing`,
 * holds, `gatedAt`.
 */
import {
  getPrivatePostsAnswered,
  getPrivateTimeline,
} from '#/horizon/private/api/reads'
import {
  answeredSince,
  findCachedPrivatePostView,
  gatedAt,
  gateUris,
  heldQueries,
  hold,
  isSyncing,
  missVerdict,
  noteAnswered,
  noteMiss,
  noteOmissions,
  noteServed,
  REGISTRY_CAP,
  resetKnown,
  servedSince,
  servedUrisOf,
  suspectRefetchInterval,
  suspectRetryAt,
  SYNCING_AFTER_MS,
  useIsSyncing,
} from '#/horizon/private/known'
import {
  addPendingPost,
  clearPrivateStores,
  PENDING_TTL_MS,
  type PendingPost,
} from '#/horizon/private/store'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {
  reportProbeStatus,
  reportReadOutcome,
  resetPrismHealth,
} from '#/horizon/routing/health'
import {resetMembership} from '#/horizon/routing/membership'
import {type Call, DID, fakeClient, OTHER_DID, type Reply} from './fixtures'
import {privateView} from './read-fixtures'

const OWN = privateView('3kown2222222').uri
const OTHER = privateView('3kother22222', {did: OTHER_DID}).uri

let now = 1_000_000
let pdsCalls: Call[] = []
let pdsReply: (call: Call) => Reply

function answer(seq: number, extra: Partial<Parameters<typeof noteOmissions>[0]> = {}) {
  return {
    did: DID,
    seq,
    degraded: false,
    retryAfterMs: undefined,
    unavailable: [],
    ...extra,
  }
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

function publish(prism?: ReturnType<typeof fakeClient>, qc?: QueryClient) {
  const pds = fakeClient(DID, call => pdsReply(call))
  pdsCalls = pds.calls
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl: 'https://pds.example',
    pdsClient: pds.client,
    prismClient: prism?.client,
    appviewClient: pds.client,
    queryClient: qc,
  } as unknown as CurrentClients)
}

beforeEach(() => {
  now = 1_000_000
  resetPrismHealth({now: () => now, random: () => 0.5})
  resetMembership()
  resetPrismFeatures()
  resetKnown()
  clearPrivateStores()
  pdsReply = () => ({status: 500, body: {error: 'InternalServerError'}})
  publish()
})

afterEach(() => {
  clearCurrentClients()
})

describe('verdicts (4, BR-5)', () => {
  it('another author’s miss is never real: unknown unless signalled, however many answers miss it', () => {
    for (let seq = 1; seq <= 8; seq++) {
      expect(noteMiss(answer(seq), OTHER)).toBe('unknown')
    }
    expect(missVerdict(DID, OTHER)).toBe('unknown')
    expect(noteMiss(answer(9), OTHER, {signalled: true})).toBe('suspect')
    expect(missVerdict(DID, OTHER)).toBe('suspect')
    // Not even the PDS is asked about another author's post.
    expect(pdsCalls).toEqual([])
  })

  it('a serve drops a suspect; an older answer’s serve does not end a newer miss', () => {
    noteMiss(answer(5), OTHER, {signalled: true})
    noteServed(answer(4), [OTHER])
    expect(missVerdict(DID, OTHER)).toBe('suspect')
    noteServed(answer(6), [OTHER])
    expect(missVerdict(DID, OTHER)).toBe('unknown')
    // A miss sent before the latest serve changes nothing.
    noteMiss(answer(5), OTHER, {signalled: true})
    expect(missVerdict(DID, OTHER)).toBe('unknown')
  })

  it('own: suspect and syncing until the PDS check; present is never real, absent is', async () => {
    pdsReply = () => ({
      status: 200,
      body: {uri: OWN, cid: privateView('x').cid, value: {}},
    })
    expect(noteMiss(answer(1), OWN)).toBe('suspect')
    expect(isSyncing(DID, OWN)).toBe(true)
    await settle()
    expect(pdsCalls.map(call => call.nsid)).toEqual([
      'com.atproto.repo.getRecord',
    ])
    expect(missVerdict(DID, OWN)).toBe('suspect')
    // One check per URI per run.
    noteMiss(answer(2), OWN)
    await settle()
    expect(pdsCalls).toHaveLength(1)

    const gone = privateView('3kgone222222').uri
    pdsReply = () => ({status: 400, body: {error: 'RecordNotFound'}})
    noteMiss(answer(3), gone)
    await settle()
    expect(missVerdict(DID, gone)).toBe('real')
    expect(noteMiss(answer(4), gone)).toBe('real')
    expect(isSyncing(DID, gone)).toBe(false)
  })

  it('an own URI missing and not in unavailable[] stays suspect until its check answers', async () => {
    let answerCheck: (reply: Reply) => void = () => {}
    pdsReply = () => new Promise<Reply>(resolve => (answerCheck = resolve)) as never
    const verdicts = noteOmissions(answer(1), [OWN], [])
    expect(verdicts.get(OWN)).toBe('suspect')
    await settle()
    expect(missVerdict(DID, OWN)).toBe('suspect')
    answerCheck({status: 400, body: {error: 'RecordNotFound'}})
    await settle()
    expect(missVerdict(DID, OWN)).toBe('real')
  })

  it('skipPdsCheck, and an own URI listed in unavailable[], make no PDS read', async () => {
    noteMiss(answer(1), OWN, {skipPdsCheck: true})
    const listed = privateView('3klisted2222').uri
    noteOmissions(
      answer(2, {
        unavailable: [{uri: listed as AtUriString, reason: 'syncing'}],
      }),
      [listed],
      [],
    )
    await settle()
    expect(pdsCalls).toEqual([])
    expect(missVerdict(DID, OWN)).toBe('suspect')
    expect(missVerdict(DID, listed)).toBe('suspect')
  })

  it('a degraded answer makes every omission signalled', () => {
    const verdicts = noteOmissions(answer(1, {degraded: true}), [OTHER], [])
    expect(verdicts.get(OTHER)).toBe('suspect')
  })
})

describe('the suspect clock (4)', () => {
  it('five misses over about 2 minutes; an early miss does not advance it', () => {
    noteMiss(answer(1), OTHER, {signalled: true})
    // random 0.5: each step is d * 0.875.
    expect(suspectRetryAt(DID, OTHER)).toBe(now + 4_000 * 0.875)
    now += 1_000
    noteMiss(answer(2), OTHER, {signalled: true})
    expect(suspectRetryAt(DID, OTHER)).toBe(1_000_000 + 4_000 * 0.875)
    let total = 0
    let at = suspectRetryAt(DID, OTHER)
    for (const step of [8_000, 16_000, 32_000, 60_000]) {
      now = at
      noteMiss(answer(3), OTHER, {signalled: true})
      expect(suspectRetryAt(DID, OTHER) - now).toBe(step * 0.875)
      at = suspectRetryAt(DID, OTHER)
      total = at - 1_000_000
    }
    expect(total).toBeGreaterThan(100_000)
    expect(total).toBeLessThan(130_000)
    // After five tries a held query's interval stops.
    expect(suspectRefetchInterval(DID, OTHER)).toBe(false)
  })

  it('retryAfterMs floors nextAt; health’s throttle floors suspectRetryAt', async () => {
    noteMiss(answer(1), OTHER, {signalled: true, retryAfterMs: 30_000})
    expect(suspectRetryAt(DID, OTHER)).toBe(now + 30_000)
    expect(suspectRefetchInterval(DID, OTHER)).toBe(30_000)
    const prism = fakeClient(DID, () => ({
      status: 503,
      body: {error: 'Reindexing', retryAfter: 90},
    }))
    await getPrivateTimeline(prism.client, {}).catch(() => {})
    expect(suspectRetryAt(DID, OTHER)).toBe(now + 90_000)
  })
})

describe('what counts as served (4)', () => {
  it('counts quoted #viewRecords at any depth and reply context, never #viewNotFound or #viewUnavailable', () => {
    const quoted = privateView('3kquoted2222', {did: OTHER_DID}).uri
    const deep = privateView('3kdeep222222', {did: OTHER_DID}).uri
    const parent = privateView('3kparent2222', {did: OTHER_DID})
    const missing = privateView('3kmissing222', {did: OTHER_DID}).uri
    const later = privateView('3klater22222', {did: OTHER_DID}).uri
    const body = {
      feed: [
        {
          ...privateView('3ktop2222222'),
          embed: {
            $type: 'app.bsky.embed.record#view',
            record: {
              $type: 'app.bsky.embed.record#viewRecord',
              uri: quoted,
              cid: parent.cid,
              author: parent.author,
              value: {},
              embeds: [
                {
                  $type: 'app.bsky.embed.record#view',
                  record: {
                    $type: 'app.bsky.embed.record#viewRecord',
                    uri: deep,
                    cid: parent.cid,
                    author: parent.author,
                    value: {},
                  },
                },
              ],
            },
          },
          reply: {parent, root: {uri: missing, cid: parent.cid}},
        },
        {
          ...privateView('3knext222222'),
          embed: {
            $type: 'app.bsky.embed.record#view',
            record: {
              $type: 'app.nearhorizon.private.defs#viewUnavailable',
              uri: later,
              unavailable: true,
              retryAfter: 30,
            },
          },
        },
      ],
    }
    expect(new Set(servedUrisOf(body))).toEqual(
      new Set([
        privateView('3ktop2222222').uri,
        privateView('3knext222222').uri,
        quoted,
        deep,
        parent.uri,
      ]),
    )
  })

  it('reportedPrismCall records every serve; a two-call page with one degraded call makes every omission signalled', async () => {
    const asked = Array.from(
      {length: 26},
      (_, i) =>
        privateView(`3kpage${String(i).padStart(6, 'a')}`, {did: OTHER_DID})
          .uri,
    )
    const servedOnly = asked[0]
    const prism = fakeClient(DID, call => {
      const uris = call.params.getAll('uris')
      const first = uris.includes(servedOnly)
      return {
        status: 200,
        body: {
          posts: first
            ? [privateView(servedOnly.split('/').pop()!, {did: OTHER_DID})]
            : [],
          ...(first ? {} : {degraded: true, retryAfter: 60}),
        },
      }
    })
    const {posts, answer: merged} = await getPrivatePostsAnswered(
      prism.client,
      asked,
    )
    expect(prism.calls).toHaveLength(2)
    expect(servedSince(DID, servedOnly, now)).toBe(true)
    expect(merged.degraded).toBe(true)
    const verdicts = noteOmissions(
      merged,
      asked,
      posts.map(post => post.uri),
    )
    expect(verdicts.size).toBe(25)
    expect([...verdicts.values()].every(v => v === 'suspect')).toBe(true)
    expect(suspectRetryAt(DID, asked[1])).toBe(now + 60_000)
  })

  it('served evicts its oldest past the cap (an evicted URI reads as not served)', () => {
    const first = privateView('3kfirst22222', {did: OTHER_DID}).uri
    noteServed(answer(1), [first])
    const many = Array.from({length: REGISTRY_CAP}, (_, i) =>
      privateView(`3kmany${String(i).padStart(6, 'a')}`, {did: OTHER_DID}),
    )
    noteServed(answer(2), many)
    expect(servedSince(DID, first, 0)).toBe(false)
    expect(servedSince(DID, many[0].uri, 0)).toBe(true)
  })

  it('answeredSince reads a serve or a quote verdict', () => {
    noteAnswered(DID, OTHER)
    expect(answeredSince(DID, OTHER, now)).toBe(true)
    expect(servedSince(DID, OTHER, now)).toBe(false)
    expect(answeredSince(DID, OTHER, now + 1)).toBe(false)
  })
})

describe('isSyncing (4, BR10-N3, N4)', () => {
  function pendingEntry(uri: string, writtenAt: number): PendingPost {
    const view = privateView(uri.split('/').pop()!)
    return {
      uri,
      cid: view.cid,
      did: DID,
      record: view.record as never,
      postView: view as never,
      feedItem: {post: view} as never,
      createdAt: new Date(writtenAt).toISOString(),
      expiresAt: writtenAt + PENDING_TTL_MS,
      phase: 'written',
    }
  }

  it('a pending entry past CONFIRM_AT_MS is syncing until served since it was written', () => {
    jest.useFakeTimers({now})
    try {
      addPendingPost(pendingEntry(OWN, now))
      expect(isSyncing(DID, OWN)).toBe(false)
      now += SYNCING_AFTER_MS
      expect(isSyncing(DID, OWN)).toBe(true)
      noteServed(answer(1), [OWN])
      expect(isSyncing(DID, OWN)).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('an own post on a launch-only gated load shows no label, then shows it once a cause is set', () => {
    const floor = now
    expect(isSyncing(DID, OWN, floor)).toBe(false)
    reportProbeStatus(DID, 'reindexing')
    expect(isSyncing(DID, OWN, floor)).toBe(true)
    noteServed(answer(1), [OWN])
    expect(isSyncing(DID, OWN, floor)).toBe(false)
    // Another author's post never carries the label.
    expect(isSyncing(DID, OTHER, floor)).toBe(false)
  })

  it('useIsSyncing re-renders on the serve', () => {
    noteMiss(answer(1), OWN, {skipPdsCheck: true})
    const {result} = renderHook(() => useIsSyncing(OWN))
    expect(result.current).toBe(true)
    act(() => {
      noteServed(answer(2), [OWN])
    })
    expect(result.current).toBe(false)
  })
})

describe('gatedAt and holds (4, 4.1)', () => {
  it('floors rise, never fall, drop on a later serve and clear on confirmation', async () => {
    gateUris(DID, [OTHER], 100)
    gateUris(DID, [OTHER], 50)
    expect(gatedAt(DID, OTHER)).toBe(100)
    gateUris(DID, [OTHER], now)
    expect(gatedAt(DID, OTHER)).toBe(now)
    noteServed(answer(1), [OTHER])
    expect(gatedAt(DID, OTHER)).toBeUndefined()

    gateUris(DID, [OTHER], now + 5)
    // A private 2xx confirms the account (it is unconfirmed at launch).
    const prism = fakeClient(DID, () => ({status: 200, body: {feed: []}}))
    await getPrivateTimeline(prism.client, {})
    expect(gatedAt(DID, OTHER)).toBeUndefined()
  })

  it('an entry evicted past the cap raises gatedFloor, read for a URI with none', () => {
    const uris = Array.from(
      {length: REGISTRY_CAP + 1},
      (_, i) =>
        privateView(`3kgate${String(i).padStart(6, 'a')}`, {did: OTHER_DID})
          .uri,
    )
    gateUris(DID, uris.slice(0, 1), 500)
    gateUris(DID, uris.slice(1), 700)
    expect(gatedAt(DID, uris[0])).toBe(500)
    expect(gatedAt(DID, OTHER)).toBe(500)
  })

  it('a hold is listed, marks its query invalidated once settled, and ends on a serve', async () => {
    const qc = new QueryClient()
    const key = ['horizon-test', 'held']
    qc.setQueryData(key, 'kept')
    hold(key, OTHER, qc)
    expect(heldQueries(DID)).toEqual([{queryKey: key, uri: OTHER}])
    await settle()
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
    noteServed(answer(1), [OTHER])
    expect(heldQueries(DID)).toEqual([])
  })

  it('findCachedPrivatePostView finds a cached view at any depth, prefers a full one, skips copies built from cache, and falls back to the quote cache', () => {
    const qc = new QueryClient()
    const view = privateView('3kown2222222')
    qc.setQueryData(['post-thread', 'x'], {
      thread: [{value: {post: {...view, horizonFromCache: 1}}}],
    })
    expect(findCachedPrivatePostView(qc, OWN)).toBeUndefined()
    qc.setQueryData(['horizon-private-quote', {uri: OWN}, {}], {
      ...view,
      text: 'from the quote cache',
    })
    expect(findCachedPrivatePostView(qc, OWN)?.uri).toBe(OWN)
    qc.setQueryData(['feed', 'a'], {pages: [{feed: [{post: view}]}]})
    qc.setQueryData(['feed', 'b'], {
      pages: [{feed: [{post: {...view, likeCount: 3}}]}],
    })
    expect(findCachedPrivatePostView(qc, OWN)?.likeCount).toBe(3)
  })

  it('an account change clears the registry', () => {
    noteMiss(answer(1), OTHER, {signalled: true})
    reportReadOutcome(DID, {
      kind: 'answered',
      method: 'm',
      seq: 1,
      read: true,
      degraded: false,
      retryAfterMs: undefined,
    })
    clearCurrentClients()
    expect(missVerdict(DID, OTHER)).toBe('unknown')
  })
})
