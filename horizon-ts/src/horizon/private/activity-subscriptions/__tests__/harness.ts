/*
 * Test harness for activity subscriptions: a virtual monotonic clock with
 * its own timers, a dirty store shared by any number of "tabs", and fake
 * Bluesky and prism servers over the lex client.
 */

import {jest} from '@jest/globals'

import {resetPrismHealth} from '#/horizon/routing/health'
import {type Call, fakeClient, type Reply} from '../../__tests__/fixtures'
import {
  dirtyKey,
  type Flags,
  OFF,
  parseDirtyKey,
} from '../common'
import {type DirtyStore} from '../mirror'
import {type BellUi} from '../saver'
import {type ActivityTab, createActivityTab} from '../tab'

export const DID = 'did:plc:memberaaaaaaaaaaaaaaaaaaa'
export const OTHER_ACCOUNT = 'did:plc:secondbbbbbbbbbbbbbbbbbbb'
export const SUBJECT = 'did:plc:subjectccccccccccccccccc'
export const SUBJECT_2 = 'did:plc:subjectdddddddddddddddddd'

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
    wallNow: () => Date.parse('2026-10-22T12:00:00.000Z') + (now - start),
    setTimeout: (callback: () => void, ms: number): unknown => {
      const id = ++seq
      timers.set(id, {at: now + ms, callback})
      return id
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number)
    },
    setInterval: (callback: () => void, ms: number): unknown => {
      const id = ++seq
      const run = () => {
        timers.set(id, {at: now + ms, callback: run})
        callback()
      }
      timers.set(id, {at: now + ms, callback: run})
      return id
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

/**
 * A dirty store several tabs share, as `localStorage` is: each write is
 * heard by every subscriber.
 */
export function sharedStore() {
  const values = new Map<string, string>()
  const reconciled = new Map<string, number>()
  const listeners = new Set<(did: string, subject: string) => void>()
  const notify = (did: string, subject: string) => {
    listeners.forEach(listener => listener(did, subject))
  }
  const store: DirtyStore = {
    readToken: (did, subject) => values.get(dirtyKey(did, subject)),
    writeToken: (did, subject, token) => {
      values.set(dirtyKey(did, subject), token)
      notify(did, subject)
    },
    removeToken: (did, subject) => {
      values.delete(dirtyKey(did, subject))
      notify(did, subject)
    },
    listSubjects: did =>
      Array.from(values.keys()).flatMap(key => {
        const parsed = parseDirtyKey(key)
        return parsed && parsed.did === did ? [parsed.subject] : []
      }),
    subscribeDirty: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    readReconciled: did => reconciled.get(did),
    writeReconciled: (did, at) => {
      reconciled.set(did, at)
    },
    clearReconciled: did => {
      reconciled.delete(did)
    },
  }
  return {store, values, reconciled}
}

export function fakeUi() {
  return {
    setBell: jest.fn<BellUi['setBell']>(),
    savedToast: jest.fn<BellUi['savedToast']>(),
    failedToast: jest.fn<BellUi['failedToast']>(),
    mirrorPendingToast: jest.fn<BellUi['mirrorPendingToast']>(),
  }
}

export type Pending = {
  resolve: (reply: Reply) => void
}

/**
 * Bluesky as the fake AppView keeps it: the bell per subject, which a put
 * changes. `putReply` answers a put instead (a refusal, a network failure,
 * or `'hang'` to hold it until the test answers it).
 */
export function fakeBluesky(did = DID) {
  const bells = new Map<string, Flags>()
  const blocked = new Set<string>()
  const held: {call: Call; resolve: (reply: Reply) => void}[] = []
  const state = {
    putReply: undefined as Reply | 'hang' | undefined,
    profileReply: undefined as Reply | 'hang' | undefined,
    /** What a profile read shows instead of the bell (read-back lag). */
    lagged: new Map<string, Flags | undefined>(),
    listPages: undefined as Reply[] | undefined,
  }
  const profile = (subject: string) => {
    const bell = state.lagged.has(subject)
      ? state.lagged.get(subject)
      : bells.get(subject)
    return {
      did: subject,
      handle: 'subject.test',
      viewer: {
        ...(bell && (bell.post || bell.reply)
          ? {activitySubscription: bell}
          : {}),
        ...(blocked.has(subject)
          ? {blocking: `at://${did}/app.bsky.graph.block/3kblock222222`}
          : {}),
      },
    }
  }
  const {client, calls} = fakeClient(did, call => {
    if (call.nsid === 'app.bsky.notification.putActivitySubscription') {
      const body = call.body as {
        subject: string
        activitySubscription: Flags
      }
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
          held.push({call, resolve: () => resolve(ok(profile(subject)))}),
        )
      }
      if (reply) return reply
      return ok(profile(subject))
    }
    if (call.nsid === 'app.bsky.notification.listActivitySubscriptions') {
      if (state.listPages) {
        const index = Number(call.params.get('cursor') ?? '0')
        return state.listPages[index] ?? ok({subscriptions: []})
      }
      return ok({
        subscriptions: Array.from(bells.entries())
          .filter(([, flags]) => flags.post || flags.reply)
          .map(([subject]) => profile(subject)),
      })
    }
    return {status: 404, body: {error: 'NotFound'}}
  })
  return {client, calls, bells, blocked, held, state}
}

