import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 13, the reads (B-3): the read path signed in and out, auth
 * and the prefetched token, the token fallback, the 429 pause, the batcher
 * and its caps, and S-2 not served. prism and the PDS are the harness's
 * fixtures behind the mocked network-aware fetch.
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

import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {
  getDirectPrismToken,
  resetDirectPrism,
  startDirectTokenPrefetch,
} from '#/horizon/routing/prism-direct'
import {
  GET_RECORDS_LXM,
  identityPausedUntil,
  IdentityRateLimitedError,
  IdentityReadError,
  LIST_MEMBERS_LXM,
  readActorRecords,
  readMemberList,
  readMemberRecord,
  resetIdentityReads,
} from '../reads'
import {IDENTITY_DIRECT_PREFETCH} from '../TokenPrefetch'
import {
  agents,
  AUTHOR,
  callsOf,
  json,
  MEMBER,
  OTHER,
  pds,
  prism,
  PRONOUNS,
  READER,
  records,
  resetHarness,
  serviceAuthCalls,
  signIn,
  SPARROW,
  SYSTEM,
  uriOf,
  world,
  WREN,
} from './harness'

const START = 1_790_000_000_000

function did(i: number) {
  return `did:plc:author${String(i).padStart(18, 'a')}`
}

/** Let the batcher's 50 ms window pass and every answer land. */
async function settle(ms = 60) {
  await jest.advanceTimersByTimeAsync(ms)
}

const FOREGROUND = {isForeground: () => true, subscribe: () => () => {}}

function lxmOf(authorization: string | null): string | undefined {
  const payload = authorization?.replace(/^Bearer /, '').split('.')[1]
  if (!payload) return undefined
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    lxm?: string
  }
  return claims.lxm
}

