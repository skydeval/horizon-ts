import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The savers (activity subscriptions design 2.3): the press as the dialog's
 * close callback runs it (`savePress`), each store's saver, and the
 * `PressGroup` join, against fake servers on a virtual clock. The Bluesky
 * cases moved here from v6's `mirror-test.ts` (T-3 to T-5).
 */

// The suite mocks multiformats globally; the lex client needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')
jest.mock('#/components/Toast', () => ({show: () => {}}))
// The real `ui.ts` runs; only the app-wide shadow and the list's key are stubbed.
jest.mock('#/state/cache/profile-shadow', () => ({
  updateProfileShadow: () => {},
}))
jest.mock('#/state/queries/activity-subscriptions', () => ({
  RQKEY_getActivitySubscriptions: ['activity-subscriptions'],
}))
// `private-state.ts`'s hooks are not used here; keep the session out.
jest.mock('#/horizon/private/membership', () => ({
  usePrivateFeedSource: () => undefined,
}))
jest.mock('#/horizon/private/activity-subscriptions/hooks', () => ({
  useActivitySubscriptionsShown: () => false,
}))

import {QueryObserver} from '@tanstack/react-query'

import {getPrismHealth, reportProbeStatus, resetPrismHealth} from '#/horizon/routing/health'
import {getMembership, resetMembership} from '#/horizon/routing/membership'
import {membershipStorageKey} from '#/horizon/routing/membership-record'
import {writeLocal} from '#/horizon/session/local-store'
import {type Flags,OFF} from '../common'
import {
  privateActivitySubscriptionsKey,
  type PrivateFlagsMap,
  readAllPrismSubscriptions,
} from '../private-state'
import {savePress} from '../saver'
import {readBellTruth} from '../ui'
import {
  BOTH,
  DID,
  type Harness,
  harness,
  ok,
  ON,
  settle,
  SUBJECT,
  SUBJECT_2,
  xrpcError,
} from './harness'

let h: Harness

beforeEach(() => {
  h = harness()
})

/** The profile as the dialog got it, with Bluesky's bell at open. */
function profileWith(flags: Flags, subject = SUBJECT) {
  return {
    did: subject,
    handle: 'subject.test',
    viewer: flags.post || flags.reply ? {activitySubscription: flags} : {},
  } as never
}

/** The public bell the cache shows now (the shadow, else the profile). */
function bell(profile?: never) {
  return readBellTruth(h.queryClient, SUBJECT, profile)
}

/**
 * A public press as the dialog makes it: `before` is the dialog's render
 * (default: what the cache shows now), and the close callback runs at once.
 */
function pressPublic(
  flags: Flags,
  {before, profile}: {before?: Flags; profile?: never} = {},
) {
  return savePress(h.savers, {
    ctx: {...h.ctx(), profile},
    before: {public: before ?? bell(profile), private: OFF},
    after: {public: flags, private: OFF},
  })
}

describe('T-3: Bluesky refuses the latest save', () => {
  it('reverts the bell to the cached truth read before the write, with the toast', async () => {
    const profile = profileWith(BOTH)
    h.bluesky.bells.set(SUBJECT, BOTH)
    h.bluesky.state.putReply = xrpcError(400, 'InvalidRequest')
    pressPublic(OFF, {profile})
    // The press shows at once.
    expect(bell(profile)).toEqual(OFF)
    await settle()
    expect(bell(profile)).toEqual(BOTH)
    expect(h.toasts.failedToast).toHaveBeenCalledWith('subject.test')
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
    expect(h.bluesky.reads()).toBe(0)
  })

  it('a first press, refused, reverts to the shadow’s prior value, not the press (AS10-L1)', async () => {
    h.bluesky.state.putReply = xrpcError(400, 'InvalidRequest')
    pressPublic(ON)
    await settle()
    expect(bell()).toEqual(OFF)
    expect(h.savers.bluesky.status(h.did, SUBJECT)?.acked).toEqual(OFF)
  })

  it('a press whose earlier put is refused during the close animation reverts to the shadow at the callback, not the render (AS10-L1)', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    // The member reopens the dialog: it renders press 1.
    const render = bell()
    expect(render).toEqual(ON)
    // Press 1 is refused while press 2's dialog is closing.
    h.bluesky.heldOf('app.bsky.notification.putActivitySubscription')[0].resolve(
      xrpcError(400, 'InvalidRequest'),
    )
    await settle()
    expect(bell()).toEqual(OFF)
    expect(h.savers.bluesky.status(h.did, SUBJECT)?.idle).toBe(true)
    // The close callback runs now, with the dialog's stale render as `before`.
    h.bluesky.state.putReply = xrpcError(400, 'InvalidRequest')
    pressPublic(BOTH, {before: render})
    await settle()
    expect(bell()).toEqual(OFF)
    expect(h.toasts.failedToast).toHaveBeenCalledTimes(2)
  })
})

