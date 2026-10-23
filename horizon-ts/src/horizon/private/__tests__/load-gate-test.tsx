import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  ...jest.requireActual<object>('#/horizon/routing/membership'),
  useMembership: () => mockMembership,
}))
// The note's look, without the native design system.
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
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
jest.mock('#/components/icons/Clock', () => ({
  Clock_Stroke2_Corner0_Rounded: () => null,
}))

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import {act, render, renderHook, screen} from '@testing-library/react-native'

/*
 * T-13's core cases (prism busy design 4.1, BR-7) and the note's look (10):
 * the capture, `gatePages`, the gated mount's top fetch, the lift, the slot
 * floor and `useServedSince`, and when `CatchingUpNote` shows.
 */
import {
  gatedAt,
  gateUris,
  noteServed,
  resetKnown,
} from '#/horizon/private/known'
import {
  type GatedPage,
  gatePages,
  isGatedOut,
  SLOT_JOIN_MS,
  useLoadGate,
  useServedSince,
  useSlotFloor,
} from '#/horizon/private/load-gate'
import {
  CatchingUpNote,
  NOTE_LINGER_MS,
} from '#/horizon/private/status/CatchingUpNote'
import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  isPrismConfirmed,
  reportProbeStatus,
  reportReadOutcome,
  resetPrismHealth,
} from '#/horizon/routing/health'
import {DID, OTHER_DID, privateUri} from './fixtures'

i18n.loadAndActivate({locale: 'en', messages: {}})

const OTHER = privateUri('3kother22222', OTHER_DID)
const OTHER_2 = privateUri('3kother33333', OTHER_DID)
const OWN = privateUri('3kown2222222')
const PUBLIC = `at://${OTHER_DID}/app.bsky.feed.post/3kpublic2222`

let now = 1_000_000
let seq = 0
let qc: QueryClient

/** A private read's 2xx: confirms the account once no cause is set. */
function answered() {
  reportReadOutcome(DID, {
    kind: 'answered',
    method: 'app.nearhorizon.private.getTimeline',
    seq: ++seq,
    read: true,
    degraded: false,
    retryAfterMs: undefined,
  })
}

function unconfirm() {
  reportProbeStatus(DID, 'reindexing')
}

function confirm() {
  reportProbeStatus(DID, 'member')
  answered()
}

function wrapper({children}: {children: React.ReactNode}) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nProvider>
  )
}

beforeEach(() => {
  now = 1_000_000
  seq = 0
  mockMembership = 'member'
  resetPrismHealth({now: () => now})
  resetKnown()
  qc = new QueryClient()
  publishCurrentClients({did: DID, queryClient: qc} as unknown as CurrentClients)
})

afterEach(() => {
  qc.clear()
  clearCurrentClients()
})

describe('gatePages and isGatedOut (4.1, BR12-N4)', () => {
  const page = (fetchedAt: number, uris: string[], carried?: number) => ({
    fetchedAt,
    items: uris.map(uri => ({
      uri,
      ...(carried === undefined ? {} : {horizonFromCache: carried}),
    })),
  })

  it('keeps a page fetched since loadSince whole; removes others’ older private rows and counts them; never gates own or public rows', () => {
    const fresh = page(200, [OTHER, OWN])
    const old = page(50, [OTHER, OWN, PUBLIC, OTHER_2])
    const {pages, hidden} = gatePages<GatedPage>([fresh, old], DID, 100)
    expect(pages[0]).toBe(fresh)
    expect(pages[1].items.map(item => item.uri)).toEqual([OWN, PUBLIC])
    expect(hidden).toBe(2)
    expect(gatePages([old], DID, undefined).hidden).toBe(0)
  })

  it('a carried row is judged by its own stamp before its page’s (BR11-N5)', () => {
    const gapFill = {
      fetchedAt: 300,
      items: [
        {uri: OTHER, horizonFromCache: 150},
        {uri: OTHER_2, horizonFromCache: 50},
      ],
    }
    const {pages, hidden} = gatePages<GatedPage>([gapFill], DID, 100)
    expect(pages[0].items.map(item => item.uri)).toEqual([OTHER])
    expect(hidden).toBe(1)
    // No stamp at all (another screen's placeholder) counts as old.
    expect(isGatedOut(DID, {uri: OTHER}, undefined, 100)).toBe(true)
  })

  it('never reads the registry: a serve elsewhere inserts no row in place', () => {
    const old = page(50, [OTHER])
    noteServed({did: DID, seq: 1}, [OTHER])
    expect(gatePages<GatedPage>([old], DID, 100).hidden).toBe(1)
  })
})

type Data = {fetchedAt: number; uris: string[]}

function seed(key: unknown[], data: Data) {
  qc.setQueryData(key, data, {updatedAt: data.fetchedAt})
}

