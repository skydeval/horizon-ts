import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The saver and the prism mirror (activity subscriptions design 2.1, 2.2):
 * T-2 to T-8 and T-10. Each "tab" is a `createActivityTab` over a shared
 * fake store, on a virtual clock, against fake Bluesky and prism servers.
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
import {GRACE_MS, MOUNT_DELAY_MS, OFF} from '../common'
import {
  BOTH,
  DID,
  fakeBluesky,
  fakePrism,
  harness,
  ON,
  OTHER_ACCOUNT,
  settle,
  sharedStore,
  SUBJECT,
  virtualClock,
  xrpcError,
} from './harness'

let h: ReturnType<typeof harness>

beforeEach(() => {
  h = harness()
})

describe('T-2: the prism put follows Bluesky', () => {
  it('puts to prism only after Bluesky accepts, with the accepted flags', async () => {
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    await settle()
    expect(h.prism.puts()).toEqual([])
    h.bluesky.held[0].resolve({status: 200, body: {}})
    await settle()
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
    expect(h.token()).toBeUndefined()
  })

  it('never puts the refused flags', async () => {
    h.bluesky.state.putReply = xrpcError(400, 'InvalidRequest')
    h.press(ON)
    await settle()
    expect(h.prism.puts().map(p => p.activitySubscription)).toEqual([OFF])
  })

  it('reads the checks for the captured DID; an account switch after press changes nothing', async () => {
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    h.env.current = OTHER_ACCOUNT
    h.bluesky.held[0].resolve({status: 200, body: {}})
    await settle()
    // The key waits for its own account.
    expect(h.prism.puts()).toEqual([])
    expect(h.token()).toBeDefined()
    h.env.current = DID
    await h.tab.mirror.level(DID, SUBJECT)
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
  })

  it('keeps the key while unanswered, and sends once membership and features answer', async () => {
    const unmount = h.tab.mirror.mount(DID)
    h.env.applies = 'wait'
    h.press(ON)
    await settle()
    expect(h.prism.puts()).toEqual([])
    expect(h.token()).toBeDefined()
    h.env.applies = 'yes'
    h.answer()
    await settle()
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
    expect(h.token()).toBeUndefined()
    unmount()
  })

  it('removes the key on a definite not-a-member or feature-absent answer', async () => {
    h.env.applies = 'no'
    h.press(ON)
    await settle()
    expect(h.prism.puts()).toEqual([])
    expect(h.token()).toBeUndefined()
    // Bluesky got the press all the same.
    expect(h.bluesky.bells.get(SUBJECT)).toEqual(ON)
  })
})

describe('T-3: Bluesky refuses the latest save (F-4)', () => {
  it('reverts the bell, toasts, and levels prism to Bluesky’s unchanged value', async () => {
    h.bluesky.bells.set(SUBJECT, BOTH)
    h.bluesky.state.putReply = xrpcError(400, 'InvalidRequest')
    h.press(OFF, {before: BOTH})
    await settle()
    expect(h.ui.setBell).toHaveBeenLastCalledWith(
      undefined,
      SUBJECT,
      BOTH,
      undefined,
    )
    expect(h.ui.failedToast).toHaveBeenCalledWith('subject.test')
    expect(h.ui.savedToast).not.toHaveBeenCalled()
    expect(h.profileReads()).toBe(1)
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: BOTH},
    ])
  })
})

