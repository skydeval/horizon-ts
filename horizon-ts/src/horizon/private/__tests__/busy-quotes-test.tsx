import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  useMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: (did: string) =>
    Promise.resolve({did, pdsUrl: 'https://pds.example'}),
}))
jest.mock('#/horizon/private/membership', () => ({useIsMember: () => true}))
// The cards' looks, without the native design system.
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  tokens: {space: {lg: 16}},
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Typography', () => {
  const {Text} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {Text}
})
jest.mock('#/components/Button', () => {
  const {Pressable} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    Button: ({
      children,
      testID,
      onPress,
    }: {
      children?: React.ReactNode
      testID?: string
      onPress?: () => void
    }) => (
      <Pressable accessibilityRole="button" testID={testID} onPress={onPress}>
        {children}
      </Pressable>
    ),
    ButtonText: ({children}: {children?: React.ReactNode}) => children,
  }
})
jest.mock('#/components/icons/Lock', () => ({
  Lock_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/Skeleton', () => ({
  Row: ({children}: {children?: React.ReactNode}) => children,
  Col: ({children}: {children?: React.ReactNode}) => children,
  Circle: () => null,
  Text: () => null,
}))

/*
 * T-7 (prism busy design 6.3, 4.1): `#viewUnavailable` in the adapter,
 * prism's verdicts in the quote cache and their order, freshness,
 * `quoteFromRead`, `readQuotes`, the gather, and the slot's looks.
 */
import {Text} from 'react-native'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, render, screen} from '@testing-library/react-native'

import {withConvertedQuotes} from '#/horizon/private/adapt/post-view'
import {getPrivatePostsAnswered, mergeAnswers} from '#/horizon/private/api/reads'
import {
  answeredSince,
  heldQueries,
  noteServed,
  resetKnown,
} from '#/horizon/private/known'
import {
  gatherQuoteRead,
  QUOTE_GATHER_MS,
  readQuotes,
  resetQuoteBatch,
} from '#/horizon/private/quotes/batch'
import {
  isFreshQuote,
  isUnavailableQuote,
  noteQuoteVerdicts,
  privateQuoteQueryKey,
  type QuoteData,
  quoteFromRead,
  resetQuoteVerdicts,
  toQuoteData,
  unavailableQuote,
} from '#/horizon/private/quotes/verdicts'
import {PrivateQuote} from '#/horizon/private/render/PrivateQuote'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  nextAnswerSeq,
  reportProbeStatus,
  reportReadOutcome,
  resetPrismHealth,
} from '#/horizon/routing/health'
import {type app} from '#/lexicons'
import {clearPrivateStores} from '../store'
import {
  type Call,
  DID,
  fakeClient,
  OTHER_DID,
  privateUri,
  RECORD_CID,
  type Reply,
} from './fixtures'
import {fakeAppview, type PrivateView, privateView} from './read-fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

const QUOTED = privateUri('3kquoted', OTHER_DID)
const OWN_QUOTED = privateUri('3kownq')

let now = 1_000_000
let timers: (() => void)[] = []

function confirm() {
  reportReadOutcome(DID, {
    kind: 'answered',
    method: 'app.nearhorizon.private.getPosts',
    seq: nextAnswerSeq(DID),
    read: true,
    degraded: false,
    retryAfterMs: undefined,
  })
}

function setup(reply: (call: Call) => Reply | Promise<Reply>) {
  const prism = fakeClient(DID, reply)
  const appview = fakeAppview({
    profiles: [{did: OTHER_DID, handle: 'other.test'}],
  })
  const queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false}},
  })
  publishCurrentClients({
    did: DID,
    handle: 'me.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism.client,
    appviewClient: appview.client,
    queryClient,
  })
  const getPosts = () =>
    prism.calls.filter(c => c.nsid === 'app.nearhorizon.private.getPosts')
  return {prism, queryClient, getPosts}
}

/** A prism private post view quoting `record` (a quote embed's record). */
function quoting(rkey: string, record: object): PrivateView {
  return {
    ...privateView(rkey),
    embed: {$type: 'app.bsky.embed.record#view', record},
  } as PrivateView
}