beforeEach(() => {
  jest.useFakeTimers({now: START})
  resetHarness()
  resetIdentityReads()
  resetDirectPrism()
  resetPrismFeatures()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('signed out (P5R1-L9, L6)', () => {
  it('reads a thread of 25 authors from prism alone, in one call, without auth or the HTTP cache', async () => {
    const reads = Array.from({length: 25}, (_, i) => readActorRecords(did(i)))
    // 30 reads of one DID join the same ask.
    for (let i = 0; i < 30; i++) reads.push(readActorRecords(did(0)))
    await settle()
    await Promise.all(reads)
    expect(prism.calls).toHaveLength(1)
    expect(pds.calls).toHaveLength(0)
    const [call] = prism.calls
    expect(call.url.origin).toBe('https://prism.nearhorizon.app')
    expect(call.params.getAll('actors')).toHaveLength(25)
    expect(call.headers.get('authorization')).toBeNull()
    expect(call.init?.cache).toBe('no-cache')
  })

  it('answers each record as a record, none, or unknown', async () => {
    world.records.set(
      uriOf(AUTHOR, PRONOUNS),
      records.pronouns([['she', 'her']]),
    )
    world.unknown.add(uriOf(AUTHOR, SYSTEM))
    const read = readActorRecords(AUTHOR)
    await settle()
    const answers = await read
    expect(answers.pronouns.status).toBe('record')
    expect(answers.system.status).toBe('unknown')
    expect(answers.front.status).toBe('none')
    expect(answers.authed).toBe(false)
  })

  it('treats a 501 or a 404 (not served) as unknown for every record', async () => {
    prism.answer = () => json({error: 'MethodNotImplemented'}, 501)
    const read = readActorRecords(AUTHOR)
    await settle()
    expect((await read).pronouns.status).toBe('unknown')
    prism.answer = () => new Response('Not Found', {status: 404})
    const member = readMemberRecord(AUTHOR, WREN)
    await settle()
    expect((await member).answer.status).toBe('unknown')
  })

  it('fails a network error as a read error', async () => {
    prism.answer = () => {
      throw new TypeError('Failed to fetch')
    }
    const read = readActorRecords(AUTHOR)
    const caught = read.catch(error => error)
    await settle()
    expect(await caught).toBeInstanceOf(IdentityReadError)
  })
})

describe('signed in (4.4, P5R4-L3, P5R2-Q1)', () => {
  it('sends getRecords and listMembers with a token of that method, minted once by the prefetch', async () => {
    signIn()
    const stop = startDirectTokenPrefetch(IDENTITY_DIRECT_PREFETCH, FOREGROUND)
    await settle()
    expect(serviceAuthCalls()).toHaveLength(2)

    const read = readActorRecords(AUTHOR)
    const list = readMemberList(AUTHOR)
    await settle()
    await read
    await list
    stop()
    expect(serviceAuthCalls()).toHaveLength(2)
    const [getRecords] = callsOf('getRecords')
    const [listMembers] = callsOf('listMembers')
    expect(lxmOf(getRecords.headers.get('authorization'))).toBe(GET_RECORDS_LXM)
    expect(lxmOf(listMembers.headers.get('authorization'))).toBe(
      LIST_MEMBERS_LXM,
    )
    // The lex client's request carries no cache option (P5R5-N3).
    expect(getRecords.init?.cache).toBeUndefined()
    expect(listMembers.init?.cache).toBeUndefined()
  })

  it('at a cold start waits for the prefetch`s mint in flight and mints no second time', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    pds.serviceAuth = async params => {
      await held
      return json({
        token: `h.${Buffer.from(JSON.stringify({lxm: params.get('lxm'), iat: 1, exp: 3541})).toString('base64url')}.s`,
      })
    }
    const {pdsClient} = signIn()
    const stop = startDirectTokenPrefetch(IDENTITY_DIRECT_PREFETCH, FOREGROUND)
    const read = readActorRecords(AUTHOR)
    await settle()
    expect(callsOf('getRecords')).toHaveLength(0)
    release()
    await settle()
    await read
    stop()
    expect(
      serviceAuthCalls().filter(c => c.params.get('lxm') === GET_RECORDS_LXM),
    ).toHaveLength(1)
    expect(callsOf('getRecords')[0].headers.get('authorization')).toMatch(
      /^Bearer /,
    )
    expect(pdsClient).toBeDefined()
  })

  it('reads only the current account from its PDS; another signed-in account comes from prism', async () => {
    signIn(READER)
    pds.records.set(
      uriOf(READER, PRONOUNS),
      records.pronouns([['they', 'them']]),
    )
    const own = readActorRecords(READER)
    const other = readActorRecords(OTHER)
    await settle()
    expect((await own).pronouns.status).toBe('record')
    await other
    const pdsReads = pds.calls.filter(
      c => c.path === '/xrpc/com.atproto.repo.getRecord',
    )
    expect(pdsReads.map(c => c.params.get('repo'))).toEqual([
      READER,
      READER,
      READER,
    ])
    expect(callsOf('getRecords')[0].params.getAll('actors')).toEqual([OTHER])
  })

  it('answers RecordNotFound from the own PDS as none, and one record`s failure leaves the others', async () => {
    signIn(READER)
    pds.records.set(uriOf(READER, SYSTEM), records.system())
    pds.fail.add(uriOf(READER, PRONOUNS))
    const read = readActorRecords(READER)
    await settle()
    const answers = await read
    expect(answers.pronouns.status).toBe('error')
    expect(answers.system.status).toBe('record')
    expect(answers.front.status).toBe('none')
  })

  it('lists one`s own members from the own PDS, ascending', async () => {
    signIn(READER)
    pds.records.set(uriOf(READER, MEMBER, WREN), records.member('Wren'))
    pds.records.set(uriOf(READER, MEMBER, SPARROW), records.member('Sparrow'))
    const list = readMemberList(READER)
    await settle()
    const read = await list
    expect(read.status).toBe('complete')
    if (read.status !== 'unknown') {
      expect(read.members.map(m => m.rkey)).toEqual([WREN, SPARROW])
    }
    expect(prism.calls).toHaveLength(0)
  })

  it('asks prism nothing while the reader`s features leave out plural.read', async () => {
    signIn(READER)
    answerPrismFeatures(READER, ['private'])
    const read = readActorRecords(AUTHOR)
    await settle()
    expect((await read).pronouns.status).toBe('unknown')
    expect(prism.calls).toHaveLength(0)
    answerPrismFeatures(READER, ['private', 'plural.read'])
    const again = readActorRecords(AUTHOR)
    await settle()
    await again
    expect(prism.calls).toHaveLength(1)
  })
})

describe('the token fallback (P5R5-N4)', () => {
  /** prism refuses the first token, so the handler mints a fresh one. */
  function refuseFirstToken(onRefuse: () => void = () => {}) {
    let refused = false
    prism.answer = call => {
      if (call.headers.get('authorization') && !refused) {
        refused = true
        onRefuse()
        return json({error: 'InvalidToken'}, 401)
      }
      return json({actors: [], members: []})
    }
  }

  it.each([
    ['DirectPrismRateLimitedError (the PDS limits getServiceAuth)', 'limited'],
    ['PrivateClientUnavailableError (no session)', 'sessionless'],
    ['a PDS 500 on getServiceAuth', 'pds500'],
  ])(
    'a fresh mint failing with %s sends the batch again without auth',
    async (_, how) => {
      const {pdsClient} = signIn()
      refuseFirstToken(() => {
        if (how === 'limited') {
          pds.serviceAuth = () =>
            json({error: 'RateLimitExceeded'}, 429, {'retry-after': '60'})
        } else if (how === 'pds500') {
          pds.serviceAuth = () => json({error: 'InternalServerError'}, 500)
        } else {
          agents.get(pdsClient)!.did = undefined
        }
      })
      const read = readActorRecords(AUTHOR)
      await settle()
      const answers = await read
      // Answered, not failed: the batch was resent without Authorization.
      expect(answers.authed).toBe(false)
      const calls = callsOf('getRecords')
      expect(calls).toHaveLength(2)
      expect(calls[0].headers.get('authorization')).toMatch(/^Bearer /)
      expect(calls[1].headers.get('authorization')).toBeNull()
      expect(calls[1].init?.cache).toBe('no-cache')
    },
  )

  it('falls back when the first token cannot be had, before any call', async () => {
    pds.serviceAuth = () => json({error: 'InternalServerError'}, 500)
    signIn()
    const read = readActorRecords(AUTHOR)
    await settle()
    expect((await read).authed).toBe(false)
    expect(callsOf('getRecords')).toHaveLength(1)
    expect(callsOf('getRecords')[0].headers.get('authorization')).toBeNull()
  })

  it('a network TypeError from prism stays a read error', async () => {
    signIn()
    prism.answer = () => {
      throw new TypeError('Failed to fetch')
    }
    const caught = readActorRecords(AUTHOR).catch(error => error)
    await settle()
    expect(await caught).toBeInstanceOf(IdentityReadError)
  })

  it('after prism refuses the fresh token too, reads that DID without auth for 10 minutes', async () => {
    const {pdsClient} = signIn()
    prism.answer = call =>
      call.headers.get('authorization')
        ? json({error: 'InvalidToken'}, 401)
        : json({actors: [], members: []})
    const first = readActorRecords(AUTHOR)
    await settle()
    expect((await first).authed).toBe(false)
    // The cached token, its 401, the fresh one, its 401, then without auth.
    expect(
      callsOf('getRecords').map(c => !!c.headers.get('authorization')),
    ).toEqual([true, true, false])
    const mints = serviceAuthCalls().length

    jest.setSystemTime(START + 9 * 60_000)
    const second = readActorRecords(OTHER)
    await settle()
    await second
    expect(serviceAuthCalls()).toHaveLength(mints)
    expect(
      callsOf('getRecords').at(-1)!.headers.get('authorization'),
    ).toBeNull()

    // Thread Lens's token for the same DID is not limited by this.
    await getDirectPrismToken(pdsClient, 'app.nearhorizon.threadLens.getThread')
    expect(serviceAuthCalls()).toHaveLength(mints + 1)

    jest.setSystemTime(START + 11 * 60_000)
    prism.answer = () => json({actors: [], members: []})
    const third = readActorRecords(did(3))
    await settle()
    expect((await third).authed).toBe(true)
    expect(callsOf('getRecords').at(-1)!.headers.get('authorization')).toMatch(
      /^Bearer /,
    )
  })
})

describe('the 429 pause (P5R4-L3, P5R5-N5)', () => {
  it('sends nothing, for any key, until Retry-After has passed', async () => {
    prism.answer = () =>
      json({error: 'RateLimitExceeded'}, 429, {'retry-after': '20'})
    const caught = readActorRecords(AUTHOR).catch(error => error)
    await settle()
    const error = await caught
    expect(error).toBeInstanceOf(IdentityRateLimitedError)
    expect(identityPausedUntil()).toBe(START + 50 + 20_000)

    prism.answer = () => json({actors: [], members: []})
    const during = readActorRecords(OTHER).catch(e => e)
    const list = readMemberList(OTHER).catch(e => e)
    await settle()
    expect(await during).toBeInstanceOf(IdentityRateLimitedError)
    expect(await list).toBeInstanceOf(IdentityRateLimitedError)
    expect(prism.calls).toHaveLength(1)

    await jest.advanceTimersByTimeAsync(20_000)
    const after = readActorRecords(OTHER)
    await settle()
    await after
    expect(prism.calls).toHaveLength(2)
  })

  it('reads Retry-After before a ratelimit-reset an hour ahead of the clock', async () => {
    const reset = String(Math.floor(START / 1000) + 3600)
    prism.answer = () =>
      json({error: 'RateLimitExceeded'}, 429, {
        'retry-after': '20',
        'ratelimit-reset': reset,
      })
    const caught = readActorRecords(AUTHOR).catch(e => e)
    await settle()
    await caught
    expect(identityPausedUntil() - (START + 50)).toBe(20_000)
  })
})

describe('the batcher (4.5, P5R2-N11)', () => {
  it('splits 60 DIDs and 150 member URIs into calls within the caps, sent in parallel', async () => {
    const answers: (() => void)[] = []
    prism.answer = () =>
      new Promise<Response>(resolve => {
        answers.push(() => resolve(json({actors: [], members: []})))
      })
    const reads: Promise<unknown>[] = []
    for (let i = 0; i < 60; i++) reads.push(readActorRecords(did(i)))
    for (let i = 0; i < 150; i++) {
      reads.push(
        readMemberRecord(did(i % 30), `3m4kq${String(i).padStart(8, '0')}`),
      )
    }
    await settle()
    // Every call is out before any answer comes back.
    const calls = callsOf('getRecords')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(answers).toHaveLength(calls.length)
    for (const call of calls) {
      const dids = new Set([
        ...call.params.getAll('actors'),
        ...call.params.getAll('members').map(uri => uri.split('/')[2]),
      ])
      expect(dids.size).toBeLessThanOrEqual(50)
      expect(call.params.getAll('members').length).toBeLessThanOrEqual(100)
    }
    answers.forEach(answer => answer())
    await settle()
    await Promise.all(reads)
  })

  it('batches asks made within 50 ms of each other, and not later ones', async () => {
    const first = readActorRecords(did(1))
    await jest.advanceTimersByTimeAsync(30)
    const second = readMemberRecord(did(2), WREN)
    await settle()
    await Promise.all([first, second])
    expect(prism.calls).toHaveLength(1)
    const third = readActorRecords(did(3))
    await settle()
    await third
    expect(prism.calls).toHaveLength(2)
  })
})