describe('T-4: no answer within 15 s (F-5)', () => {
  it('reads getProfile once; a read equal to the press is accepted and mirrored at once', async () => {
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    await h.clock.advance(14_999)
    expect(h.profileReads()).toBe(0)
    // Bluesky holds the press, though its answer is lost.
    h.bluesky.bells.set(SUBJECT, ON)
    await h.clock.advance(1)
    expect(h.profileReads()).toBe(1)
    expect(
      h.bluesky.calls.some(c => c.nsid === 'app.bsky.actor.getProfiles'),
    ).toBe(false)
    expect(h.ui.failedToast).not.toHaveBeenCalled()
    expect(h.ui.savedToast).not.toHaveBeenCalled()
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
  })

  it('a differing read sets the bell with the toast; the mirror levels G after that put', async () => {
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    await h.clock.advance(15_000)
    // An absent field is off.
    expect(h.ui.setBell).toHaveBeenLastCalledWith(
      undefined,
      SUBJECT,
      OFF,
      undefined,
    )
    expect(h.ui.failedToast).toHaveBeenCalledTimes(1)
    expect(h.prism.puts()).toEqual([])
    // A late success of that put does not change the bell.
    const bellWrites = h.ui.setBell.mock.calls.length
    h.bluesky.held[0].resolve({status: 200, body: {}})
    await settle()
    expect(h.ui.setBell.mock.calls.length).toBe(bellWrites)
    await h.clock.advance(GRACE_MS - 15_001)
    expect(h.prism.puts()).toEqual([])
    await h.clock.advance(1)
    // Levelled from Bluesky, which now holds the late put; no second toast
    // since that matches the press.
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
    expect(h.ui.failedToast).toHaveBeenCalledTimes(1)
  })

  it('a failed read goes back to acked', async () => {
    h.bluesky.state.putReply = 'hang'
    h.bluesky.state.profileReply = xrpcError(500, 'InternalServerError')
    h.press(ON, {before: OFF})
    await h.clock.advance(15_000)
    expect(h.ui.setBell).toHaveBeenLastCalledWith(
      undefined,
      SUBJECT,
      OFF,
      undefined,
    )
    expect(h.ui.failedToast).toHaveBeenCalledTimes(1)
  })

  it('a transport error takes this path at once', async () => {
    h.bluesky.state.putReply = new Error('offline')
    h.press(ON)
    await settle()
    expect(h.profileReads()).toBe(1)
    expect(h.ui.failedToast).toHaveBeenCalledTimes(1)
  })

  it('a press made while the read is in flight is not overwritten', async () => {
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    h.bluesky.state.profileReply = 'hang'
    await h.clock.advance(15_000)
    expect(h.profileReads()).toBe(1)
    h.bluesky.state.putReply = undefined
    h.press(BOTH)
    const read = h.bluesky.held.find(
      held => held.call.nsid === 'app.bsky.actor.getProfile',
    )
    read?.resolve({status: 200, body: {}})
    await settle()
    // The read wrote nothing; the newer press stands and is saved.
    expect(
      h.ui.setBell.mock.calls.some(call => call[2] === OFF),
    ).toBe(false)
    expect(h.bluesky.bells.get(SUBJECT)).toEqual(BOTH)
    expect(h.ui.savedToast).toHaveBeenCalledTimes(1)
  })
})

describe('T-5: overlapping saves (F-6)', () => {
  it('sends the second only after the first answers; Bluesky ends with the second', async () => {
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    h.press(BOTH)
    await settle()
    expect(h.blueskyPuts()).toEqual([ON])
    h.bluesky.held[0].resolve({status: 200, body: {}})
    await settle()
    expect(h.blueskyPuts()).toEqual([ON, BOTH])
    h.bluesky.held[1].resolve({status: 200, body: {}})
    await settle()
    expect(h.bluesky.bells.get(SUBJECT)).toEqual(BOTH)
    // Only the latest is toasted.
    expect(h.ui.savedToast).toHaveBeenCalledTimes(1)
    expect(h.prism.puts().at(-1)?.activitySubscription).toEqual(BOTH)
  })

  it('a refused first with a successful second: no revert, no error toast, acked is the second', async () => {
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    h.press(BOTH)
    h.bluesky.held[0].resolve({
      status: 400,
      body: {error: 'InvalidRequest', message: 'x'},
    })
    await settle()
    h.bluesky.held[1].resolve({status: 200, body: {}})
    await settle()
    expect(h.ui.failedToast).not.toHaveBeenCalled()
    expect(h.tab.saver.status(DID, SUBJECT)?.acked).toEqual(BOTH)
    expect(h.ui.setBell).not.toHaveBeenCalled()
  })

  it('a first that times out lets the second go at 15 s', async () => {
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    h.press(BOTH)
    await h.clock.advance(14_000)
    expect(h.blueskyPuts()).toEqual([ON])
    await h.clock.advance(1_000)
    expect(h.blueskyPuts()).toEqual([ON, BOTH])
    // Not the latest: no read.
    expect(h.profileReads()).toBe(0)
  })
})

