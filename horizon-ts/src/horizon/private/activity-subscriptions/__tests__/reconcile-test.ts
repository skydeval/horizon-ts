import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The reconcile and its host schedule (activity subscriptions design 2.3):
 * T-11 to T-15.
 */

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')
jest.mock('#/horizon/private/activity-subscriptions/dirty-store', () => ({}))
jest.mock('#/horizon/private/activity-subscriptions/ui', () => ({
  bellUi: {},
  setBell: () => {},
}))

import {getPrismHealth} from '#/horizon/routing/health'
import {getMembership, resetMembership} from '#/horizon/routing/membership'
import {membershipStorageKey} from '#/horizon/routing/membership-record'
import {writeLocal} from '#/horizon/session/local-store'
import {type Reply} from '../../__tests__/fixtures'
import {GRACE_MS, MOUNT_DELAY_MS, OFF, RECONCILE_INTERVAL_MS} from '../common'
import {startActivitySync,type SyncEnvironment} from '../tab'
import {
  BOTH,
  DID,
  harness,
  ok,
  ON,
  OTHER_ACCOUNT,
  settle,
  SUBJECT,
  SUBJECT_2,
  xrpcError,
} from './harness'

const SUBJECT_3 = 'did:plc:subjecteeeeeeeeeeeeeeeeee'
const SUBJECT_4 = 'did:plc:subjectffffffffffffffffff'

/** prism's `asOf` and the cut-off C = T0 - G. */
const T0 = '2026-10-22T12:00:00.000Z'
const C = new Date(Date.parse(T0) - GRACE_MS).toISOString()
const OLD = '2026-10-22T10:00:00.000Z'

let h: ReturnType<typeof harness>

function clients() {
  return {did: DID, prismClient: h.prism.client, appviewClient: h.bluesky.client}
}

function row(flags: typeof ON, updatedAt = OLD) {
  return {flags, updatedAt}
}

function profile(subject: string, viewer: Record<string, unknown> = {}) {
  return {did: subject, handle: 'subject.test', viewer}
}

beforeEach(() => {
  h = harness()
  h.prism.state.asOf = T0
})

describe('T-11: the diff', () => {
  it('puts missing and different subjects with Bluesky’s flags and ifNotChangedSince C, and nothing else', async () => {
    h.bluesky.bells.set(SUBJECT, ON)
    h.bluesky.bells.set(SUBJECT_2, BOTH)
    h.bluesky.bells.set(SUBJECT_3, ON)
    h.prism.rows.set(SUBJECT_2, row(ON))
    h.prism.rows.set(SUBJECT_3, row(ON))
    h.prism.rows.set(SUBJECT_4, row(ON))
    const result = await h.tab.reconcile.run(clients())
    expect(result.complete).toBe(true)
    expect(
      h.prism.puts().sort((a, b) =>
        String(a.subject).localeCompare(String(b.subject)),
      ),
    ).toEqual([
      {subject: SUBJECT, activitySubscription: ON, ifNotChangedSince: C},
      {subject: SUBJECT_2, activitySubscription: BOTH, ifNotChangedSince: C},
    ])
    // Removals off: no profile reads for the subject only prism holds.
    expect(h.profileReads()).toBe(0)
  })

  it('removes a subject only prism holds on an explicit off, with the removals switch on', async () => {
    h.env.removals = true
    h.prism.rows.set(SUBJECT_4, row(ON))
    const result = await h.tab.reconcile.run(clients())
    expect(h.profileReads()).toBe(1)
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT_4, activitySubscription: OFF, ifNotChangedSince: C},
    ])
    expect(result.complete).toBe(true)
  })
})

