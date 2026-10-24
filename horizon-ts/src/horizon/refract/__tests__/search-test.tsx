import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Restored accounts in the search box's typeahead and on People
 * (`refract/search.ts`). Every id and name is synthetic; Refract's transport
 * and both AppView clients are fakes, so nothing reaches the network.
 */

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  REFRACT: true,
}))
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  subscribeMembership: () => () => {},
  isPrivateMember: () => true,
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

/** Stock `searchActorsTypeahead`'s answer, by query. */
let mockStockActors: (q: string) => Promise<unknown[]> = () =>
  Promise.resolve([])
const mockStockCalls: string[] = []
jest.mock('#/state/session', () => ({
  useAppviewClient: () => ({
    call: (_schema: unknown, params: {q: string}) => {
      mockStockCalls.push(params.q)
      return mockStockActors(params.q).then(actors => ({actors}))
    },
  }),
}))
jest.mock('#/state/preferences/moderation-opts', () => ({
  useModerationOpts: () => undefined,
}))
jest.mock('#/state/queries/preferences', () =>
  jest.requireActual('#/state/queries/preferences/const'),
)
jest.mock('#/lib/useGetEmojis', () => ({
  useGetEmojis: () => () => Promise.resolve({emojis: {}}),
}))

import {QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook, waitFor} from '@testing-library/react-native'

import {useAutocomplete} from '#/components/Autocomplete/useAutocomplete'
import {
  RF_DID,
  RF_DID_2,
  RF_READER_DID,
  RF_STOCK_DID,
  rfFillAnswer,
  rfProfile,
  rfProfileBasic,
} from '#/horizon/refract/fixtures'
import {seedOwnRelations} from '#/horizon/refract/relations'
import {
  exactActorQuery,
  REFRACT_SEARCH_TIMING,
  resetRefractSearch,
} from '#/horizon/refract/search'
import {useRestoredPeople} from '#/horizon/refract/search-people'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {answerPrismFeatures} from '#/horizon/routing/features'
import {com} from '#/lexicons'
import {deferred, type Harness, setupRefract} from './harness'

const HANDLE = String(rfProfile().handle)
const STOCK_HANDLE = 'stockperson.example.test'

let h: Harness
const resolveCalls: string[] = []
let resolvable: Record<string, string>

function stockProfile(did = RF_STOCK_DID, handle = STOCK_HANDLE) {
  return {did, handle, displayName: 'Stock Person', labels: [], viewer: {}}
}

beforeEach(() => {
  h = setupRefract()
  resetRefractSearch()
  REFRACT_SEARCH_TIMING.debounceMs = 20
  mockStockCalls.length = 0
  resolveCalls.length = 0
  mockStockActors = () => Promise.resolve([stockProfile()])
  resolvable = {[HANDLE]: RF_DID, [STOCK_HANDLE]: RF_STOCK_DID}
  // Stock `resolveHandle` on the AppView, on top of the harness's pre-check.
  const appview = getCurrentClients()!.appviewClient as unknown as {
    call: jest.Mock<(schema: unknown, params: unknown) => Promise<unknown>>
  }
  const precheck = appview.call.getMockImplementation()!
  appview.call.mockImplementation((schema, params) => {
    if (schema === com.atproto.identity.resolveHandle) {
      const handle = (params as {handle: string}).handle
      resolveCalls.push(handle)
      const did = resolvable[handle]
      return did
        ? Promise.resolve({did})
        : Promise.reject(new Error('Unable to resolve handle'))
    }
    return precheck(schema, params)
  })
  h.respond(call => {
    const dids = (call.params.dids as string[] | undefined) ?? []
    return rfFillAnswer({
      profiles: dids.includes(RF_DID) ? [rfProfile()] : [],
      withheld: [],
      servedAs: 'member',
    })
  })
})

afterEach(() => {
  REFRACT_SEARCH_TIMING.debounceMs = 200
})

function wrapper({children}: {children: React.ReactNode}) {
  return (
    <QueryClientProvider client={h.queryClient}>{children}</QueryClientProvider>
  )
}

function renderTypeahead(initial: string, {fallback = true} = {}) {
  return renderHook(
    ({query, navigated}: {query: string; navigated?: boolean}) =>
      useAutocomplete({
        type: 'profile',
        query,
        showSearchFallback: fallback,
        restored: true,
        navigated,
      }),
    {wrapper, initialProps: {query: initial}},
  )
}

