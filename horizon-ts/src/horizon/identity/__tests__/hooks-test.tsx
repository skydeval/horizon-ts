import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

/*
 * Phase 5 design 13, the hooks (B-5): the three pronoun states, the display
 * rule for a post's fronters (never the front), the scope's author check,
 * no observer outside a scope, and the switches.
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

import {type QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'
import * as switches from '#/horizon/switches'
import {
  useFronterAvatar,
  usePluralProfile,
  usePostFronters,
  usePronouns,
} from '../hooks'
import {parseFront} from '../parse'
import {identityQueryKey, setIdentityRunStart} from '../queries'
import {resetIdentityReads} from '../reads'
import {resetIdentitySchedule, setIdentityVisibility} from '../schedule'
import {PostFrontersScope} from '../scope'
import {
  AUTHOR,
  FRONT,
  json,
  MEMBER,
  newQueryClient,
  OTHER,
  prism,
  PRONOUNS,
  records,
  resetHarness,
  SPARROW,
  SYSTEM,
  uriOf,
  world,
  WREN,
} from './harness'

const START = 1_790_000_000_000
let qc: QueryClient

const post = {
  uri: `at://${AUTHOR}/app.bsky.feed.post/3m4kq9post222`,
  author: {did: AUTHOR},
  record: {
    $type: 'app.bsky.feed.post',
    text: 'we both agree on this one',
    createdAt: '2026-10-24T12:00:00.000Z',
    [PLURAL_FRONTERS_KEY]: {members: [{id: SPARROW}, {id: WREN}]},
  },
}

function wrapper({children}: {children: React.ReactNode}) {
  return (
    <QueryClientProvider client={qc}>
      <PostFrontersScope post={post}>{children}</PostFrontersScope>
    </QueryClientProvider>
  )
}

function bare({children}: {children: React.ReactNode}) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

async function advance(ms = 100) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  jest.useFakeTimers({now: START})
  resetHarness()
  resetIdentityReads()
  resetIdentitySchedule()
  setIdentityVisibility({isVisible: () => true, subscribe: () => () => {}})
  setIdentityRunStart(START)
  qc = newQueryClient()
})

afterEach(() => {
  qc.clear()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('usePronouns, three states (PP-8, P5R1-L1)', () => {
  it('shows nothing while pending, never the short field, then the short field on a proven none', async () => {
    const {result} = renderHook(() => usePronouns(AUTHOR, 'he/him'), {
      wrapper: bare,
    })
    expect(result.current).toEqual({text: '', sets: [], source: 'none'})
    await advance()
    expect(result.current).toEqual({text: 'he/him', sets: [], source: 'stock'})
  })

  it('shows nothing for a failed read, not the short field', async () => {
    prism.answer = () => json({error: 'InternalServerError'}, 500)
    const {result} = renderHook(() => usePronouns(AUTHOR, 'he/him'), {
      wrapper: bare,
    })
    await advance()
    expect(result.current.source).toBe('none')
    expect(result.current.text).toBe('')
  })

  it('shows nothing for an empty-sets record whose refresh fails', async () => {
    world.records.set(uriOf(AUTHOR, PRONOUNS), records.pronouns([]))
    const first = renderHook(() => usePronouns(AUTHOR, 'he/him'), {
      wrapper: bare,
    })
    await advance()
    expect(first.result.current.source).toBe('none')
    first.unmount()
    await advance(6 * 60_000)
    prism.answer = () => json({error: 'InternalServerError'}, 500)
    const {result} = renderHook(() => usePronouns(AUTHOR, 'he/him'), {
      wrapper: bare,
    })
    await advance()
    expect(result.current).toEqual({text: '', sets: [], source: 'none'})
  })

  it('shows a record by its displayMode', async () => {
    world.records.set(
      uriOf(AUTHOR, PRONOUNS),
      records.pronouns(
        [
          ['she', 'her'],
          ['they', 'them'],
        ],
        {displayMode: 'firstOnly'},
      ),
    )
    const {result} = renderHook(() => usePronouns(AUTHOR, 'he/him'), {
      wrapper: bare,
    })
    await advance()
    expect(result.current).toEqual({
      text: 'she/her',
      sets: [['she', 'her']],
      source: 'record',
    })
  })

  it('with PRONOUNS off renders nothing and reads nothing', async () => {
    jest.replaceProperty(switches, 'PRONOUNS', false)
    const {result} = renderHook(() => usePronouns(AUTHOR, 'he/him'), {
      wrapper: bare,
    })
    await advance()
    expect(result.current.source).toBe('none')
    expect(prism.calls).toHaveLength(0)
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
  })
})

describe('usePostFronters, the display rule (U-6, PP-3, P5R2-N5)', () => {
  beforeEach(() => {
    world.records.set(uriOf(AUTHOR, SYSTEM), records.system())
    world.records.set(uriOf(AUTHOR, MEMBER, WREN), records.member('Wren'))
    world.records.set(uriOf(AUTHOR, MEMBER, SPARROW), records.member('Sparrow'))
  })

  it('shows the recorded fronters in list order once the system and every member have answered', async () => {
    const {result} = renderHook(() => usePostFronters(AUTHOR), {wrapper})
    expect(result.current).toBeNull()
    await advance()
    expect(result.current?.map(f => f.member.displayName)).toEqual([
      'Wren',
      'Sparrow',
    ])
    // One batched call for the system and both members.
    expect(prism.calls).toHaveLength(1)
  })

  it('shows the account, with no &, while the system answer is pending or failing', async () => {
    world.unknown.add(uriOf(AUTHOR, SYSTEM))
    const {result} = renderHook(() => usePostFronters(AUTHOR), {wrapper})
    await advance()
    expect(result.current).toBeNull()
    world.unknown.clear()
    prism.answer = () => json({error: 'InternalServerError'}, 500)
    const second = renderHook(() => usePostFronters(AUTHOR), {wrapper})
    await advance()
    expect(second.result.current).toBeNull()
  })

  it('holds the line while one member is unknown, and leaves out one answered none', async () => {
    world.unknown.add(uriOf(AUTHOR, MEMBER, SPARROW))
    const {result} = renderHook(() => usePostFronters(AUTHOR), {wrapper})
    await advance()
    expect(result.current).toBeNull()
    world.unknown.clear()
    world.records.delete(uriOf(AUTHOR, MEMBER, SPARROW))
    // Signed out, the unknown is asked again after 30 s.
    await advance(31_000)
    expect(result.current?.map(f => f.rkey)).toEqual([WREN])
  })

  it('never shows the current front, and a change to the front entry leaves the post as it was', async () => {
    world.records.set(uriOf(AUTHOR, FRONT), records.front([SPARROW]))
    const {result} = renderHook(() => usePostFronters(AUTHOR), {wrapper})
    await advance()
    const before = result.current?.map(f => f.rkey)
    expect(before).toEqual([WREN, SPARROW])
    act(() => {
      qc.setQueryData(identityQueryKey('front', {did: AUTHOR}), {
        kind: 'record',
        value: parseFront(records.front([WREN]))!,
      })
    })
    expect(result.current?.map(f => f.rkey)).toEqual(before)
  })

  it('gives nothing for a DID other than the scope`s author', async () => {
    const {result} = renderHook(() => usePostFronters(OTHER), {wrapper})
    const avatar = renderHook(() => useFronterAvatar({did: OTHER}), {wrapper})
    await advance()
    expect(result.current).toBeNull()
    expect(avatar.result.current).toBeUndefined()
  })

  it('with PLURAL_DISPLAY off shows the account and reads nothing', async () => {
    jest.replaceProperty(switches, 'PLURAL_DISPLAY', false)
    const {result} = renderHook(() => usePostFronters(AUTHOR), {wrapper})
    await advance()
    expect(result.current).toBeNull()
    expect(prism.calls).toHaveLength(0)
  })
})

describe('useFronterAvatar (5.3, P5R2-N12)', () => {
  it('adds no observer and no query outside a scope', async () => {
    const {result} = renderHook(() => useFronterAvatar({did: AUTHOR}), {
      wrapper: bare,
    })
    await advance()
    expect(result.current).toBeUndefined()
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
    expect(prism.calls).toHaveLength(0)
  })

  it('gives the single fronter`s avatar as a CDN thumbnail', async () => {
    const cid = 'bafkreiavatar'
    world.records.set(uriOf(AUTHOR, SYSTEM), records.system())
    world.records.set(
      uriOf(AUTHOR, MEMBER, WREN),
      records.member('Wren', {
        avatar: {
          $type: 'blob',
          ref: {$link: cid},
          mimeType: 'image/png',
          size: 10,
        },
      }),
    )
    const single = {
      ...post,
      record: {...post.record, [PLURAL_FRONTERS_KEY]: {members: [{id: WREN}]}},
    }
    const {result} = renderHook(() => useFronterAvatar({did: AUTHOR}), {
      wrapper: ({children}) => (
        <QueryClientProvider client={qc}>
          <PostFrontersScope post={single}>{children}</PostFrontersScope>
        </QueryClientProvider>
      ),
    })
    await advance()
    expect(result.current?.uri).toBe(
      `https://cdn.bsky.app/img/avatar_thumbnail/plain/${AUTHOR}/${cid}@jpeg`,
    )
  })
})

describe('usePluralProfile (5.2)', () => {
  it('reads the system, members and front fresh, with the engaging members resolved', async () => {
    world.records.set(uriOf(AUTHOR, SYSTEM), records.system())
    world.records.set(uriOf(AUTHOR, MEMBER, WREN), records.member('Wren'))
    world.records.set(uriOf(AUTHOR, MEMBER, SPARROW), records.member('Sparrow'))
    world.records.set(uriOf(AUTHOR, FRONT), {
      ...records.front([]),
      members: [{id: SPARROW}, {id: WREN, status: 'co-conscious'}],
    })
    const {result} = renderHook(() => usePluralProfile(AUTHOR), {wrapper: bare})
    await advance(300)
    expect(result.current.isSystem).toBe(true)
    expect(result.current.members?.members.map(m => m.rkey)).toEqual([
      WREN,
      SPARROW,
    ])
    expect(result.current.engaging.map(f => f.member.displayName)).toEqual([
      'Sparrow',
    ])
  })

  it('is stock for an account with no system', async () => {
    const {result} = renderHook(() => usePluralProfile(AUTHOR), {wrapper: bare})
    await advance(300)
    expect(result.current.isSystem).toBe(false)
    expect(result.current.front).toBeNull()
  })
})