describe('T-12: safety', () => {
  it('a failed or capped Bluesky read means no removals and no record', async () => {
    h.env.removals = true
    h.prism.rows.set(SUBJECT_4, row(ON))
    h.bluesky.state.listPages = [xrpcError(500, 'InternalServerError')]
    let result = await h.tab.reconcile.run(clients())
    expect(result.complete).toBe(false)
    expect(h.prism.puts()).toEqual([])
    expect(h.shared.store.readReconciled(DID)).toBeUndefined()

    // 31 pages: the read stops at 30 and is capped.
    h.bluesky.state.listPages = Array.from({length: 31}, (_, i) =>
      ok({
        subscriptions: [
          profile(`did:plc:capped${String(i).padStart(18, 'a')}`, {
            activitySubscription: ON,
          }),
        ],
        cursor: String(i + 1),
      }),
    )
    result = await h.tab.reconcile.run(clients())
    expect(result.complete).toBe(false)
    const listCalls = h.bluesky.calls.filter(
      c => c.nsid === 'app.bsky.notification.listActivitySubscriptions',
    )
    expect(listCalls).toHaveLength(31)
    // What was read is put; nothing is removed.
    expect(h.prism.puts()).toHaveLength(30)
    expect(
      h.prism.puts().some(p => p.subject === SUBJECT_4),
    ).toBe(false)
    expect(h.shared.store.readReconciled(DID)).toBeUndefined()
  })

  it('a 429 stops the run', async () => {
    for (const subject of [SUBJECT, SUBJECT_2, SUBJECT_3, SUBJECT_4]) {
      h.bluesky.bells.set(subject, ON)
    }
    h.prism.state.putReply = xrpcError(429, 'RateLimitExceeded')
    const result = await h.tab.reconcile.run(clients())
    expect(result).toMatchObject({complete: false, stopped: 'transient'})
    expect(h.prism.puts().length).toBeLessThan(4)
    expect(h.shared.store.readReconciled(DID)).toBeUndefined()
  })

  it('writes reconciled:<did> only after a complete run, which with removals off needs no profile reads', async () => {
    h.bluesky.bells.set(SUBJECT, ON)
    h.prism.rows.set(SUBJECT_4, row(ON))
    const result = await h.tab.reconcile.run(clients())
    expect(result.complete).toBe(true)
    expect(h.profileReads()).toBe(0)
    expect(h.shared.store.readReconciled(DID)).toBe(h.clock.wallNow())
    expect(h.tab.reconcile.isDue(DID)).toBe(false)
    await h.clock.advance(RECONCILE_INTERVAL_MS - 1)
    expect(h.tab.reconcile.isDue(DID)).toBe(false)
    await h.clock.advance(1)
    expect(h.tab.reconcile.isDue(DID)).toBe(true)
  })
})

describe('T-13: races', () => {
  it('skips a subject dirty at write time', async () => {
    h.bluesky.bells.set(SUBJECT, ON)
    h.bluesky.bells.set(SUBJECT_2, ON)
    h.bluesky.bells.set(SUBJECT_3, ON)
    h.prism.state.putReply = call => {
      // A press for the third subject lands while the first is written.
      if ((call.body as {subject: string}).subject === SUBJECT) {
        h.shared.store.writeToken(DID, SUBJECT_3, 'pressed-during-run')
      }
      return undefined
    }
    const result = await h.tab.reconcile.run(clients())
    expect(h.prism.puts().map(p => p.subject).sort()).toEqual(
      [SUBJECT, SUBJECT_2].sort(),
    )
    expect(result.complete).toBe(true)
  })

  it('with the skip bypassed, prism refuses with Conflict and the run still completes', async () => {
    h.bluesky.bells.set(SUBJECT, ON)
    h.prism.state.putReply = (): Reply => xrpcError(409, 'Conflict')
    const result = await h.tab.reconcile.run(clients())
    expect(h.prism.puts()).toHaveLength(1)
    expect(result.complete).toBe(true)
    expect(h.shared.store.readReconciled(DID)).toBeDefined()
  })

  it('a row with updatedAt after C is not written; one at exactly C is', async () => {
    h.bluesky.bells.set(SUBJECT, BOTH)
    h.bluesky.bells.set(SUBJECT_2, BOTH)
    h.prism.rows.set(SUBJECT, row(ON, new Date(Date.parse(C) + 1).toISOString()))
    h.prism.rows.set(SUBJECT_2, row(ON, C))
    await h.tab.reconcile.run(clients())
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT_2, activitySubscription: BOTH, ifNotChangedSince: C},
    ])
  })
})

describe('T-14: removal candidates', () => {
  beforeEach(() => {
    h.env.removals = true
    h.prism.rows.set(SUBJECT_4, row(ON))
  })

  it('an incomplete Bluesky read means no removal', async () => {
    h.bluesky.state.listPages = [
      ok({subscriptions: [], cursor: '1'}),
      xrpcError(502, 'BadGateway'),
    ]
    await h.tab.reconcile.run(clients())
    expect(h.prism.puts()).toEqual([])
  })

  it('a failed getProfile means no removal, and the run is not complete', async () => {
    h.bluesky.state.profileReply = xrpcError(500, 'InternalServerError')
    const result = await h.tab.reconcile.run(clients())
    expect(h.prism.puts()).toEqual([])
    expect(result.complete).toBe(false)
  })

  it.each([
    ['blocking', {blocking: `at://${DID}/app.bsky.graph.block/3kblock222222`}],
    ['blockedBy', {blockedBy: true}],
    [
      'blockingByList',
      {
        blockingByList: {
          uri: `at://${DID}/app.bsky.graph.list/3klist2222222`,
          cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
          name: 'blocks',
          purpose: 'app.bsky.graph.defs#modlist',
        },
      },
    ],
    ['a field that does not read off', {activitySubscription: ON}],
  ])('%s means no removal', async (_name, viewer) => {
    h.bluesky.state.profileReply = ok(profile(SUBJECT_4, viewer))
    await h.tab.reconcile.run(clients())
    expect(h.prism.puts()).toEqual([])
  })
})

