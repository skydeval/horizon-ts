/*
 * Test harness for activity subscriptions: a virtual clock with its own
 * timers, fake Bluesky and prism servers over the lex client, and the savers
 * over them with fake toasts.
 */

import {jest} from '@jest/globals'
import {QueryClient} from '@tanstack/react-query'

import {resetPrismHealth} from '#/horizon/routing/health'
import {type Call, fakeClient, type Reply} from '../../__tests__/fixtures'
import {type Flags} from '../common'
import {type ActivityToasts, createActivitySavers} from '../saver'

export const DID = 'did:plc:memberaaaaaaaaaaaaaaaaaaa'
export const OTHER_ACCOUNT = 'did:plc:secondbbbbbbbbbbbbbbbbbbb'
export const SUBJECT = 'did:plc:subjectccccccccccccccccc'
export const SUBJECT_2 = 'did:plc:subjectdddddddddddddddddd'

export const ON: Flags = {post: true, reply: false}
export const BOTH: Flags = {post: true, reply: true}

const tick =
  typeof setImmediate === 'function'
    ? () => new Promise<void>(resolve => setImmediate(resolve))
    : () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** Let pending requests and promise chains run. */
export async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i++) await tick()
}

export type VirtualClock = ReturnType<typeof virtualClock>

/** A clock that moves only when told, with its own timers. */
export function virtualClock(start = 1_000_000) {
  let now = start
  let seq = 0
  const timers = new Map<number, {at: number; callback: () => void}>()
  return {
    now: () => now,
    setTimeout: (callback: () => void, ms: number): unknown => {
      const id = ++seq
      timers.set(id, {at: now + ms, callback})
      return id
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number)
    },
    /** Move forward `ms`, running each timer as it comes due. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        await settle()
        let next: [number, {at: number; callback: () => void}] | undefined
        for (const entry of timers) {
          if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) {
            next = entry
          }
        }
        if (!next) break
        now = Math.max(now, next[1].at)
        timers.delete(next[0])
        next[1].callback()
      }
      now = end
      await settle()
    },
    pending: () => timers.size,
  }
}

export function fakeToasts() {
  return {
    savedToast: jest.fn<ActivityToasts['savedToast']>(),
    failedToast: jest.fn<ActivityToasts['failedToast']>(),
    privateFailedToast: jest.fn<ActivityToasts['privateFailedToast']>(),
    combinedFailedToast: jest.fn<ActivityToasts['combinedFailedToast']>(),
  }
}

/** Every toast shown, in order, as `[name, ...args]`. */
export function toastsShown(toasts: ReturnType<typeof fakeToasts>) {
  const all: {order: number; call: unknown[]}[] = []
  for (const [name, fn] of Object.entries(toasts)) {
    fn.mock.calls.forEach((args, i) =>
      all.push({order: fn.mock.invocationCallOrder[i], call: [name, ...args]}),
    )
  }
  return all.sort((a, b) => a.order - b.order).map(entry => entry.call)
}

type Held = {call: Call; resolve: (reply: Reply) => void}

/**
 * Bluesky as the fake AppView keeps it: the bell per subject, which a put
 * changes. `putReply` answers a put instead (a refusal, a network failure,
 * or `'hang'` to hold it until the test answers it); `profileReply` likewise
 * for `getProfile`.
 */
export function fakeBluesky(did = DID) {
  const bells = new Map<string, Flags>()
  const held: Held[] = []
  const state = {
    putReply: undefined as Reply | 'hang' | undefined,
    profileReply: undefined as Reply | 'hang' | undefined,
  }
  const profile = (subject: string) => {
    const bell = bells.get(subject)
    return {
      did: subject,
      handle: 'subject.test',
      viewer:
        bell && (bell.post || bell.reply) ? {activitySubscription: bell} : {},
    }
  }
  const {client, calls} = fakeClient(did, call => {
    if (call.nsid === 'app.bsky.notification.putActivitySubscription') {
      const body = call.body as {subject: string; activitySubscription: Flags}
      const apply = () => bells.set(body.subject, body.activitySubscription)
      const answer = ok({
        subject: body.subject,
        activitySubscription: body.activitySubscription,
      })
      const reply = state.putReply
      if (reply === 'hang') {
        return new Promise<Reply>(resolve =>
          held.push({
            call,
            resolve: r => {
              const accepted = !(r instanceof Error) && r.status === 200
              if (accepted) apply()
              resolve(accepted ? answer : r)
            },
          }),
        )
      }
      if (reply) return reply
      apply()
      return answer
    }
    if (call.nsid === 'app.bsky.actor.getProfile') {
      const subject = call.params.get('actor') ?? ''
      const reply = state.profileReply
      if (reply === 'hang') {
        return new Promise<Reply>(resolve =>
          held.push({
            call,
            resolve: r =>
              resolve(
                !(r instanceof Error) && r.status === 200 ? ok(profile(subject)) : r,
              ),
          }),
        )
      }
      if (reply) return reply
      return ok(profile(subject))
    }
    return {status: 404, body: {error: 'NotFound'}}
  })
  const puts = () =>
    calls
      .filter(c => c.nsid === 'app.bsky.notification.putActivitySubscription')
      .map(c => (c.body as {activitySubscription: Flags}).activitySubscription)
  const reads = () =>
    calls.filter(c => c.nsid === 'app.bsky.actor.getProfile').length
  const heldOf = (nsid: string) => held.filter(h => h.call.nsid === nsid)
  return {client, calls, bells, held, heldOf, state, puts, reads}
}

/**
 * prism as the fake keeps it: one row per subject with a flag on. The put
 * answers with the accepted flags (none after an off); the list pages by
 * `limit` with a numeric cursor. `putReply` and `listReply` answer instead
 * (`'hang'` holds the call; a function decides per call).
 */
export function fakePrism(did = DID) {
  const rows = new Map<string, Flags>()
  const held: Held[] = []
  type Answer = Reply | 'hang' | undefined
  const state = {
    putReply: undefined as Answer | ((call: Call) => Answer),
    listReply: undefined as Answer | ((call: Call) => Answer),
  }
  const pick = (reply: Answer | ((call: Call) => Answer), call: Call) =>
    typeof reply === 'function' ? reply(call) : reply
  const list = (call: Call) => {
    const limit = Number(call.params.get('limit') ?? '50')
    const start = Number(call.params.get('cursor') ?? '0')
    const all = Array.from(rows.entries())
    const page = all.slice(start, start + limit)
    return ok({
      subscriptions: page.map(([subject, flags]) => ({
        subject,
        activitySubscription: flags,
      })),
      ...(start + limit < all.length ? {cursor: String(start + limit)} : {}),
    })
  }
  const {client, calls} = fakeClient(did, call => {
    if (call.nsid === 'app.nearhorizon.private.putActivitySubscription') {
      const body = call.body as {subject: string; activitySubscription: Flags}
      const apply = () => {
        const flags = body.activitySubscription
        if (flags.post || flags.reply) rows.set(body.subject, flags)
        else rows.delete(body.subject)
        const now = rows.get(body.subject)
        return ok({
          subject: body.subject,
          ...(now ? {activitySubscription: now} : {}),
        })
      }
      const reply = pick(state.putReply, call)
      if (reply === 'hang') {
        return new Promise<Reply>(resolve =>
          held.push({
            call,
            resolve: r =>
              resolve(!(r instanceof Error) && r.status === 200 ? apply() : r),
          }),
        )
      }
      if (reply) return reply
      return apply()
    }
    if (call.nsid === 'app.nearhorizon.private.listActivitySubscriptions') {
      const reply = pick(state.listReply, call)
      if (reply === 'hang') {
        /*
         * A plain 200 takes the page when the test answers, not when it was
         * asked; a 200 with a body answers that body (an old page).
         */
        return new Promise<Reply>(resolve =>
          held.push({
            call,
            resolve: r =>
              resolve(
                !(r instanceof Error) && r.status === 200 && r.body === undefined
                  ? list(call)
                  : r,
              ),
          }),
        )
      }
      if (reply) return reply
      return list(call)
    }
    return {status: 404, body: {error: 'NotFound'}}
  })
  const puts = () =>
    calls
      .filter(c => c.nsid === 'app.nearhorizon.private.putActivitySubscription')
      .map(c => c.body as Record<string, unknown>)
  const lists = () =>
    calls.filter(
      c => c.nsid === 'app.nearhorizon.private.listActivitySubscriptions',
    )
  const heldOf = (nsid: string) => held.filter(h => h.call.nsid === nsid)
  return {client, calls, rows, held, heldOf, state, puts, lists}
}

export function ok(body: unknown): Reply {
  return {status: 200, body}
}

export function xrpcError(status: number, error: string): Reply {
  return {status, body: {error, message: error}}
}

export type Harness = ReturnType<typeof harness>

/**
 * The savers on a virtual clock against fake servers, signed in as `did`,
 * with one query client (the account's cache) and fake toasts. prism's calls
 * report to health (FU-3), so health starts clean.
 */
export function harness({
  clock = virtualClock(),
  bluesky = fakeBluesky(),
  prism = fakePrism(),
  did = DID,
}: {
  clock?: VirtualClock
  bluesky?: ReturnType<typeof fakeBluesky>
  prism?: ReturnType<typeof fakePrism>
  did?: string
} = {}) {
  resetPrismHealth()
  const toasts = fakeToasts()
  const queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, structuralSharing: false}},
  })
  const savers = createActivitySavers({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    toasts,
  })
  const ctx = (subject = SUBJECT) => ({
    did,
    subject,
    handle: 'subject.test',
    appview: bluesky.client,
    prism: prism.client,
    queryClient,
  })
  return {savers, clock, bluesky, prism, toasts, queryClient, did, ctx}
}