function servedPosts(posts: PrivateView[], extra: object = {}): Reply {
  return {status: 200, body: {posts, ...extra}}
}

function cachedQuote(qc: QueryClient, uri: string) {
  return qc.getQueryData<QuoteData>(privateQuoteQueryKey(uri))
}

function aView(uri: string): app.bsky.feed.defs.PostView {
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri,
    cid: RECORD_CID,
    author: {did: uri.split('/')[2], handle: 'x.test'},
    record: {$type: 'app.bsky.feed.post', text: 'quoted', createdAt: ''},
    indexedAt: '2026-10-17T00:00:00.000Z',
  } as unknown as app.bsky.feed.defs.PostView
}

beforeEach(() => {
  now = 1_000_000
  timers = []
  resetPrismHealth({
    now: () => now,
    random: () => 0.5,
    setTimeout: callback => {
      timers.push(callback)
      return timers.length
    },
    clearTimeout: () => {},
  })
  resetKnown()
  resetQuoteVerdicts()
  resetQuoteBatch()
  clearPrivateStores()
  clearCurrentClients()
})

describe('the adapter maps #viewUnavailable (6.3, DMR-3)', () => {
  const unavailable = {
    $type: 'app.nearhorizon.private.defs#viewUnavailable',
    uri: QUOTED,
    unavailable: true,
    retryAfter: 30,
  }

  it('alone, to the stock #viewNotFound with its retryAfter kept', () => {
    const embed = withConvertedQuotes({
      $type: 'app.bsky.embed.record#view',
      record: unavailable,
    } as never) as unknown as {record: object}
    expect(embed.record).toEqual({
      $type: 'app.bsky.embed.record#viewNotFound',
      uri: QUOTED,
      notFound: true,
      retryAfter: 30,
    })
  })

  it('in recordWithMedia too', () => {
    const embed = withConvertedQuotes({
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: {record: unavailable},
      media: {$type: 'app.bsky.embed.images#view', images: []},
    } as never) as unknown as {record: {record: {$type: string}}}
    expect(embed.record.record.$type).toBe(
      'app.bsky.embed.record#viewNotFound',
    )
  })
})

describe('prism\'s verdicts land in the quote cache (6.3)', () => {
  it('another author\'s #viewUnavailable is the quiet card over a fresh copy, held, with no getPosts of its own', async () => {
    const {prism, queryClient, getPosts} = setup(() =>
      servedPosts([
        quoting('3kquoting', {
          $type: 'app.nearhorizon.private.defs#viewUnavailable',
          uri: QUOTED,
          unavailable: true,
          retryAfter: 30,
        }),
      ]),
    )
    queryClient.setQueryData(
      privateQuoteQueryKey(QUOTED),
      toQuoteData(aView(QUOTED)),
    )
    await getPrivatePostsAnswered(prism.client, [privateUri('3kquoting')])
    expect(isUnavailableQuote(cachedQuote(queryClient, QUOTED))).toBe(true)
    expect(heldQueries(DID).some(held => held.uri === QUOTED)).toBe(true)
    expect(getPosts()).toHaveLength(1)
    expect(isFreshQuote(queryClient, QUOTED)).toBe(false)
  })

  it('the reader\'s own #viewUnavailable keeps its copy', async () => {
    const {prism, queryClient} = setup(() =>
      servedPosts([
        quoting('3kquoting', {
          $type: 'app.nearhorizon.private.defs#viewUnavailable',
          uri: OWN_QUOTED,
          unavailable: true,
          retryAfter: 30,
        }),
      ]),
    )
    const copy = toQuoteData(aView(OWN_QUOTED))
    queryClient.setQueryData(privateQuoteQueryKey(OWN_QUOTED), copy)
    await getPrivatePostsAnswered(prism.client, [privateUri('3kquoting')])
    expect(cachedQuote(queryClient, OWN_QUOTED)).toEqual(copy)
  })

  it('prism\'s #viewNotFound is null, or the quiet card in a degraded answer', async () => {
    const notFound = {
      $type: 'app.bsky.embed.record#viewNotFound',
      uri: QUOTED,
      notFound: true,
    }
    const healthy = setup(() => servedPosts([quoting('3kquoting', notFound)]))
    await getPrivatePostsAnswered(healthy.prism.client, [privateUri('3kquoting')])
    expect(cachedQuote(healthy.queryClient, QUOTED)).toBeNull()

    resetQuoteVerdicts()
    const degraded = setup(() =>
      servedPosts([quoting('3kquoting', notFound)], {
        degraded: true,
        retryAfter: 60,
      }),
    )
    await getPrivatePostsAnswered(degraded.prism.client, [
      privateUri('3kquoting'),
    ])
    expect(isUnavailableQuote(cachedQuote(degraded.queryClient, QUOTED))).toBe(
      true,
    )
  })

  it('ignores an older answer\'s verdict after a newer one (BR10-N8) and records no answered for it (BR13-N4)', () => {
    const {queryClient} = setup(() => servedPosts([]))
    noteQuoteVerdicts(
      {did: DID, seq: 5, degraded: false},
      [{uri: QUOTED, kind: 'unavailable', retryAfterMs: 30_000}],
      queryClient,
    )
    now += 1_000
    noteQuoteVerdicts(
      {did: DID, seq: 3, degraded: false},
      [{uri: QUOTED, kind: 'notFound'}],
      queryClient,
    )
    expect(isUnavailableQuote(cachedQuote(queryClient, QUOTED))).toBe(true)
    expect(answeredSince(DID, QUOTED, now)).toBe(false)
  })
})