describe('T-6: mirror rule (a)', () => {
  it('a hand-off within G puts the accepted flags with no read and no ifNotChangedSince', async () => {
    h.press(ON)
    await settle()
    expect(h.profileReads()).toBe(0)
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
  })

  it('a retry within G does the same; one after G levels with a read', async () => {
    h.prism.state.putReply = xrpcError(503, 'ServiceUnavailable')
    h.press(ON)
    await settle()
    expect(h.prism.puts()).toHaveLength(1)
    await h.clock.advance(15_000)
    expect(h.prism.puts()).toHaveLength(2)
    expect(h.profileReads()).toBe(0)
    await h.clock.advance(60_000)
    expect(h.prism.puts()).toHaveLength(3)
    expect(h.profileReads()).toBe(0)
    // The 5 min step is G after the accept: a levelling read.
    h.prism.state.putReply = undefined
    await h.clock.advance(5 * 60_000)
    expect(h.profileReads()).toBe(1)
    expect(h.prism.puts().at(-1)).toEqual({
      subject: SUBJECT,
      activitySubscription: ON,
    })
    expect(h.token()).toBeUndefined()
  })

  it('a new module instance over the same store (a reload) levels with a read', async () => {
    h.prism.state.putReply = xrpcError(503, 'ServiceUnavailable')
    h.press(ON)
    await settle()
    // The old tab is gone with its memory and timers.
    h.tab.mirror.reset()
    h.tab.saver.reset()
    const reloaded = harness({
      clock: h.clock,
      shared: h.shared,
      bluesky: h.bluesky,
      prism: h.prism,
    })
    h.prism.state.putReply = undefined
    const unmount = reloaded.tab.mirror.mount(DID)
    const reads = h.profileReads()
    await h.clock.advance(MOUNT_DELAY_MS - 1)
    expect(h.profileReads()).toBe(reads)
    await h.clock.advance(1)
    expect(h.profileReads()).toBe(reads + 1)
    expect(h.prism.puts().at(-1)).toEqual({
      subject: SUBJECT,
      activitySubscription: ON,
    })
    expect(h.token()).toBeUndefined()
    unmount()
  })
})

describe('T-7: transient prism failures', () => {
  it('retry at 15 s, 1, 5, 15 and 60 min once per press, with one toast', async () => {
    h.prism.state.putReply = xrpcError(503, 'ServiceUnavailable')
    h.press(ON)
    await settle()
    expect(h.ui.mirrorPendingToast).toHaveBeenCalledTimes(1)
    expect(h.ui.mirrorPendingToast).toHaveBeenCalledWith(ON)
    const steps = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
    for (const [i, step] of steps.entries()) {
      await h.clock.advance(step - 1)
      expect(h.prism.puts()).toHaveLength(i + 1)
      await h.clock.advance(1)
      expect(h.prism.puts()).toHaveLength(i + 2)
    }
    await h.clock.advance(6 * 60 * 60_000)
    expect(h.prism.puts()).toHaveLength(6)
    expect(h.ui.mirrorPendingToast).toHaveBeenCalledTimes(1)
    expect(h.token()).toBeDefined()
  })

  it('NotReady and network failures are transient too; the off toast for an off', async () => {
    h.prism.state.putReply = xrpcError(400, 'NotReady')
    h.press(OFF, {before: ON})
    await settle()
    expect(h.token()).toBeDefined()
    expect(h.ui.mirrorPendingToast).toHaveBeenCalledWith(OFF)
    h.prism.state.putReply = new Error('offline')
    await h.clock.advance(15_000)
    expect(h.token()).toBeDefined()
  })

  it('Reindexing is transient, sets catching-up and leaves the account a member (FU-3)', async () => {
    writeLocal(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private']}),
    )
    resetMembership()
    try {
      h.prism.state.putReply = {
        status: 503,
        body: {error: 'Reindexing', message: 'Reindexing', retryAfter: 30},
      }
      h.press(ON)
      await settle()
      expect(h.token()).toBeDefined()
      expect(h.ui.mirrorPendingToast).toHaveBeenCalledWith(ON)
      expect(getPrismHealth(DID).causes.has('catching-up')).toBe(true)
      expect(getMembership(DID)).toBe('member')
    } finally {
      writeLocal(membershipStorageKey(DID), undefined)
      resetMembership()
    }
  })

  it('a leftover key shows no toast', async () => {
    h.shared.store.writeToken(DID, SUBJECT, 'from-an-earlier-run')
    h.prism.state.putReply = xrpcError(503, 'ServiceUnavailable')
    const unmount = h.tab.mirror.mount(DID)
    await h.clock.advance(MOUNT_DELAY_MS)
    expect(h.prism.puts()).toHaveLength(1)
    expect(h.ui.mirrorPendingToast).not.toHaveBeenCalled()
    unmount()
  })

  it('InvalidRequest and NotEnrolled remove the key', async () => {
    h.prism.state.putReply = xrpcError(400, 'InvalidRequest')
    h.press(ON)
    await settle()
    expect(h.token()).toBeUndefined()
    h.prism.state.putReply = xrpcError(403, 'NotEnrolled')
    h.shared.store.writeReconciled(DID, 1)
    h.press(OFF)
    await settle()
    expect(h.token()).toBeUndefined()
    expect(h.shared.store.readReconciled(DID)).toBeUndefined()
    expect(h.ui.mirrorPendingToast).not.toHaveBeenCalled()
  })

  it('success removes the key, but not when another tab has since rewritten its token', async () => {
    h.press(ON)
    await settle()
    expect(h.token()).toBeUndefined()
    h.prism.state.putReply = () => {
      // Another tab's press lands while this put is on its way.
      h.shared.store.writeToken(DID, SUBJECT, 'another-tab')
      return undefined
    }
    h.press(BOTH)
    await settle()
    expect(h.prism.puts()).toHaveLength(2)
    expect(h.token()).toBe('another-tab')
  })
})