function gateOf(key: unknown[], options = {}) {
  return renderHook(
    () =>
      useLoadGate<Data>(DID, key, data => data.uris, {
        hiddenOf: (data, loadSince) =>
          gatePages<GatedPage>(
            [{fetchedAt: data.fetchedAt, items: data.uris.map(uri => ({uri}))}],
            DID,
            loadSince,
          ).hidden,
        ...options,
      }),
    {wrapper},
  )
}

describe('useLoadGate: the capture (4.1)', () => {
  it('a mount while confirmed paints from cache, and a later ill health changes nothing on screen', () => {
    answered()
    expect(isPrismConfirmed(DID)).toBe(true)
    const key = ['horizon-test', 'confirmed']
    seed(key, {fetchedAt: 10, uris: [OTHER]})
    const refresh = jest.fn()
    const {result} = gateOf(key, {refreshFromTop: refresh})
    expect(result.current.loadSince).toBeUndefined()
    act(() => unconfirm())
    expect(result.current.loadSince).toBeUndefined()
    expect(result.current.hidden).toBe(0)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a mount while unconfirmed takes its mount time, stamps its data’s URIs, hides others’ rows from before it and fetches from the top though staleTime is Infinity', () => {
    const key = ['horizon-test', 'unconfirmed']
    seed(key, {fetchedAt: 10, uris: [OTHER, OWN]})
    const refresh = jest.fn()
    const {result} = gateOf(key, {refreshFromTop: refresh})
    expect(result.current.loadSince).toBe(now)
    expect(result.current.hidden).toBe(1)
    expect(result.current.trimmed).toBe(true)
    expect(gatedAt(DID, OTHER)).toBe(now)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a top fetch already in flight is joined, not repeated (BR12-N2)', async () => {
    const key = ['horizon-test', 'joined']
    seed(key, {fetchedAt: 10, uris: [OTHER]})
    let release: (data: Data) => void = () => {}
    void qc.fetchQuery({
      queryKey: key,
      queryFn: () => new Promise<Data>(resolve => (release = resolve)),
    })
    const refresh = jest.fn()
    gateOf(key, {refreshFromTop: refresh})
    expect(refresh).not.toHaveBeenCalled()
    await act(async () => {
      release({fetchedAt: now + 1, uris: [OTHER]})
      await Promise.resolve()
    })
  })

  it('restart() re-captures; a confirmed restart keeps loadSince until the refresh writes its first page (BR10-N2)', () => {
    const key = ['horizon-test', 'restart']
    seed(key, {fetchedAt: 10, uris: [OTHER]})
    const {result} = gateOf(key, {refreshFromTop: () => {}})
    const first = result.current.loadSince
    now += 5_000
    act(() => result.current.restart())
    expect(result.current.loadSince).toBe(first! + 5_000)
    expect(gatedAt(DID, OTHER)).toBe(now)

    act(() => confirm())
    now += 1_000
    act(() => result.current.restart())
    expect(result.current.loadSince).toBe(first! + 5_000)
    now += 1_000
    act(() => seed(key, {fetchedAt: now, uris: [OTHER]}))
    expect(result.current.loadSince).toBeUndefined()
    expect(result.current.hidden).toBe(0)
  })
})