describe('T-4: no answer within 15 s, or a transport error', () => {
  it('reads getProfile once; a read equal to the press is confirmed, with the success toast', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    await h.clock.advance(14_999)
    expect(h.bluesky.reads()).toBe(0)
    // Bluesky holds the press, though its answer is lost.
    h.bluesky.bells.set(SUBJECT, ON)
    await h.clock.advance(1)
    expect(h.bluesky.reads()).toBe(1)
    expect(
      h.bluesky.calls.some(c => c.nsid === 'app.bsky.actor.getProfiles'),
    ).toBe(false)
    expect(bell()).toEqual(ON)
    expect(h.toasts.failedToast).not.toHaveBeenCalled()
    expect(h.toasts.savedToast).toHaveBeenCalledWith('subject.test', ON, OFF)
  })

  it('a differing read sets the bell with the toast; a late success changes nothing', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    await h.clock.advance(15_000)
    // An absent field is off.
    expect(bell()).toEqual(OFF)
    expect(h.toasts.failedToast).toHaveBeenCalledTimes(1)
    h.bluesky.heldOf('app.bsky.notification.putActivitySubscription')[0].resolve(
      {status: 200, body: {}},
    )
    await settle()
    expect(bell()).toEqual(OFF)
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
    expect(h.toasts.failedToast).toHaveBeenCalledTimes(1)
  })

  it('a failed read goes back to acked', async () => {
    h.bluesky.state.putReply = 'hang'
    h.bluesky.state.profileReply = xrpcError(500, 'InternalServerError')
    pressPublic(ON)
    await h.clock.advance(15_000)
    expect(bell()).toEqual(OFF)
    expect(h.toasts.failedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
  })

  it('a transport error takes this path at once', async () => {
    h.bluesky.state.putReply = new Error('offline')
    pressPublic(ON)
    await settle()
    expect(h.bluesky.reads()).toBe(1)
    expect(h.toasts.failedToast).toHaveBeenCalledTimes(1)
  })

  it('a press made while the read is in flight is not overwritten; the read reports superseded', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    h.bluesky.state.profileReply = 'hang'
    await h.clock.advance(15_000)
    expect(h.bluesky.reads()).toBe(1)
    h.bluesky.state.putReply = undefined
    pressPublic(BOTH)
    await settle()
    h.bluesky.heldOf('app.bsky.actor.getProfile')[0].resolve({
      status: 200,
      body: {},
    })
    await settle()
    // The read wrote nothing; the newer press stands and is saved.
    expect(bell()).toEqual(BOTH)
    expect(h.bluesky.bells.get(SUBJECT)).toEqual(BOTH)
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.failedToast).not.toHaveBeenCalled()
  })

  it('a read overtaken by a newer press that then fails writes nothing and shows no toast', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    h.bluesky.state.profileReply = 'hang'
    await h.clock.advance(15_000)
    h.bluesky.state.putReply = undefined
    pressPublic(BOTH)
    await settle()
    h.bluesky.heldOf('app.bsky.actor.getProfile')[0].resolve(
      xrpcError(500, 'InternalServerError'),
    )
    await settle()
    expect(bell()).toEqual(BOTH)
    expect(h.toasts.failedToast).not.toHaveBeenCalled()
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
  })
})