/** The People tab's merge, as `SearchResults.tsx` wires it. */
function renderPeople(query: string, stock: {did: string}[]) {
  return renderHook(
    ({
      q,
      s: pages,
      scrolled = false,
    }: {
      q: string
      s: {did: string}[][]
      scrolled?: boolean
    }) => {
      const people = useRestoredPeople({
        query: q,
        active: true,
        stockPages: pages,
        scrolled,
      })
      return Object.assign(people.profiles, {pager: people})
    },
    {wrapper, initialProps: {q: query, s: [stock]}},
  )
}

function dids(items: unknown[]) {
  return items.map(item => {
    const value = item as {did?: string; type?: string; profile?: {did: string}}
    if (value.type === 'search') return 'search'
    return value.profile?.did ?? value.did
  })
}

describe('exactActorQuery', () => {
  it('takes full handles and DIDs only', () => {
    expect(exactActorQuery(`@${HANDLE.toUpperCase()}`)).toBe(HANDLE)
    expect(exactActorQuery(` ${HANDLE} `)).toBe(HANDLE)
    expect(exactActorQuery(RF_DID)).toBe(RF_DID)
    expect(exactActorQuery('synthetic')).toBeUndefined()
    expect(exactActorQuery('synthetic person.test')).toBeUndefined()
    expect(exactActorQuery('synthetic.')).toBeUndefined()
    expect(exactActorQuery('did:plc')).toBeUndefined()
  })
})