/** prism as the fake keeps it: one row per subject, stamped on each put. */
export function fakePrism(did = DID) {
  const rows = new Map<string, {flags: Flags; updatedAt: string}>()
  const state = {
    putReply: undefined as Reply | ((call: Call) => Reply | undefined) | undefined,
    listReply: undefined as Reply | undefined,
    asOf: '2026-10-22T12:00:00.000Z',
    /** The time a put stamps. */
    stamp: '2026-10-22T12:00:00.000Z',
  }
  const {client, calls} = fakeClient(did, call => {
    if (call.nsid === 'app.nearhorizon.private.putActivitySubscription') {
      const reply =
        typeof state.putReply === 'function'
          ? state.putReply(call)
          : state.putReply
      if (reply) return reply
      const body = call.body as {
        subject: string
        activitySubscription: Flags
        ifNotChangedSince?: string
      }
      const row = rows.get(body.subject)
      if (
        body.ifNotChangedSince &&
        row &&
        Date.parse(row.updatedAt) > Date.parse(body.ifNotChangedSince)
      ) {
        return {status: 409, body: {error: 'Conflict', message: 'changed'}}
      }
      rows.set(body.subject, {
        flags: body.activitySubscription,
        updatedAt: state.stamp,
      })
      return ok({subject: body.subject})
    }
    if (call.nsid === 'app.nearhorizon.private.listActivitySubscriptions') {
      if (state.listReply) return state.listReply
      return ok({
        asOf: state.asOf,
        subscriptions: Array.from(rows.entries())
          .filter(([, row]) => row.flags.post || row.flags.reply)
          .map(([subject, row]) => ({
            subject,
            activitySubscription: row.flags,
            updatedAt: row.updatedAt,
          })),
      })
    }
    return {status: 404, body: {error: 'NotFound'}}
  })
  const puts = () =>
    calls
      .filter(c => c.nsid === 'app.nearhorizon.private.putActivitySubscription')
      .map(c => c.body as Record<string, unknown>)
  return {client, calls, rows, state, puts}
}

export function ok(body: unknown): Reply {
  return {status: 200, body}
}

export function xrpcError(status: number, error: string): Reply {
  return {status, body: {error, message: error}}
}

export type Harness = ReturnType<typeof harness>

/**
 * One tab over `shared` (a new store by default), signed in as `did` with
 * the given servers.
 */
export function harness({
  clock = virtualClock(),
  shared = sharedStore(),
  bluesky = fakeBluesky(),
  prism = fakePrism(),
  did = DID,
}: {
  clock?: VirtualClock
  shared?: ReturnType<typeof sharedStore>
  bluesky?: ReturnType<typeof fakeBluesky>
  prism?: ReturnType<typeof fakePrism>
  did?: string
} = {}) {
  // prism's calls report to health (FU-3); each tab starts healthy.
  resetPrismHealth()
  const ui = fakeUi()
  const checks = new Set<() => void>()
  const env = {
    applies: 'yes' as 'yes' | 'no' | 'wait',
    current: did as string | undefined,
    enabled: true,
    expectsMirror: true,
    removals: false,
  }
  let tokens = 0
  const tab: ActivityTab = createActivityTab({
    store: shared.store,
    ui,
    now: clock.now,
    wallNow: clock.wallNow,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    newToken: () => `token-${Math.random().toString(36).slice(2)}-${++tokens}`,
    current: () =>
      env.current
        ? {
            did: env.current,
            prismClient: prism.client,
            appviewClient: bluesky.client,
          }
        : undefined,
    enabled: () => env.enabled,
    removals: () => env.removals,
    applies: () => env.applies,
    expectsMirror: () => env.expectsMirror,
    subscribeChecks: listener => {
      checks.add(listener)
      return () => {
        checks.delete(listener)
      }
    },
    reportError: () => {},
  })
  return {
    tab,
    clock,
    shared,
    bluesky,
    prism,
    ui,
    env,
    did,
    /** Membership or features answered. */
    answer() {
      checks.forEach(listener => listener())
    },
    /** A press of Save as the dialog makes it, after the close. */
    press(flags: Flags, {subject = SUBJECT, before}: {subject?: string; before?: Flags} = {}) {
      tab.mirror.markPressed(did, subject)
      tab.saver.press(
        {
          did,
          subject,
          handle: 'subject.test',
          appview: bluesky.client,
          before: before ?? tab.saver.status(did, subject)?.shown ?? OFF,
        },
        flags,
      )
    },
    token(subject = SUBJECT) {
      return shared.store.readToken(did, subject)
    },
    profileReads() {
      return bluesky.calls.filter(c => c.nsid === 'app.bsky.actor.getProfile')
        .length
    },
    blueskyPuts() {
      return bluesky.calls
        .filter(c => c.nsid === 'app.bsky.notification.putActivitySubscription')
        .map(c => (c.body as {activitySubscription: Flags}).activitySubscription)
    },
  }
}

export const ON: Flags = {post: true, reply: false}
export const BOTH: Flags = {post: true, reply: true}