describe('T-5: overlapping saves', () => {
  const held = () =>
    h.bluesky.heldOf('app.bsky.notification.putActivitySubscription')

  it('sends the second only after the first answers; Bluesky ends with the second', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    pressPublic(BOTH)
    await settle()
    expect(h.bluesky.puts()).toEqual([ON])
    held()[0].resolve({status: 200, body: {}})
    await settle()
    expect(h.bluesky.puts()).toEqual([ON, BOTH])
    held()[1].resolve({status: 200, body: {}})
    await settle()
    expect(h.bluesky.bells.get(SUBJECT)).toEqual(BOTH)
    // Only the latest is toasted.
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
  })

  it('a refused first with a successful second: no revert, no error toast, acked is the second', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    pressPublic(BOTH)
    held()[0].resolve(xrpcError(400, 'InvalidRequest'))
    await settle()
    expect(bell()).toEqual(BOTH)
    held()[1].resolve({status: 200, body: {}})
    await settle()
    expect(h.toasts.failedToast).not.toHaveBeenCalled()
    expect(h.savers.bluesky.status(h.did, SUBJECT)?.acked).toEqual(BOTH)
    expect(bell()).toEqual(BOTH)
  })

  it('a first that times out lets the second go at 15 s', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    pressPublic(BOTH)
    await h.clock.advance(14_000)
    expect(h.bluesky.puts()).toEqual([ON])
    await h.clock.advance(1_000)
    expect(h.bluesky.puts()).toEqual([ON, BOTH])
    // Not the latest: no read.
    expect(h.bluesky.reads()).toBe(0)
  })

  it('three presses (on, off, on) behind one put: each group settles once, and press 3 gets its toast', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    pressPublic(OFF)
    pressPublic(ON)
    held()[0].resolve({status: 200, body: {}})
    await settle()
    // One extra put of the same flags, for the newest press.
    expect(h.bluesky.puts()).toEqual([ON, ON])
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
    held()[1].resolve({status: 200, body: {}})
    await settle()
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.savedToast).toHaveBeenCalledWith('subject.test', ON, OFF)
    expect(h.savers.bluesky.status(h.did, SUBJECT)?.idle).toBe(true)
  })

  it('a superseded refusal shows nothing', async () => {
    h.bluesky.state.putReply = 'hang'
    pressPublic(ON)
    pressPublic(BOTH)
    held()[0].resolve(xrpcError(400, 'InvalidRequest'))
    await settle()
    held()[1].resolve(xrpcError(400, 'InvalidRequest'))
    await settle()
    // Only the latest press's refusal speaks; it reverts to acked.
    expect(h.toasts.failedToast).toHaveBeenCalledTimes(1)
    expect(bell()).toEqual(OFF)
  })
})

const LIST = privateActivitySubscriptionsKey(DID)
const PUT = 'app.nearhorizon.private.putActivitySubscription'
const LIST_NSID = 'app.nearhorizon.private.listActivitySubscriptions'

/** prism's list as loaded into the account's cache. */
function seedList(map: PrivateFlagsMap = {}) {
  h.queryClient.setQueryData(LIST, map)
}

function list(): PrivateFlagsMap | undefined {
  return h.queryClient.getQueryData<PrivateFlagsMap>(LIST)
}

function cachedPrivate(subject = SUBJECT): Flags | undefined {
  const data = list()
  return data ? (data[subject] ?? OFF) : undefined
}

/**
 * A press of the private pair (and the public one, when given): `before` is
 * the dialog's frozen seed (default: what the list shows now).
 */
function press({
  priv,
  pub,
  before,
  subject = SUBJECT,
}: {
  priv?: Flags
  pub?: Flags
  before?: {public?: Flags; private?: Flags}
  subject?: string
}) {
  const publicBefore = before?.public ?? readBellTruth(h.queryClient, subject)
  const privateBefore = before?.private ?? cachedPrivate(subject) ?? OFF
  return savePress(h.savers, {
    ctx: h.ctx(subject),
    before: {public: publicBefore, private: privateBefore},
    after: {public: pub ?? publicBefore, private: priv ?? privateBefore},
  })
}