describe('the typeahead', () => {
  it('puts a restored account named exactly first, after the search row', async () => {
    const {result} = renderTypeahead(HANDLE)
    await waitFor(() => expect(dids(result.current.items)).toContain(RF_DID))
    expect(dids(result.current.items)).toEqual(['search', RF_DID, RF_STOCK_DID])
    const item = result.current.items[1] as {value: string}
    expect(item.value).toBe(`@${HANDLE}`)
    expect(h.fills()).toHaveLength(1)
    expect(resolveCalls).toEqual([HANDLE])
  })

  it('asks once per handle, a "not restored" answer included', async () => {
    resolvable['other.example.test'] = 'did:plc:rfxother00000000000000001'
    const {result, rerender} = renderTypeahead('other.example.test')
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(dids(result.current.items)).toEqual(['search', RF_STOCK_DID])
    rerender({query: 'other.example.tes'})
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    rerender({query: 'other.example.test'})
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(h.fills()).toHaveLength(1)
    expect(dids(result.current.items)).toEqual(['search', RF_STOCK_DID])
  })

  it('sends no fill for partial text', async () => {
    const {result, rerender} = renderTypeahead('synth')
    await waitFor(() =>
      expect(dids(result.current.items)).toContain(RF_STOCK_DID),
    )
    rerender({query: '@synthetic'})
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(h.fills()).toHaveLength(0)
    expect(resolveCalls).toHaveLength(0)
  })

  it("shows stock's results while the fill is out, then inserts the entry", async () => {
    const answer = deferred<unknown>()
    h.respond(() => answer.promise)
    const {result} = renderTypeahead(HANDLE)
    await waitFor(() =>
      expect(dids(result.current.items)).toEqual(['search', RF_STOCK_DID]),
    )
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    expect(dids(result.current.items)).toEqual(['search', RF_STOCK_DID])
    await act(async () => {
      await Promise.resolve()
      answer.resolve(
        rfFillAnswer({
          profiles: [rfProfile()],
          withheld: [],
          servedAs: 'member',
        }),
      )
    })
    await waitFor(() =>
      expect(dids(result.current.items)).toEqual([
        'search',
        RF_DID,
        RF_STOCK_DID,
      ]),
    )
  })

  it('appends a late entry once the reader navigated with the keyboard', async () => {
    const answer = deferred<unknown>()
    h.respond(() => answer.promise)
    const {result, rerender} = renderTypeahead(HANDLE)
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    rerender({query: HANDLE, navigated: true})
    await act(async () => {
      await Promise.resolve()
      answer.resolve(
        rfFillAnswer({
          profiles: [rfProfile()],
          withheld: [],
          servedAs: 'member',
        }),
      )
    })
    await waitFor(() =>
      expect(dids(result.current.items)).toEqual([
        'search',
        RF_STOCK_DID,
        RF_DID,
      ]),
    )
    // Placement holds when navigation state changes again.
    rerender({query: HANDLE, navigated: false})
    expect(dids(result.current.items)).toEqual(['search', RF_STOCK_DID, RF_DID])
  })

  it('adds no duplicate when stock already has the DID', async () => {
    mockStockActors = () =>
      Promise.resolve([stockProfile(RF_DID, HANDLE), stockProfile()])
    const {result} = renderTypeahead(HANDLE)
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    const ids = dids(result.current.items)
    expect(ids.filter(id => id === RF_DID)).toHaveLength(1)
    expect(ids).toEqual(['search', RF_DID, RF_STOCK_DID])
  })

  it('never offers a blocked account', async () => {
    h.respond(() =>
      rfFillAnswer({
        profiles: [
          rfProfile(RF_DID, {
            viewer: {blocking: 'at://x/app.bsky.graph.block/1'},
          }),
        ],
        withheld: [],
        servedAs: 'member',
      }),
    )
    const {result} = renderTypeahead(HANDLE)
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(dids(result.current.items)).not.toContain(RF_DID)
  })

  it("never offers an account in the reader's own block set", async () => {
    seedOwnRelations({
      blocks: {[RF_DID]: `at://${RF_READER_DID}/app.bsky.graph.block/b1`},
    })
    const {result} = renderTypeahead(HANDLE)
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(dids(result.current.items)).not.toContain(RF_DID)
  })

  it('asks nothing when Refract is not listed', async () => {
    answerPrismFeatures(RF_READER_DID, ['private'])
    const {result} = renderTypeahead(HANDLE)
    await waitFor(() =>
      expect(dids(result.current.items)).toEqual(['search', RF_STOCK_DID]),
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(h.calls).toHaveLength(0)
    expect(resolveCalls).toHaveLength(0)
  })

  it('goes first without the search row (native)', async () => {
    const {result} = renderTypeahead(HANDLE, {fallback: false})
    await waitFor(() =>
      expect(dids(result.current.items)).toEqual([RF_DID, RF_STOCK_DID]),
    )
  })
})

describe('People', () => {
  it('puts a restored account named exactly first', async () => {
    const {result} = renderPeople(HANDLE, [stockProfile()])
    expect(dids(result.current)).toEqual([RF_STOCK_DID])
    await waitFor(() =>
      expect(dids(result.current)).toEqual([RF_DID, RF_STOCK_DID]),
    )
    expect(h.fills()).toHaveLength(1)
  })

  it('shares the typeahead answer: no second fill', async () => {
    const typeahead = renderTypeahead(HANDLE)
    await waitFor(() =>
      expect(dids(typeahead.result.current.items)).toContain(RF_DID),
    )
    const {result} = renderPeople(HANDLE, [])
    // A kept answer shows on the first render, before the debounce.
    expect(dids(result.current)).toEqual([RF_DID])
    expect(h.fills()).toHaveLength(1)
  })

  it('adds nothing for a handle that is not restored', async () => {
    const {result} = renderPeople(STOCK_HANDLE, [stockProfile()])
    await waitFor(() => expect(resolveCalls).toEqual([STOCK_HANDLE]))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(dids(result.current)).toEqual([RF_STOCK_DID])
  })

  it('sends no fill for partial text', async () => {
    const {result} = renderPeople('synthetic person', [stockProfile()])
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(h.fills()).toHaveLength(0)
    expect(resolveCalls).toHaveLength(0)
    expect(dids(result.current)).toEqual([RF_STOCK_DID])
  })

  it('adds no duplicate when stock already has the DID', async () => {
    const {result} = renderPeople(HANDLE, [{did: RF_DID}, stockProfile()])
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(dids(result.current)).toEqual([RF_DID, RF_STOCK_DID])
  })

  it('never offers a blocked account', async () => {
    h.respond(() =>
      rfFillAnswer({
        profiles: [rfProfile(RF_DID, {viewer: {blockedBy: true}})],
        withheld: [],
        servedAs: 'member',
      }),
    )
    const {result} = renderPeople(HANDLE, [stockProfile()])
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(dids(result.current)).toEqual([RF_STOCK_DID])
  })

  it('appends a late entry once the list was scrolled', async () => {
    const answer = deferred<unknown>()
    h.respond(() => answer.promise)
    const {result, rerender} = renderPeople(HANDLE, [stockProfile()])
    await waitFor(() => expect(h.fills()).toHaveLength(1))
    rerender({q: HANDLE, s: [[stockProfile()]], scrolled: true})
    await act(async () => {
      await Promise.resolve()
      answer.resolve(
        rfFillAnswer({
          profiles: [rfProfile()],
          withheld: [],
          servedAs: 'member',
        }),
      )
    })
    await waitFor(() =>
      expect(dids(result.current)).toEqual([RF_STOCK_DID, RF_DID]),
    )
  })
})

describe('prism search (refract.search)', () => {
  const TYPEAHEAD = 'app.nearhorizon.refract.searchActorsTypeahead'
  const SEARCH = 'app.nearhorizon.refract.searchActors'
  const searchCalls = () =>
    h.calls.filter(call => call.method === TYPEAHEAD || call.method === SEARCH)
  const listSearch = () =>
    answerPrismFeatures(RF_READER_DID, ['private', 'refract', 'refract.search'])
  const other = (n: number) => `did:plc:rfxprefix0000000000000000${n}`

  it('sends nothing while the feature is not listed', async () => {
    const {result} = renderTypeahead('synth')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(searchCalls()).toHaveLength(0)
    expect(dids(result.current.items)).toEqual(['search', RF_STOCK_DID])
  })

  it("adds prism's prefix matches after stock's, dropping blocked ones", async () => {
    listSearch()
    h.respond(call =>
      call.method === TYPEAHEAD
        ? {
            actors: [
              rfProfileBasic(),
              rfProfileBasic(RF_DID_2, {viewer: {blocking: 'at://x/b/1'}}),
            ],
            servedAs: 'member',
            withheld: [],
          }
        : rfFillAnswer({profiles: [], withheld: []}),
    )
    const {result} = renderTypeahead('@000001')
    await waitFor(() =>
      expect(dids(result.current.items)).toEqual([
        'search',
        RF_STOCK_DID,
        RF_DID,
      ]),
    )
    expect(searchCalls()).toHaveLength(1)
    expect(searchCalls()[0].params).toEqual({q: '000001', limit: 8})
    expect(h.fills()).toHaveLength(0)
  })

  it("puts prism's exact handle first, with no fill", async () => {
    listSearch()
    h.respond(call =>
      call.method === TYPEAHEAD
        ? {actors: [rfProfileBasic()], servedAs: 'member', withheld: []}
        : rfFillAnswer({profiles: [], withheld: []}),
    )
    const {result} = renderTypeahead(HANDLE)
    await waitFor(() =>
      expect(dids(result.current.items)).toEqual([
        'search',
        RF_DID,
        RF_STOCK_DID,
      ]),
    )
    expect(h.fills()).toHaveLength(0)
    expect(resolveCalls).toHaveLength(0)
  })

  it("keeps stock's results when prism's search fails", async () => {
    listSearch()
    h.respond(() => {
      throw new Error('network')
    })
    const {result} = renderTypeahead('000001')
    await waitFor(() => expect(searchCalls()).toHaveLength(1))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    expect(dids(result.current.items)).toEqual(['search', RF_STOCK_DID])
  })

  it('pages People alongside stock, following a short page with a cursor', async () => {
    listSearch()
    h.respond(call => {
      if (call.method !== SEARCH)
        return rfFillAnswer({profiles: [], withheld: []})
      const cursor = call.params.cursor as string | undefined
      if (!cursor) {
        return {
          actors: [rfProfile(), rfProfile(RF_STOCK_DID)],
          cursor: 'c1',
          servedAs: 'member',
          withheld: [],
        }
      }
      // A page emptied by prism's block and mute drops, then the next one.
      if (cursor === 'c1') {
        return {actors: [], cursor: 'c2', servedAs: 'member', withheld: []}
      }
      return {actors: [rfProfile(other(1))], servedAs: 'member', withheld: []}
    })
    const page1 = [stockProfile()]
    const page2 = [stockProfile(other(9), 'stock9.example.test')]
    const {result, rerender} = renderPeople('000001', page1)
    // Stock's page shows at once.
    expect(dids(result.current)).toEqual([RF_STOCK_DID])
    await waitFor(() =>
      expect(dids(result.current)).toEqual([RF_STOCK_DID, RF_DID]),
    )
    expect(result.current.pager.hasNextPage).toBe(true)
    rerender({q: '000001', s: [page1, page2]})
    expect(dids(result.current)).toEqual([RF_STOCK_DID, RF_DID, other(9)])
    await act(async () => {
      await Promise.resolve()
      result.current.pager.fetchNextPage()
    })
    await waitFor(() =>
      expect(dids(result.current)).toEqual([
        RF_STOCK_DID,
        RF_DID,
        other(9),
        other(1),
      ]),
    )
    expect(result.current.pager.hasNextPage).toBe(false)
    expect(searchCalls().map(call => call.params.cursor)).toEqual([
      undefined,
      'c1',
      'c2',
    ])
    expect(h.fills()).toHaveLength(0)
  })

  it("puts People's exact handle first", async () => {
    listSearch()
    h.respond(call =>
      call.method === SEARCH
        ? {
            actors: [rfProfile(other(2)), rfProfile()],
            servedAs: 'member',
            withheld: [],
          }
        : rfFillAnswer({profiles: [], withheld: []}),
    )
    const {result} = renderPeople(HANDLE, [stockProfile()])
    await waitFor(() =>
      expect(dids(result.current)).toEqual([RF_DID, RF_STOCK_DID, other(2)]),
    )
    expect(h.fills()).toHaveLength(0)
  })
})