describe('T-8: levelling', () => {
  it('a key left from an earlier run is levelled 20 s after mount, and no trigger levels it sooner', async () => {
    h.bluesky.bells.set(SUBJECT, ON)
    h.shared.store.writeToken(DID, SUBJECT, 'earlier')
    const unmount = h.tab.mirror.mount(DID)
    h.answer()
    await h.tab.mirror.levelAll(DID)
    await h.clock.advance(MOUNT_DELAY_MS - 1)
    expect(h.profileReads()).toBe(0)
    expect(h.prism.puts()).toEqual([])
    await h.clock.advance(1)
    expect(h.profileReads()).toBe(1)
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
    expect(h.token()).toBeUndefined()
    // A leftover key that moves the bell shows no toast.
    expect(h.ui.failedToast).not.toHaveBeenCalled()
    unmount()
  })

  it('a blocked profile is put off and the key removed; a failed read keeps it', async () => {
    h.bluesky.bells.set(SUBJECT, ON)
    h.bluesky.blocked.add(SUBJECT)
    h.shared.store.writeToken(DID, SUBJECT, 'earlier')
    const unmount = h.tab.mirror.mount(DID)
    await h.clock.advance(MOUNT_DELAY_MS)
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: OFF},
    ])
    expect(h.token()).toBeUndefined()

    h.shared.store.writeToken(DID, SUBJECT, 'again')
    h.bluesky.state.profileReply = xrpcError(500, 'InternalServerError')
    await h.tab.mirror.level(DID, SUBJECT)
    await h.clock.advance(GRACE_MS)
    expect(h.token()).toBe('again')
    unmount()
  })

  it('a levelling read does not write the bell if a press came during it', async () => {
    h.shared.store.writeToken(DID, SUBJECT, 'earlier')
    const unmount = h.tab.mirror.mount(DID)
    h.bluesky.state.profileReply = 'hang'
    await h.clock.advance(MOUNT_DELAY_MS)
    expect(h.profileReads()).toBe(1)
    h.bluesky.state.profileReply = undefined
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    h.bluesky.held
      .find(held => held.call.nsid === 'app.bsky.actor.getProfile')
      ?.resolve({status: 200, body: {}})
    await settle()
    expect(h.ui.setBell).not.toHaveBeenCalled()
    expect(h.prism.puts()).toEqual([])
    unmount()
  })

  it('the F-4 toast only when this tab pressed, the read changes the bell and differs from the press', async () => {
    // A read that moves the bell to the press: silent.
    h.bluesky.state.putReply = 'hang'
    h.press(ON)
    await h.clock.advance(15_000)
    expect(h.ui.failedToast).toHaveBeenCalledTimes(1)
    h.bluesky.held[0].resolve({status: 200, body: {}})
    await h.clock.advance(GRACE_MS)
    expect(h.ui.setBell).toHaveBeenLastCalledWith(
      undefined,
      SUBJECT,
      ON,
      undefined,
    )
    expect(h.ui.failedToast).toHaveBeenCalledTimes(1)

    // A read that differs from the press and changes the bell: the toast.
    const other = harness()
    other.bluesky.state.putReply = 'hang'
    other.press(ON)
    await other.clock.advance(15_000)
    other.bluesky.bells.set(SUBJECT, BOTH)
    await other.clock.advance(GRACE_MS)
    expect(other.ui.failedToast).toHaveBeenCalledTimes(2)
  })

  it('a foreign token moves the bell with no toast', async () => {
    const shared = sharedStore()
    const clock = virtualClock()
    const bluesky = fakeBluesky()
    const prism = fakePrism()
    const b = harness({clock, shared, bluesky, prism})
    const unmount = b.tab.mirror.mount(DID)
    shared.store.writeToken(DID, SUBJECT, 'tab-a')
    bluesky.bells.set(SUBJECT, ON)
    await clock.advance(GRACE_MS)
    expect(prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
    expect(b.ui.failedToast).not.toHaveBeenCalled()
    unmount()
  })

  it('two tabs: tab B makes no prism put within G of tab A\u2019s press; tab A sends nothing over B\u2019s newer token', async () => {
    const shared = sharedStore()
    const clock = virtualClock()
    const bluesky = fakeBluesky()
    const prismA = fakePrism()
    const prismB = fakePrism()
    const a = harness({clock, shared, bluesky, prism: prismA})
    const lagged = fakeBluesky()
    const b = harness({clock, shared, bluesky: lagged, prism: prismB})
    const unmountB = b.tab.mirror.mount(DID)
    await clock.advance(MOUNT_DELAY_MS)
    bluesky.bells.set(SUBJECT, ON)
    // Tab B reads Bluesky with lag: the old value.
    lagged.bells.set(SUBJECT, ON)
    // Tab A turns the bell off while prism is down for it.
    prismA.state.putReply = xrpcError(503, 'ServiceUnavailable')
    a.press(OFF, {before: ON})
    await clock.advance(1_000)
    // Tab B is made visible and its checks answer.
    b.answer()
    await b.tab.mirror.levelAll(DID)
    await clock.advance(GRACE_MS - 2_000)
    expect(prismB.puts()).toEqual([])
    expect(lagged.calls).toEqual([])

    // Tab B presses; tab A's fresh acked is not sent over B's token.
    prismA.state.putReply = undefined
    const aPuts = prismA.puts().length
    lagged.state.putReply = 'hang'
    b.press(BOTH)
    await a.tab.mirror.level(DID, SUBJECT)
    expect(prismA.puts().length).toBe(aPuts)
    unmountB()
  })

  it('tab C mounted just after tab A\u2019s press levels at mount + 20 s; A\u2019s later acceptance puts again (AS5-N2)', async () => {
    const shared = sharedStore()
    const clock = virtualClock()
    const prism = fakePrism()
    const blueskyA = fakeBluesky()
    // Tab C reads Bluesky before the press shows there.
    const blueskyC = fakeBluesky()
    const a = harness({clock, shared, bluesky: blueskyA, prism})
    blueskyA.state.putReply = 'hang'
    a.press(ON)
    const c = harness({clock, shared, bluesky: blueskyC, prism})
    const unmountC = c.tab.mirror.mount(DID)
    // A's put lands at Bluesky but its answer is lost; its 15 s read is slow.
    blueskyA.bells.set(SUBJECT, ON)
    blueskyA.state.profileReply = 'hang'
    await clock.advance(15_000)
    expect(a.profileReads()).toBe(1)
    await clock.advance(MOUNT_DELAY_MS - 15_000)
    // C levels from its lagged read and removes the key.
    expect(prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: OFF},
    ])
    expect(a.token()).toBeUndefined()
    // A's read confirms the press: a fresh token of its own, and rule (a).
    blueskyA.held
      .find(held => held.call.nsid === 'app.bsky.actor.getProfile')
      ?.resolve({status: 200, body: {}})
    await settle()
    expect(prism.puts().at(-1)).toEqual({
      subject: SUBJECT,
      activitySubscription: ON,
    })
    expect(a.token()).toBeUndefined()
    unmountC()
  })

  it('with a foreign token present at that hand-off, tab A defers to it', async () => {
    const a = harness()
    const unmountA = a.tab.mirror.mount(DID)
    a.bluesky.state.putReply = 'hang'
    a.press(ON)
    // Another tab presses after A: its token is foreign to A.
    a.shared.store.writeToken(DID, SUBJECT, 'tab-b')
    a.bluesky.held[0].resolve({status: 200, body: {}})
    await settle()
    expect(a.prism.puts()).toEqual([])
    expect(a.token()).toBe('tab-b')
    unmountA()
  })
})

describe('T-10: coalescing', () => {
  it('on, off, on while prism is down leads to one prism put with Bluesky’s flags', async () => {
    const unmount = h.tab.mirror.mount(DID)
    h.env.applies = 'wait'
    h.press(ON)
    await settle()
    h.press(OFF)
    await settle()
    h.press(ON)
    await settle()
    expect(h.prism.puts()).toEqual([])
    h.env.applies = 'yes'
    h.answer()
    await settle()
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
    unmount()
  })
})