describe('T7-2: only changed pairs are sent, each to its own store', () => {
  it('the private pair goes only to prism; the accepted put’s returned flags land in the list', async () => {
    seedList()
    expect(press({priv: ON})).toEqual(['prism'])
    // The press shows at once.
    expect(cachedPrivate()).toEqual(ON)
    await settle()
    expect(h.prism.puts()).toEqual([
      {subject: SUBJECT, activitySubscription: ON},
    ])
    expect(h.bluesky.calls).toEqual([])
    expect(cachedPrivate()).toEqual(ON)
    expect(h.toasts.savedToast).toHaveBeenCalledWith('subject.test', ON, OFF)
  })

  it('the public pair goes only to Bluesky, and a public-only Save leaves a first list load running', async () => {
    h.prism.state.listReply = 'hang'
    const load = h.queryClient.fetchQuery({
      queryKey: LIST,
      queryFn: () => readAllPrismSubscriptions(h.prism.client),
    })
    await settle()
    expect(press({pub: ON})).toEqual(['bluesky'])
    await settle()
    expect(h.prism.puts()).toEqual([])
    expect(h.queryClient.getQueryState(LIST)?.fetchStatus).toBe('fetching')
    h.prism.heldOf(LIST_NSID)[0].resolve({status: 200})
    await load
    expect(h.bluesky.puts()).toEqual([ON])
  })

  it('a private Save cancels a list fetch in flight; the fetch’s late answer is not written', async () => {
    seedList({[SUBJECT_2]: BOTH})
    h.prism.state.listReply = 'hang'
    // A mounted observer refetches the stale list in the background.
    const observer = new QueryObserver(h.queryClient, {
      queryKey: LIST,
      queryFn: () => readAllPrismSubscriptions(h.prism.client),
      staleTime: 0,
    })
    const unsubscribe = observer.subscribe(() => {})
    await settle()
    expect(h.queryClient.getQueryState(LIST)?.fetchStatus).toBe('fetching')
    h.prism.state.putReply = 'hang'
    press({priv: ON})
    expect(h.queryClient.getQueryState(LIST)?.fetchStatus).toBe('idle')
    expect(list()).toEqual({[SUBJECT_2]: BOTH, [SUBJECT]: ON})
    // The cancelled call answers with the old page: nothing changes.
    h.prism.heldOf(LIST_NSID)[0].resolve(ok({subscriptions: []}))
    await settle()
    expect(list()).toEqual({[SUBJECT_2]: BOTH, [SUBJECT]: ON})
    unsubscribe()
  })

  it('a first load cancelled all the same is refetched for a mounted observer', async () => {
    h.prism.state.listReply = 'hang'
    const observer = new QueryObserver(h.queryClient, {
      queryKey: LIST,
      queryFn: () => readAllPrismSubscriptions(h.prism.client),
    })
    const unsubscribe = observer.subscribe(() => {})
    await settle()
    expect(h.prism.lists()).toHaveLength(1)
    press({priv: ON, before: {private: OFF}})
    await settle()
    // Cancelled with no data to keep: invalidated, so it is read again.
    expect(h.prism.lists()).toHaveLength(2)
    // Answer every held read, so no call deadline outlives the test.
    for (const held of h.prism.heldOf(LIST_NSID)) held.resolve({status: 200})
    await settle()
    unsubscribe()
  })
})

describe('T7-3: the join', () => {
  it('both accepted: one success toast, worded from all four flags', async () => {
    seedList()
    press({pub: ON, priv: ON})
    await settle()
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.savedToast).toHaveBeenCalledWith('subject.test', ON, OFF)
  })

  it('all off after reads as “no longer”: the union of both pairs', async () => {
    seedList({[SUBJECT]: ON})
    press({priv: OFF, before: {public: ON}})
    await settle()
    // The public pair is still on, so the toast is not "no longer".
    expect(h.toasts.savedToast).toHaveBeenCalledWith('subject.test', ON, ON)
  })

  it('a first prism press, refused, reverts to the list’s prior value, not the press (AS10-L1)', async () => {
    seedList({[SUBJECT]: BOTH})
    h.prism.state.putReply = xrpcError(400, 'InvalidRequest')
    press({priv: OFF})
    expect(cachedPrivate()).toEqual(OFF)
    await settle()
    expect(cachedPrivate()).toEqual(BOTH)
    expect(h.toasts.privateFailedToast).toHaveBeenCalledWith(
      'subject.test',
      false,
    )
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
  })

  it('one store refuses: that pair turns back with its toast; the other pair stands', async () => {
    seedList()
    h.prism.state.putReply = xrpcError(400, 'InvalidRequest')
    press({pub: ON, priv: ON})
    await settle()
    expect(cachedPrivate()).toEqual(OFF)
    expect(readBellTruth(h.queryClient, SUBJECT)).toEqual(ON)
    expect(h.bluesky.bells.get(SUBJECT)).toEqual(ON)
    expect(h.toasts.privateFailedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.failedToast).not.toHaveBeenCalled()
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
  })

  it('LimitReached alone: the limit wording', async () => {
    seedList()
    h.prism.state.putReply = xrpcError(400, 'LimitReached')
    press({priv: ON})
    await settle()
    expect(h.toasts.privateFailedToast).toHaveBeenCalledWith(
      'subject.test',
      true,
    )
  })

  it('both refuse: one combined toast, keeping the limit wording', async () => {
    seedList()
    h.prism.state.putReply = xrpcError(400, 'LimitReached')
    h.bluesky.state.putReply = xrpcError(400, 'InvalidRequest')
    press({pub: ON, priv: ON})
    await settle()
    expect(h.toasts.combinedFailedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.combinedFailedToast).toHaveBeenCalledWith(
      'subject.test',
      true,
    )
    expect(h.toasts.failedToast).not.toHaveBeenCalled()
    expect(h.toasts.privateFailedToast).not.toHaveBeenCalled()
  })

  it('a press superseded in one store only shows no toast, even with the other accepted', async () => {
    seedList()
    h.prism.state.putReply = 'hang'
    press({pub: ON, priv: ON})
    press({priv: BOTH})
    await settle()
    h.prism.heldOf(PUT)[0].resolve({status: 200})
    await settle()
    // Press 1: Bluesky accepted, prism superseded: silent.
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
    h.prism.heldOf(PUT)[1].resolve({status: 200})
    await settle()
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
    expect(cachedPrivate()).toEqual(BOTH)
  })
})