describe('quoteFromRead (6.3)', () => {
  const answer = (extra: object = {}) =>
    ({...mergeAnswers([]), did: DID, seq: 1, ...extra}) as ReturnType<
      typeof mergeAnswers
    >

  it('served: the view', () => {
    setup(() => servedPosts([]))
    const value = quoteFromRead(
      QUOTED,
      {views: new Map([[QUOTED, aView(QUOTED)]]), answer: answer()},
      undefined,
    )
    expect(value).toMatchObject({uri: QUOTED})
  })

  it('another author\'s left out of a degraded answer: the quiet card, held, never the old copy', () => {
    const {queryClient} = setup(() => servedPosts([]))
    const value = quoteFromRead(
      QUOTED,
      {views: new Map(), answer: answer({degraded: true})},
      toQuoteData(aView(QUOTED)),
      queryClient,
    )
    expect(isUnavailableQuote(value)).toBe(true)
    expect(heldQueries(DID).some(held => held.uri === QUOTED)).toBe(true)
  })

  it('another author\'s left out of a healthy answer: null', () => {
    setup(() => servedPosts([]))
    expect(
      quoteFromRead(QUOTED, {views: new Map(), answer: answer()}, undefined),
    ).toBeNull()
  })

  it('the reader\'s own left out: its previous copy, kept', () => {
    const {queryClient} = setup(() => servedPosts([]))
    const copy = toQuoteData(aView(OWN_QUOTED))
    expect(
      quoteFromRead(
        OWN_QUOTED,
        {views: new Map(), answer: answer()},
        copy,
        queryClient,
      ),
    ).toEqual(copy)
  })

  it('an older read after a newer verdict leaves the value as it is', () => {
    const {queryClient} = setup(() => servedPosts([]))
    noteQuoteVerdicts(
      {did: DID, seq: 9, degraded: false},
      [{uri: QUOTED, kind: 'unavailable', retryAfterMs: undefined}],
      queryClient,
    )
    const previous = unavailableQuote(QUOTED)
    expect(
      quoteFromRead(
        QUOTED,
        {
          views: new Map([[QUOTED, aView(QUOTED)]]),
          answer: answer({seq: 4}),
        },
        previous,
      ),
    ).toBe(previous)
  })
})