describe('useLoadGate: the lift (4.1, BR10-L2, BR12-L3)', () => {
  it('a trimmed surface at the top refreshes from the top once the account is confirmed', () => {
    const key = ['horizon-test', 'lift']
    seed(key, {fetchedAt: 10, uris: [OTHER]})
    const refresh = jest.fn()
    gateOf(key, {refreshFromTop: refresh})
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => confirm())
    expect(refresh).toHaveBeenCalledTimes(2)
    // Health changing again does not lift twice.
    act(() => answered())
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('scrolled down, the lift lights the affordance instead', () => {
    const key = ['horizon-test', 'scrolled']
    seed(key, {fetchedAt: 10, uris: [OTHER]})
    const refresh = jest.fn()
    const scrolled = jest.fn()
    gateOf(key, {
      refreshFromTop: refresh,
      isAtTop: () => false,
      onScrolledDownLift: scrolled,
    })
    act(() => confirm())
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a gated mount whose top fetch is in flight when the cause clears makes one fetch, not two (BR11-N7)', async () => {
    const key = ['horizon-test', 'inflight']
    seed(key, {fetchedAt: 10, uris: [OTHER]})
    let calls = 0
    let release: (data: Data) => void = () => {}
    const refresh = () => {
      calls++
      void qc.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: () => new Promise<Data>(resolve => (release = resolve)),
      })
    }
    gateOf(key, {refreshFromTop: refresh})
    expect(calls).toBe(1)
    act(() => confirm())
    expect(calls).toBe(1)
    await act(async () => {
      release({fetchedAt: now + 1, uris: [OTHER]})
      await Promise.resolve()
    })
  })

  it('a query with no data between retries restarts at once on confirmation (BR12-L2)', async () => {
    const key = ['horizon-test', 'empty']
    let attempts = 0
    const observerOptions = {
      queryKey: key,
      queryFn: () => {
        attempts++
        return attempts === 1
          ? Promise.reject(new TypeError('Network request failed'))
          : Promise.resolve({fetchedAt: now, uris: []} as Data)
      },
      retry: 3,
      retryDelay: 60_000,
    }
    renderHook(
      () => {
        useQuery(observerOptions)
        return useLoadGate<Data>(DID, key, data => data.uris)
      },
      {wrapper},
    )
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(qc.getQueryState(key)?.fetchFailureCount).toBe(1)
    await act(async () => {
      confirm()
      for (let i = 0; i < 20; i++) await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(attempts).toBe(2)
    expect(qc.getQueryState(key)?.status).toBe('success')
  })
})

describe('slots (4.1, BR13-L1, BR14-L1)', () => {
  it('a slot mounted unconfirmed takes max(floorSince, gatedAt, mount - SLOT_JOIN_MS); its own page’s serve paints it at once', () => {
    const {result: floor} = renderHook(() => useSlotFloor(OTHER), {wrapper})
    // At launch floorSince is the launch time, after mount - 2 s here.
    expect(floor.current).toBe(now)
    now += 10_000
    const {result: joined} = renderHook(() => useSlotFloor(OTHER_2), {
      wrapper,
    })
    expect(joined.current).toBe(now - SLOT_JOIN_MS)
    // The page that rendered it served it 1 s before it mounted.
    noteServed({did: DID, seq: 1}, [OTHER_2])
    now += 1_000
    const {result: served} = renderHook(
      () => useServedSince(OTHER_2, useSlotFloor(OTHER_2)),
      {wrapper},
    )
    expect(served.current).toBe(true)
  })

  it('a slot mounted while confirmed paints from cache; a new load carrying its URI raises its floor, which never falls, also after confirmation', () => {
    answered()
    const {result} = renderHook(
      () => {
        const floor = useSlotFloor(OTHER)
        return {floor, served: useServedSince(OTHER, floor)}
      },
      {wrapper},
    )
    expect(result.current).toEqual({floor: undefined, served: true})
    act(() => unconfirm())
    expect(result.current.floor).toBeUndefined()
    now += 1_000
    act(() => gateUris(DID, [OTHER], now))
    expect(result.current).toEqual({floor: now, served: false})
    act(() => confirm())
    expect(gatedAt(DID, OTHER)).toBeUndefined()
    expect(result.current).toEqual({floor: now, served: false})
    now += 1_000
    act(() => noteServed({did: DID, seq: 99}, [OTHER]))
    expect(result.current.served).toBe(true)
  })

  it('useServedSince moves a quote from placeholder to content, and back only when a new load raises its floor, never on a change of health', () => {
    const {result} = renderHook(
      () => {
        const floor = useSlotFloor(OTHER)
        return useServedSince(OTHER, floor)
      },
      {wrapper},
    )
    expect(result.current).toBe(false)
    now += 1_000
    act(() => noteServed({did: DID, seq: 1}, [OTHER]))
    expect(result.current).toBe(true)
    act(() => {
      confirm()
      unconfirm()
    })
    expect(result.current).toBe(true)
    now += 1_000
    act(() => gateUris(DID, [OTHER], now))
    expect(result.current).toBe(false)
  })
})

describe('CatchingUpNote (10, BR10-N1, N3)', () => {
  const TEXT = 'Catching up. Some private posts may take a moment to appear.'

  it('shows at once while the gate hid a row and a cause is set; not for a launch gated only by no answer; never for a non-member', () => {
    const {rerender} = render(<CatchingUpNote hidden={1} />, {wrapper})
    expect(screen.queryByText(TEXT)).toBeNull()
    act(() => unconfirm())
    expect(screen.getByText(TEXT)).toBeTruthy()
    rerender(<CatchingUpNote hidden={0} />)
    expect(screen.queryByText(TEXT)).toBeNull()
    mockMembership = 'not-member'
    rerender(<CatchingUpNote hidden={1} />)
    expect(screen.queryByText(TEXT)).toBeNull()
  })

  it('clears 2 s after the account turns healthy', () => {
    jest.useFakeTimers()
    try {
      unconfirm()
      render(<CatchingUpNote hidden={2} />, {wrapper})
      expect(screen.getByText(TEXT)).toBeTruthy()
      act(() => reportProbeStatus(DID, 'member'))
      expect(screen.getByText(TEXT)).toBeTruthy()
      act(() => jest.advanceTimersByTime(NOTE_LINGER_MS))
      expect(screen.queryByText(TEXT)).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })
})