describe('T7-4: no answer in 15 s, or a transport error (prism)', () => {
  it('one direct read of the whole list, not a query refetch; equal to the press is confirmed', async () => {
    seedList()
    h.prism.state.putReply = 'hang'
    press({priv: ON})
    await h.clock.advance(14_999)
    expect(h.prism.lists()).toHaveLength(0)
    // prism holds the press, though its answer is lost.
    h.prism.rows.set(SUBJECT, ON)
    await h.clock.advance(1)
    expect(h.prism.lists()).toHaveLength(1)
    expect(h.queryClient.getQueryState(LIST)?.fetchStatus).toBe('idle')
    expect(cachedPrivate()).toEqual(ON)
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.privateFailedToast).not.toHaveBeenCalled()
    // A late answer to the put changes nothing.
    h.prism.heldOf(PUT)[0].resolve(xrpcError(400, 'InvalidRequest'))
    await settle()
    expect(cachedPrivate()).toEqual(ON)
    expect(h.toasts.privateFailedToast).not.toHaveBeenCalled()
  })

  it('a transport error, then a read that differs: the cache takes the read, with the toast', async () => {
    seedList()
    h.prism.state.putReply = new Error('reset')
    press({priv: ON})
    await settle()
    expect(h.prism.lists()).toHaveLength(1)
    expect(cachedPrivate()).toEqual(OFF)
    expect(h.toasts.privateFailedToast).toHaveBeenCalledTimes(1)
  })

  it('a transport error, then a read that fails in transport: back to acked with the toast, never success', async () => {
    seedList({[SUBJECT]: BOTH})
    h.prism.state.putReply = new Error('offline')
    h.prism.state.listReply = new Error('offline')
    press({priv: OFF})
    await settle()
    expect(cachedPrivate()).toEqual(BOTH)
    expect(h.toasts.privateFailedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
  })

  it('the read writes its subject only: another subject’s pending press stands', async () => {
    seedList()
    h.prism.state.putReply = call =>
      (call.body as {subject: string}).subject === SUBJECT
        ? new Error('reset')
        : 'hang'
    press({priv: ON, subject: SUBJECT_2})
    press({priv: ON})
    await settle()
    // SUBJECT's read found it off; SUBJECT_2's press is untouched.
    expect(cachedPrivate()).toEqual(OFF)
    expect(cachedPrivate(SUBJECT_2)).toEqual(ON)
  })

  it('a read in flight is not cancelled by another subject’s press, and is compared as usual', async () => {
    seedList()
    h.prism.state.putReply = new Error('reset')
    h.prism.state.listReply = 'hang'
    press({priv: ON})
    await settle()
    expect(h.prism.lists()).toHaveLength(1)
    h.prism.state.putReply = undefined
    h.prism.state.listReply = undefined
    // A press on another subject cancels list fetches.
    press({priv: ON, subject: SUBJECT_2})
    h.prism.rows.set(SUBJECT, ON)
    h.prism.heldOf(LIST_NSID)[0].resolve({status: 200})
    await settle()
    expect(cachedPrivate()).toEqual(ON)
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(2)
    expect(h.toasts.privateFailedToast).not.toHaveBeenCalled()
  })

  it('while throttled, the truth read sends its own call and does not take a lead’s pre-put body', async () => {
    resetPrismHealth({
      setTimeout: h.clock.setTimeout,
      clearTimeout: h.clock.clearTimeout,
      random: () => 0,
    })
    seedList()
    reportProbeStatus(DID, 'reindexing')
    // A list fetch leads, from before the put.
    h.prism.state.listReply = 'hang'
    void h.queryClient.fetchQuery({
      queryKey: LIST,
      queryFn: () => readAllPrismSubscriptions(h.prism.client),
      staleTime: 0,
    })
    await settle()
    expect(h.prism.lists()).toHaveLength(1)
    h.prism.state.listReply = undefined
    // The put lands at prism, but its answer is lost.
    h.prism.state.putReply = () => {
      h.prism.rows.set(SUBJECT, ON)
      return new Error('reset')
    }
    press({priv: ON})
    await settle()
    // The truth read waits behind the lead.
    expect(h.prism.lists()).toHaveLength(1)
    h.prism.heldOf(LIST_NSID)[0].resolve(ok({subscriptions: []}))
    await h.clock.advance(0)
    // Its own call, with the post-put list.
    expect(h.prism.lists()).toHaveLength(2)
    expect(cachedPrivate()).toEqual(ON)
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
    expect(h.toasts.privateFailedToast).not.toHaveBeenCalled()
  })
})