describe('freshness (6.3)', () => {
  it('the quiet card is never fresh; a view needs an answer since the floor', () => {
    const {queryClient} = setup(() => servedPosts([]))
    queryClient.setQueryData(privateQuoteQueryKey(QUOTED), unavailableQuote(QUOTED))
    expect(isFreshQuote(queryClient, QUOTED)).toBe(false)
    queryClient.setQueryData(
      privateQuoteQueryKey(QUOTED),
      toQuoteData(aView(QUOTED)),
    )
    expect(isFreshQuote(queryClient, QUOTED)).toBe(true)
    expect(isFreshQuote(queryClient, QUOTED, {floor: now})).toBe(false)
    noteServed({did: DID, seq: 1}, [QUOTED])
    expect(isFreshQuote(queryClient, QUOTED, {floor: now})).toBe(true)
  })

  it('a value restored from disk (written before this run) is never fresh', () => {
    const {queryClient} = setup(() => servedPosts([]))
    queryClient.setQueryData(
      privateQuoteQueryKey(QUOTED),
      toQuoteData(aView(QUOTED)),
      {updatedAt: Date.now() - 24 * 60 * 60 * 1000 - 1},
    )
    expect(isFreshQuote(queryClient, QUOTED)).toBe(false)
  })
})

describe('batched reads (4, 4.1)', () => {
  const uris = ['3kq1', '3kq2', '3kq3'].map(rkey => privateUri(rkey, OTHER_DID))

  it('readQuotes reads three quotes in one getPosts, fresh ones included', async () => {
    const {queryClient, getPosts} = setup(call => {
      const wanted = call.params.getAll('uris')
      return servedPosts(
        wanted.map(uri =>
          privateView(uri.split('/').pop()!, {did: OTHER_DID}),
        ),
      )
    })
    queryClient.setQueryData(
      privateQuoteQueryKey(uris[0]),
      toQuoteData(aView(uris[0])),
    )
    await readQuotes(DID, uris)
    expect(getPosts()).toHaveLength(1)
    for (const uri of uris) {
      expect(cachedQuote(queryClient, uri)).toMatchObject({uri})
    }
  })

  it('three slots that mount late within the gather window make one getPosts (BR14-L2)', async () => {
    const {queryClient, getPosts} = setup(() => servedPosts([]))
    const reads = uris.map(uri =>
      gatherQuoteRead(DID, uri, () => cachedQuote(queryClient, uri)),
    )
    expect(QUOTE_GATHER_MS).toBe(1_000)
    expect(timers).toHaveLength(1)
    timers[0]()
    const values = await Promise.all(reads)
    expect(getPosts()).toHaveLength(1)
    expect(values).toEqual([null, null, null])
  })
})

describe('the slot (6.3, 4.1)', () => {
  function renderSlot(queryClient: QueryClient, uri = QUOTED) {
    return render(
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <PrivateQuote
            uri={uri}
            render={quote => <Text>{`content ${quote.view.uri}`}</Text>}
          />
        </QueryClientProvider>
      </I18nProvider>,
    )
  }

  it('shows the quiet card, never the stand-in, for a failed first read with no data (BR12-N8)', async () => {
    const {queryClient} = setup(() => ({
      status: 400,
      body: {error: 'InvalidRequest', message: 'x'},
    }))
    confirm()
    renderSlot(queryClient)
    await act(async () => {
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
    })
    expect(screen.queryByTestId('privatePostUnavailable')).not.toBeNull()
    expect(screen.queryByTestId('privatePostStandIn')).toBeNull()
  })

  it('a gated slot over a copy served before the outage shows no content, then the quiet card at 2 s, then content once served', async () => {
    let open = () => {}
    const wait = new Promise<void>(resolve => {
      open = resolve
    })
    const {queryClient} = setup(async () => {
      await wait
      return servedPosts([privateView('3kquoted', {did: OTHER_DID})])
    })
    queryClient.setQueryData(
      privateQuoteQueryKey(QUOTED),
      toQuoteData(aView(QUOTED)),
    )
    noteServed({did: DID, seq: 1}, [QUOTED])
    now += 60_000
    reportProbeStatus(DID, 'reindexing')
    renderSlot(queryClient)
    expect(screen.queryByText(`content ${QUOTED}`)).toBeNull()
    expect(screen.queryByTestId('privateQuotePlaceholder')).not.toBeNull()
    // The skeleton's 2 s cap, then the gather's window.
    await act(() => {
      for (const timer of timers.splice(0)) timer()
      return Promise.resolve()
    })
    expect(screen.queryByTestId('privatePostUnavailable')).not.toBeNull()
    await act(async () => {
      open()
      for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0))
    })
    expect(screen.queryByText(`content ${QUOTED}`)).not.toBeNull()
  })
})
