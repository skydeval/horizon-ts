import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 13, the cache and retry rules (B-4, B-29): the three
 * answers in the cache, the negative entries and caps, restored entries,
 * fresh reads, member seeding, the unknown retries on both cadences per
 * observation episode, hidden, the 429 pause through the queries, and
 * signing in. Keys are observed as the hooks observe them
 * (`observeIdentity`); prism and the PDS are the harness's fixtures, with
 * fake timers.
 */

jest.mock(
  '#/state/session/network',
  () => jest.requireActual<{networkMock: unknown}>('./harness').networkMock,
)
jest.mock('#/state/session', () => ({useMaybePdsClient: () => null}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/horizon/routing/write-route', () => ({
  getWriteRoute: () => ({postingRoute: 'repo'}),
  subscribeWriteRoutes: () => () => {},
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
// The PDS fixtures' CIDs are validated by the lex client.
jest.unmock('multiformats/cid')

import {type QueryClient} from '@tanstack/react-query'

import {isQueryPersisted} from '#/state/queries/util'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {resetDirectPrism} from '#/horizon/routing/prism-direct'
import {parsePronouns, parseSystem} from '../parse'
import {
  identityAnswerFromState,
  type IdentityArgs,
  type IdentityKind,
  identityQueryKey,
  observeIdentity,
  prefetchIdentities,
  setIdentityRunStart,
} from '../queries'
import {resetIdentityReads} from '../reads'
import {
  type ObserveMode,
  resetIdentitySchedule,
  setIdentityVisibility,
} from '../schedule'
import {
  AUTHOR,
  callsOf,
  json,
  MEMBER,
  newQueryClient,
  OTHER,
  pds,
  prism,
  PRONOUNS,
  READER,
  records,
  resetHarness,
  signIn,
  signOut,
  SPARROW,
  SYSTEM,
  uriOf,
  world,
  worldAnswer,
  WREN,
} from './harness'

const START = 1_790_000_000_000
const S = 1000
const MIN = 60 * S

let qc: QueryClient
let visible = true
const visibilityListeners = new Set<() => void>()

function setVisible(next: boolean) {
  visible = next
  visibilityListeners.forEach(listener => listener())
}

const stops: (() => void)[] = []

function observe<K extends IdentityKind>(
  kind: K,
  args: IdentityArgs[K],
  mode: ObserveMode = 'post',
  client: QueryClient = qc,
) {
  const stop = observeIdentity(client, kind, args, mode)
  stops.push(stop)
  return stop
}

/** getRecords calls that asked about `did`'s self-keyed records. */
function actorCalls(did: string) {
  return callsOf('getRecords').filter(call =>
    call.params.getAll('actors').includes(did),
  )
}

function answerOf<K extends IdentityKind>(
  kind: K,
  args: IdentityArgs[K],
  client: QueryClient = qc,
) {
  return identityAnswerFromState(
    kind,
    client.getQueryState(identityQueryKey(kind, args)) as never,
  )
}

async function at(ms: number) {
  const wait = START + ms - Date.now()
  if (wait > 0) await jest.advanceTimersByTimeAsync(wait)
}

function offsets(calls: {at: number}[]) {
  return calls.map(call => call.at - START)
}

function gaps(calls: {at: number}[]) {
  return calls.slice(1).map((call, i) => call.at - calls[i].at)
}

beforeEach(() => {
  jest.useFakeTimers({now: START})
  resetHarness()
  resetIdentityReads()
  resetIdentitySchedule()
  resetDirectPrism()
  resetPrismFeatures()
  setIdentityRunStart(START)
  visible = true
  visibilityListeners.clear()
  setIdentityVisibility({
    isVisible: () => visible,
    subscribe: listener => {
      visibilityListeners.add(listener)
      return () => visibilityListeners.delete(listener)
    },
  })
  qc = newQueryClient()
})

afterEach(() => {
  stops.splice(0).forEach(stop => stop())
  qc.clear()
  jest.useRealTimers()
})

describe('the cache rule (4.5, P5R2-Q2, N3, L1)', () => {
  it('caches a RecordNotFound from the own PDS as none', async () => {
    signIn(READER)
    observe('system', {did: READER})
    await at(100)
    expect(answerOf('system', {did: READER})).toEqual({kind: 'none'})
  })

  it.each([
    ['a 500', () => json({error: 'InternalServerError'}, 500)],
    [
      'an S-2 unknown',
      () => {
        world.unknown.add(AUTHOR)
        return undefined
      },
    ],
    [
      'a network error',
      () => {
        throw new TypeError('Failed to fetch')
      },
    ],
  ])('caches nothing for %s', async (_, answer) => {
    prism.answer = call => answer() ?? worldAnswer(call)
    observe('pronouns', {did: AUTHOR})
    await at(100)
    expect(
      qc.getQueryState(identityQueryKey('pronouns', {did: AUTHOR}))?.data,
    ).toBeUndefined()
    expect(answerOf('pronouns', {did: AUTHOR})).toBeUndefined()
  })

  it('caches nothing for a timeout (3 s)', async () => {
    prism.answer = call =>
      new Promise<Response>((_, reject) => {
        call.init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        )
      })
    observe('pronouns', {did: AUTHOR})
    await at(3200)
    const state = qc.getQueryState(identityQueryKey('pronouns', {did: AUTHOR}))
    expect(state?.status).toBe('error')
    expect(state?.data).toBeUndefined()
  })

  it('lets one failing record leave the others', async () => {
    signIn(READER)
    pds.records.set(uriOf(READER, SYSTEM), records.system())
    pds.fail.add(uriOf(READER, PRONOUNS))
    observe('pronouns', {did: READER})
    await at(100)
    expect(answerOf('pronouns', {did: READER})).toBeUndefined()
    expect(answerOf('system', {did: READER})?.kind).toBe('record')
  })

  it('leaves a 60 s negative entry after an error: a remount inside it asks nothing', async () => {
    prism.answer = () => json({error: 'InternalServerError'}, 500)
    observe('pronouns', {did: AUTHOR})
    await at(30 * S)
    observe('pronouns', {did: AUTHOR})
    await at(30 * S + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(1)
    await at(70 * S)
    observe('pronouns', {did: AUTHOR})
    await at(70 * S + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
    // A 5xx is not retried while mounted.
    await at(10 * MIN)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
  })

  it('shows a cached answer behind failing reads until its cap: 1 h for pronouns and members, 24 h for the system', () => {
    const now = START + 48 * 60 * MIN
    const failing = <T>(ageMs: number, data: T) => ({
      data,
      dataUpdatedAt: now - ageMs,
      errorUpdatedAt: now,
      error: new Error('down'),
      status: 'error' as const,
    })
    const pronouns = {
      kind: 'record' as const,
      value: parsePronouns(records.pronouns([['she']]))!,
    }
    const system = {
      kind: 'record' as const,
      value: parseSystem(records.system())!,
    }
    expect(
      identityAnswerFromState('pronouns', failing(59 * MIN, pronouns), now),
    ).toBe(pronouns)
    expect(
      identityAnswerFromState('pronouns', failing(61 * MIN, pronouns), now),
    ).toBeUndefined()
    expect(
      identityAnswerFromState('member', failing(61 * MIN, {kind: 'none'}), now),
    ).toBeUndefined()
    expect(
      identityAnswerFromState('system', failing(23 * 60 * MIN, system), now),
    ).toBe(system)
    expect(
      identityAnswerFromState('system', failing(25 * 60 * MIN, system), now),
    ).toBeUndefined()
  })

  it('refetches an entry restored from disk on mount, unknown until it answers when older than its stale time', async () => {
    const key = identityQueryKey('pronouns', {did: AUTHOR})
    const old = {
      kind: 'record' as const,
      value: parsePronouns(records.pronouns([['he', 'him']]))!,
    }
    qc.setQueryData(key, old, {updatedAt: START - 10 * MIN})
    expect(answerOf('pronouns', {did: AUTHOR})).toBeUndefined()
    world.records.set(
      uriOf(AUTHOR, PRONOUNS),
      records.pronouns([['she', 'her']]),
    )
    observe('pronouns', {did: AUTHOR})
    await at(100)
    expect(actorCalls(AUTHOR)).toHaveLength(1)
    const answer = answerOf('pronouns', {did: AUTHOR})
    expect(answer?.kind === 'record' && answer.value.sets).toEqual([
      ['she', 'her'],
    ])
  })

  it('shows a restored entry inside its stale time at once, and still refetches it', async () => {
    const key = identityQueryKey('pronouns', {did: AUTHOR})
    const old = {
      kind: 'record' as const,
      value: parsePronouns(records.pronouns([['he', 'him']]))!,
    }
    qc.setQueryData(key, old, {updatedAt: START - MIN})
    expect(answerOf('pronouns', {did: AUTHOR})).toBe(old)
    observe('pronouns', {did: AUTHOR})
    await at(100)
    expect(actorCalls(AUTHOR)).toHaveLength(1)
  })

  it('keeps pronouns 5 minutes fresh for posts; the profile and the hover card read fresh past 30 s', async () => {
    world.records.set(uriOf(AUTHOR, PRONOUNS), records.pronouns([['she']]))
    const first = observe('pronouns', {did: AUTHOR})
    await at(100)
    first()
    expect(actorCalls(AUTHOR)).toHaveLength(1)
    await at(MIN)
    observe('pronouns', {did: AUTHOR})
    await at(MIN + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(1)
    observe('pronouns', {did: AUTHOR}, 'profile')
    await at(MIN + 200)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
    // A hover card for an author answered 10 s ago asks nothing.
    await at(MIN + 10 * S)
    observe('pronouns', {did: AUTHOR}, 'hover')
    await at(MIN + 10 * S + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
    await at(MIN + 40 * S)
    observe('pronouns', {did: AUTHOR}, 'hover')
    await at(MIN + 40 * S + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(3)
    // Six minutes on, a post mount refetches the stale entry.
    await at(7 * MIN)
    observe('pronouns', {did: AUTHOR})
    await at(7 * MIN + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(4)
  })

  it('seeds the members` own entries from a member list, so their posts ask nothing', async () => {
    world.records.set(uriOf(AUTHOR, MEMBER, WREN), records.member('Wren'))
    world.records.set(uriOf(AUTHOR, MEMBER, SPARROW), records.member('Sparrow'))
    observe('members', {did: AUTHOR}, 'profile')
    await at(100)
    const list = answerOf('members', {did: AUTHOR})
    expect(list?.members.map(m => m.rkey)).toEqual([WREN, SPARROW])
    expect(answerOf('member', {did: AUTHOR, rkey: WREN})?.kind).toBe('record')
    observe('member', {did: AUTHOR, rkey: SPARROW})
    await at(200)
    expect(callsOf('getRecords')).toHaveLength(0)
  })

  it('answers pronouns, system and front from one read, and persists all but the front', async () => {
    world.records.set(uriOf(AUTHOR, SYSTEM), records.system())
    observe('pronouns', {did: AUTHOR})
    await at(100)
    expect(answerOf('system', {did: AUTHOR})?.kind).toBe('record')
    expect(answerOf('front', {did: AUTHOR})).toEqual({kind: 'none'})
    expect(isQueryPersisted(identityQueryKey('pronouns', {did: AUTHOR}))).toBe(
      true,
    )
    expect(
      isQueryPersisted(identityQueryKey('member', {did: AUTHOR, rkey: WREN})),
    ).toBe(true)
    expect(isQueryPersisted(identityQueryKey('front', {did: AUTHOR}))).toBe(
      false,
    )
  })

  it('prefetches a page in one call, and the front is never asked for', async () => {
    await prefetchIdentitiesSettled({
      dids: [AUTHOR, OTHER, AUTHOR],
      fronters: [{did: AUTHOR, rkeys: [WREN]}],
    })
    expect(callsOf('getRecords')).toHaveLength(1)
    // Every DID once, the fronter's member by URI.
    expect(callsOf('getRecords')[0].params.getAll('actors')).toEqual([
      AUTHOR,
      OTHER,
    ])
    expect(callsOf('getRecords')[0].params.getAll('members')).toEqual([
      uriOf(AUTHOR, MEMBER, WREN),
    ])
    // Fresh now: a second page asks nothing.
    await prefetchIdentitiesSettled({dids: [AUTHOR]})
    expect(callsOf('getRecords')).toHaveLength(1)
  })
})

async function prefetchIdentitiesSettled(
  page: Parameters<typeof prefetchIdentities>[1],
) {
  const done = prefetchIdentities(qc, page)
  await jest.advanceTimersByTimeAsync(100)
  await done
}

describe('unknown retries, signed in (PP-23, P5R3-N5, N6, P5R4-N6)', () => {
  beforeEach(() => {
    signIn(READER, qc)
    world.unknown.add(AUTHOR)
  })

  it('asks again 5, 10, 20, 40 s, then every 60 s after each answer, 7 times, none past 5 minutes', async () => {
    observe('pronouns', {did: AUTHOR})
    await at(20 * MIN)
    const calls = actorCalls(AUTHOR)
    expect(calls).toHaveLength(8)
    // Each delay counts from the answer's arrival; the batcher's 50 ms window rides on top.
    expect(gaps(calls)).toEqual(
      [5, 10, 20, 40, 60, 60, 60].map(s => s * S + 50),
    )
    expect(offsets(calls).at(-1)! - offsets(calls)[0]).toBeLessThanOrEqual(
      5 * MIN,
    )
    for (const call of calls) {
      expect(call.headers.get('authorization')).toMatch(/^Bearer /)
      expect(call.init?.cache).toBeUndefined()
    }
  })

  it('a slow answer moves the next retry later', async () => {
    let n = 0
    const base = prism.answer
    prism.answer = call => {
      n++
      if (n !== 2) return base(call)
      return new Promise<Response>(resolve =>
        setTimeout(() => resolve(base(call) as Response), 2 * S),
      )
    }
    observe('pronouns', {did: AUTHOR})
    await at(2 * MIN)
    const calls = actorCalls(AUTHOR)
    expect(gaps(calls).slice(0, 2)).toEqual([5 * S + 50, 2 * S + 10 * S + 50])
  })

  it('a record or none ends the episode', async () => {
    observe('pronouns', {did: AUTHOR})
    await at(S)
    world.unknown.delete(AUTHOR)
    await at(20 * MIN)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
  })

  it('unmounting stops it; after the cap and its 60 s negative entry a remount asks and starts a new episode', async () => {
    const stop = observe('pronouns', {did: AUTHOR})
    await at(S)
    stop()
    await at(10 * MIN)
    expect(actorCalls(AUTHOR)).toHaveLength(1)

    observe('pronouns', {did: AUTHOR})
    await at(30 * MIN)
    expect(actorCalls(AUTHOR)).toHaveLength(9)
    stops.splice(0).forEach(s => s())
    observe('pronouns', {did: AUTHOR})
    await at(30 * MIN + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(10)
    await at(30 * MIN + 6 * S)
    expect(actorCalls(AUTHOR)).toHaveLength(11)
  })

  it('a call whose token cannot be had goes without auth, and its unknowns follow the signed-out cadence', async () => {
    pds.serviceAuth = () => json({error: 'InternalServerError'}, 500)
    observe('pronouns', {did: AUTHOR})
    await at(25 * S)
    expect(actorCalls(AUTHOR)).toHaveLength(1)
    expect(actorCalls(AUTHOR)[0].headers.get('authorization')).toBeNull()
    await at(31 * S)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
  })

  it('sends no retry while hidden, and the one due is sent on return', async () => {
    observe('pronouns', {did: AUTHOR})
    await at(S)
    setVisible(false)
    await at(3 * MIN)
    expect(actorCalls(AUTHOR)).toHaveLength(1)
    setVisible(true)
    await at(3 * MIN + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
  })

  it('retries a listMembers page answered unknown on the same schedule, and not a partial one', async () => {
    observe('members', {did: AUTHOR})
    await at(6 * S)
    expect(callsOf('listMembers')).toHaveLength(2)
    world.unknown.delete(AUTHOR)
    world.listStatus.set(AUTHOR, 'partial')
    await at(20 * MIN)
    expect(callsOf('listMembers')).toHaveLength(3)
    expect(answerOf('members', {did: AUTHOR})?.partial).toBe(true)
  })
})

describe('unknown retries, signed out (skydeval, 2026-10-24; P5R5-N6, P5R6-N5)', () => {
  beforeEach(() => {
    world.unknown.add(AUTHOR)
  })

  it('asks again 30 s after the answer, then every 5 minutes, 3 times, none past 15 minutes, never from the HTTP cache', async () => {
    observe('pronouns', {did: AUTHOR})
    await at(40 * MIN)
    const calls = actorCalls(AUTHOR)
    expect(calls).toHaveLength(4)
    expect(gaps(calls)).toEqual([30 * S + 50, 5 * MIN + 50, 5 * MIN + 50])
    expect(offsets(calls).at(-1)! - offsets(calls)[0]).toBeLessThanOrEqual(
      15 * MIN,
    )
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBeNull()
      expect(call.init?.cache).toBe('no-cache')
    }
  })

  it('keeps the episode across an unmount: a remount resumes the schedule and asks nothing sooner', async () => {
    const first = observe('pronouns', {did: AUTHOR})
    await at(31 * S)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
    const answered = actorCalls(AUTHOR)[1].at - START
    await at(60 * S)
    first()
    await at(90 * S)
    const second = observe('pronouns', {did: AUTHOR})
    await at(90 * S + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
    await at(answered + 5 * MIN - S)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
    await at(answered + 5 * MIN + 200)
    expect(actorCalls(AUTHOR)).toHaveLength(3)

    // Its next allowed time passes while unmounted: nothing then, one ask on the remount.
    await at(7 * MIN)
    second()
    await at(12 * MIN)
    expect(actorCalls(AUTHOR)).toHaveLength(3)
    const third = observe('pronouns', {did: AUTHOR})
    await at(12 * MIN + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(4)

    // Past the 15-minute cap a remount asks once and starts a new episode.
    third()
    await at(16 * MIN)
    observe('pronouns', {did: AUTHOR})
    await at(16 * MIN + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(5)
    await at(16 * MIN + 31 * S)
    expect(actorCalls(AUTHOR)).toHaveLength(6)
  })

  it('lets the profile`s mount ask once outside the kept schedule, not the hover card, and leaves the cap alone', async () => {
    const post = observe('pronouns', {did: AUTHOR})
    await at(31 * S)
    post()
    const answered = actorCalls(AUTHOR)[1].at - START
    // Next allowed ask about 4 minutes away; the hover card follows it.
    await at(90 * S)
    const hover = observe('pronouns', {did: AUTHOR}, 'hover')
    await at(90 * S + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(2)
    hover()
    // The profile asks once.
    const profile = observe('pronouns', {did: AUTHOR}, 'profile')
    await at(90 * S + 200)
    expect(actorCalls(AUTHOR)).toHaveLength(3)
    profile()
    // Within 30 s of that answer, another profile mount asks nothing.
    observe('pronouns', {did: AUTHOR}, 'profile')
    await at(100 * S)
    expect(actorCalls(AUTHOR)).toHaveLength(3)
    // The schedule is unchanged: the next ask is 5 minutes after the 30 s answer.
    await at(answered + 5 * MIN + 200)
    expect(actorCalls(AUTHOR)).toHaveLength(4)
  })

  it('drops the kept episodes on sign-in: the next unknown is retried at 5 s with a token', async () => {
    const post = observe('pronouns', {did: AUTHOR})
    await at(31 * S)
    post()
    expect(actorCalls(AUTHOR)).toHaveLength(2)
    const signedIn = newQueryClient()
    signIn(READER, signedIn)
    observe('pronouns', {did: AUTHOR}, 'post', signedIn)
    await at(31 * S + 100)
    expect(actorCalls(AUTHOR)).toHaveLength(3)
    await at(31 * S + 5 * S + 200)
    const calls = actorCalls(AUTHOR)
    expect(calls).toHaveLength(4)
    expect(calls[3].headers.get('authorization')).toMatch(/^Bearer /)
    signedIn.clear()
    signOut()
  })
})

describe('the 429 pause through the queries (P5R4-L3)', () => {
  it('sends nothing for any key for Retry-After, keeps cached answers, writes no negative entry, and asks the refused keys after', async () => {
    world.records.set(uriOf(AUTHOR, PRONOUNS), records.pronouns([['she']]))
    const first = observe('pronouns', {did: AUTHOR})
    await at(100)
    first()
    const cached = answerOf('pronouns', {did: AUTHOR})
    expect(cached?.kind).toBe('record')

    await at(6 * MIN)
    prism.answer = () =>
      json({error: 'RateLimitExceeded'}, 429, {'retry-after': '20'})
    observe('pronouns', {did: AUTHOR})
    await at(6 * MIN + 100)
    expect(callsOf('getRecords')).toHaveLength(2)
    prism.answer = worldAnswer
    observe('pronouns', {did: OTHER})
    await at(6 * MIN + 19 * S)
    expect(callsOf('getRecords')).toHaveLength(2)
    expect(answerOf('pronouns', {did: AUTHOR})).toEqual(cached)

    await at(6 * MIN + 21 * S)
    const calls = callsOf('getRecords')
    expect(calls).toHaveLength(3)
    expect(calls[2].params.getAll('actors').sort()).toEqual(
      [AUTHOR, OTHER].sort(),
    )
  })
})