describe('T7-5: overlapping saves (prism)', () => {
  it('a refused press after the subject changed elsewhere reverts to the cached truth at the idle press', async () => {
    // The list was refetched with another client's change; the dialog seed is older.
    seedList({[SUBJECT]: BOTH})
    h.prism.state.putReply = xrpcError(400, 'InvalidRequest')
    press({priv: ON, before: {private: OFF}})
    await settle()
    expect(cachedPrivate()).toEqual(BOTH)
  })

  it('a press from a dialog seeded during a refused press, itself refused, reverts to the list, not the seed', async () => {
    seedList()
    h.prism.state.putReply = 'hang'
    press({priv: ON})
    // The dialog reopens and seeds through the overlay: press 1.
    const seed = ON
    h.prism.heldOf(PUT)[0].resolve(xrpcError(400, 'InvalidRequest'))
    await settle()
    expect(cachedPrivate()).toEqual(OFF)
    h.prism.state.putReply = xrpcError(400, 'InvalidRequest')
    press({priv: BOTH, before: {private: seed}})
    await settle()
    expect(cachedPrivate()).toEqual(OFF)
    expect(h.toasts.privateFailedToast).toHaveBeenCalledTimes(2)
  })

  it('three presses behind one put: each group settles once; a public pair in press 3 gets its Bluesky toast', async () => {
    seedList()
    h.prism.state.putReply = 'hang'
    press({priv: ON})
    press({priv: OFF})
    press({priv: ON, pub: ON})
    await settle()
    h.prism.heldOf(PUT)[0].resolve({status: 200})
    await settle()
    expect(h.prism.puts()).toHaveLength(2)
    expect(h.toasts.savedToast).not.toHaveBeenCalled()
    h.prism.heldOf(PUT)[1].resolve({status: 200})
    await settle()
    expect(h.toasts.savedToast).toHaveBeenCalledTimes(1)
    expect(h.savers.prism.status(DID, SUBJECT)?.idle).toBe(true)
  })
})

describe('T7-11: FU-3, the put', () => {
  it('a 503 Reindexing turns the toggle back with the prism toast, sets catching-up and leaves the account a member', async () => {
    writeLocal(
      membershipStorageKey(DID),
      JSON.stringify({v: 2, state: 'member', features: ['private']}),
    )
    resetMembership()
    try {
      seedList()
      h.prism.state.putReply = {
        status: 503,
        body: {error: 'Reindexing', message: 'Reindexing', retryAfter: 30},
      }
      press({priv: ON})
      await settle()
      expect(cachedPrivate()).toEqual(OFF)
      expect(h.toasts.privateFailedToast).toHaveBeenCalledWith(
        'subject.test',
        false,
      )
      expect(getPrismHealth(DID).causes.has('catching-up')).toBe(true)
      expect(getMembership(DID)).toBe('member')
    } finally {
      writeLocal(membershipStorageKey(DID), undefined)
      resetMembership()
    }
  })
})

describe('T7-10: nothing is stored on the device', () => {
  it('a press makes no localStorage write', async () => {
    const setItem = jest.fn()
    const g = globalThis as {localStorage?: unknown}
    const saved = g.localStorage
    g.localStorage = {setItem, getItem: () => null, removeItem: setItem}
    try {
      pressPublic(ON)
      await settle()
      expect(setItem).not.toHaveBeenCalled()
    } finally {
      g.localStorage = saved
    }
  })
})