describe('T-15: gating', () => {
  function syncEnv(over: Partial<SyncEnvironment> = {}) {
    const foreground = new Set<() => void>()
    const state = {foreground: true, can: true}
    const env: SyncEnvironment = {
      setTimeout: h.clock.setTimeout,
      clearTimeout: h.clock.clearTimeout,
      wallNow: h.clock.wallNow,
      isForeground: () => state.foreground,
      onForeground: callback => {
        foreground.add(callback)
        return () => {
          foreground.delete(callback)
        }
      },
      clients: did => (did === DID ? clients() : undefined),
      canReconcile: () => state.can,
      subscribeChecks: () => () => {},
      ...over,
    }
    return {
      env,
      state,
      toForeground() {
        state.foreground = true
        foreground.forEach(callback => callback())
      },
    }
  }

  function prismLists() {
    return h.prism.calls.filter(
      c => c.nsid === 'app.nearhorizon.private.listActivitySubscriptions',
    ).length
  }

  it('runs 20 s after launch, not again within the hour, and again when due, on foreground and when it next falls due', async () => {
    const {env, toForeground} = syncEnv()
    const stop = startActivitySync(h.tab, DID, env)
    await h.clock.advance(MOUNT_DELAY_MS - 1)
    expect(prismLists()).toBe(0)
    await h.clock.advance(1)
    expect(prismLists()).toBe(1)
    toForeground()
    await settle()
    expect(prismLists()).toBe(1)
    // Due again an hour after the complete run: the scheduled check.
    await h.clock.advance(RECONCILE_INTERVAL_MS)
    expect(prismLists()).toBe(2)
    // Due again on a return to the foreground after the hour.
    await h.clock.advance(RECONCILE_INTERVAL_MS - 1_000)
    h.shared.store.clearReconciled(DID)
    toForeground()
    await settle()
    expect(prismLists()).toBe(3)
    stop()
  })

  it('does not run without the checks or out of the foreground', async () => {
    const off = syncEnv()
    off.state.can = false
    let stop = startActivitySync(h.tab, DID, off.env)
    await h.clock.advance(RECONCILE_INTERVAL_MS)
    expect(prismLists()).toBe(0)
    stop()

    const hidden = syncEnv()
    hidden.state.foreground = false
    stop = startActivitySync(h.tab, DID, hidden.env)
    await h.clock.advance(RECONCILE_INTERVAL_MS)
    expect(prismLists()).toBe(0)
    hidden.toForeground()
    await settle()
    expect(prismLists()).toBe(1)
    stop()
  })

  it('keys of account A are not levelled while B is current', async () => {
    h.shared.store.writeToken(DID, SUBJECT, 'a-key')
    h.env.current = OTHER_ACCOUNT
    await h.tab.mirror.level(DID, SUBJECT)
    await h.clock.advance(GRACE_MS)
    expect(h.prism.puts()).toEqual([])
    expect(h.profileReads()).toBe(0)
    expect(h.token()).toBe('a-key')
  })

  it('Reindexing on the list read stops the run, sets catching-up and leaves the account a member (FU-3)', async () => {
    writeLocal(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private']}),
    )
    resetMembership()
    try {
      h.bluesky.bells.set(SUBJECT, ON)
      h.prism.state.listReply = {
        status: 503,
        body: {error: 'Reindexing', message: 'Reindexing', retryAfter: 30},
      }
      const result = await h.tab.reconcile.run(clients())
      expect(result).toMatchObject({complete: false, stopped: 'prism-read'})
      expect(h.prism.puts()).toEqual([])
      expect(h.shared.store.readReconciled(DID)).toBeUndefined()
      expect(getPrismHealth(DID).causes.has('catching-up')).toBe(true)
      expect(getMembership(DID)).toBe('member')
    } finally {
      writeLocal(membershipStorageKey(DID), undefined)
      resetMembership()
    }
  })

  it('NotEnrolled clears reconciled:<did>', async () => {
    h.shared.store.writeReconciled(DID, 1)
    h.prism.state.listReply = xrpcError(403, 'NotEnrolled')
    const result = await h.tab.reconcile.run(clients())
    expect(result.stopped).toBe('not-enrolled')
    expect(h.shared.store.readReconciled(DID)).toBeUndefined()
  })

  it('LimitReached is logged, stops turn-ons and leaves the run incomplete', async () => {
    for (const subject of [SUBJECT, SUBJECT_2, SUBJECT_3, SUBJECT_4]) {
      h.bluesky.bells.set(subject, ON)
    }
    h.prism.state.putReply = (): Reply => xrpcError(400, 'LimitReached')
    const result = await h.tab.reconcile.run(clients())
    expect(result.complete).toBe(false)
    // Two in flight at once; none after the cap answered.
    expect(h.prism.puts()).toHaveLength(2)
    expect(h.shared.store.readReconciled(DID)).toBeUndefined()
  })
})
