/*
 * The savers (activity subscriptions design 2.3): the bell dialog's
 * optimistic save, one saver per store, in memory, per tab and per
 * (account, subject). The dialog closes at Save and each changed pair's cache
 * shows the press; its store's saver then puts it with the clients captured
 * at press, one put in flight at a time, so only the latest press follows the
 * current put. "The latest" is the press counter, whatever the flags.
 *
 * - Accepted, and the latest: `accepted`; `acked` is the accepted flags.
 * - Refused (an answered error), and the latest: the cache goes back to
 *   `acked`, `refused`.
 * - No answer within 15 s, or a transport error: one truth read. Equal to the
 *   press is `confirmed`, anything else `refused`, and the cache takes it; a
 *   failed read goes back to `acked`, `refused`. A late answer changes
 *   nothing.
 * - Superseded: a put or a truth read whose press is no longer the latest
 *   reports `superseded` to its group and to every group of a press made
 *   after it but before the newest, and writes nothing.
 *
 * Every outcome goes to the press's `PressGroup`, which speaks once for the
 * press across both stores. At a press that finds the saver idle, `acked` is
 * the `truth` the caller read from the store's cache before writing the
 * press. Nothing is stored on the device and nothing resumes after a reload.
 */

import {type Client} from '@atproto/lex'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {
  classifyPrismError,
  failureName,
  putBlueskySubscription,
  putPrismSubscription,
  readBlueskyBell,
  wasAnswered,
} from '#/horizon/private/activity-subscriptions/api'
import {
  type Flags,
  OFF,
  pairKey,
  PUT_TIMEOUT_MS,
  sameFlags,
} from '#/horizon/private/activity-subscriptions/common'
import {
  privateActivitySubscriptionsKey,
  readAllPrismSubscriptions,
  readCachedPrivateFlags,
  setPrivateFlags,
} from '#/horizon/private/activity-subscriptions/private-state'
import {
  bellUi,
  readBellTruth,
  setBell,
} from '#/horizon/private/activity-subscriptions/ui'
import type * as bsky from '#/types/bsky'

/** The two stores (D-2). */
export type StoreName = 'bluesky' | 'prism'

/** How a store's part of a press ended. */
export type Outcome = 'accepted' | 'confirmed' | 'refused' | 'superseded'

/** What a press captures: nothing later reads the current account (F7-7). */
export type PressContext = {
  did: string
  subject: string
  handle: string
  profile?: bsky.profile.AnyProfileView
  appview: Client
  /** The account's prism client; only a private press needs it. */
  prism?: Client
  queryClient?: QueryClient
}

/** One store: its put, its truth read and its cache. */
export type Store = {
  name: StoreName
  /** Put `flags`; resolves with the flags the store accepted. */
  put: (ctx: PressContext, flags: Flags) => Promise<Flags>
  /** The truth read: the subject's flags as the store holds them now. */
  read: (ctx: PressContext) => Promise<Flags>
  /** Write the subject's flags to the store's cache. */
  write: (ctx: PressContext, flags: Flags) => void
  /** The subject's cached truth, without any pending press (`truth`). */
  cached: (ctx: PressContext) => Flags
  /** Write an accepted put's flags too (prism's returned flags). */
  writesAccepted: boolean
  /** Whether a refusal is the store's limit (prism's `LimitReached`). */
  isLimit: (error: unknown) => boolean
}

/** The toasts a press can end with (2.3, "The per-press join"). */
export type ActivityToasts = {
  /** The stock success toast, worded from all four flags. */
  savedToast: (handle: string, after: Flags, before: Flags) => void
  /** Bluesky's refusal. */
  failedToast: (handle: string) => void
  /** prism's refusal; `limit` for `LimitReached`. */
  privateFailedToast: (handle: string, limit: boolean) => void
  /** Both refused; `limit` when prism's refusal is `LimitReached`. */
  combinedFailedToast: (handle: string, limit: boolean) => void
}

/** Both pairs as the dialog showed them. */
export type FourFlags = {public: Flags; private: Flags}

/** The per-press join across the two savers. */
export type PressGroup = {
  report: (store: StoreName, outcome: Outcome, limit?: boolean) => void
}

/**
 * The join for one press of Save. `sent` are the pairs that changed; it
 * speaks once, after each has reported:
 * - each `accepted` or `confirmed`: the success toast;
 * - any `refused`: that store's toast, or one combined toast for both;
 * - otherwise (some `superseded`): nothing, the newer press speaks.
 */
export function createPressGroup(
  toasts: ActivityToasts,
  {
    handle,
    sent,
    before,
    after,
  }: {handle: string; sent: StoreName[]; before: FourFlags; after: FourFlags},
): PressGroup {
  const outcomes = new Map<StoreName, {outcome: Outcome; limit: boolean}>()
  let spoken = sent.length === 0
  const union = (flags: FourFlags): Flags => ({
    post: flags.public.post || flags.private.post,
    reply: flags.public.reply || flags.private.reply,
  })
  const speak = () => {
    spoken = true
    const refused = sent.filter(
      store => outcomes.get(store)?.outcome === 'refused',
    )
    const limit = outcomes.get('prism')?.limit ?? false
    if (refused.length > 1) {
      toasts.combinedFailedToast(handle, limit)
    } else if (refused[0] === 'bluesky') {
      toasts.failedToast(handle)
    } else if (refused[0] === 'prism') {
      toasts.privateFailedToast(handle, limit)
    } else if (
      sent.every(store => {
        const outcome = outcomes.get(store)?.outcome
        return outcome === 'accepted' || outcome === 'confirmed'
      })
    ) {
      toasts.savedToast(handle, union(after), union(before))
    }
  }
  return {
    report(store, outcome, limit = false) {
      if (spoken || !sent.includes(store) || outcomes.has(store)) return
      outcomes.set(store, {outcome, limit})
      if (sent.every(name => outcomes.has(name))) speak()
    },
  }
}

export type SaverDeps = {
  store: Store
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

type Put = {
  /** The press counter when it was sent. */
  press: number
  flags: Flags
  timer: unknown
  settled: boolean
}

type Entry = {
  ctx: PressContext
  /** What the store last accepted, or the cached truth at an idle press. */
  acked: Flags
  /** The latest press; the same object until the next press. */
  wanted: Flags
  /** Raised at each press. */
  presses: number
  /** The presses not reported yet, oldest first. */
  groups: {press: number; group: PressGroup}[]
  inFlight: Put | undefined
  /** `wanted` still has to be sent. */
  pending: boolean
  /** A truth read is running. */
  reading: boolean
}

export type Saver = ReturnType<typeof createSaver>

export function createSaver(deps: SaverDeps) {
  const {store} = deps
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of Array.from(listeners)) listener()
  }

  const isIdle = (entry: Entry) =>
    !entry.inFlight && !entry.pending && !entry.reading

  /** `superseded` to every group of a press before `press`. */
  function supersede(entry: Entry, press: number) {
    while (entry.groups.length > 0 && entry.groups[0].press < press) {
      entry.groups.shift()?.group.report(store.name, 'superseded')
    }
  }

  /** The latest press's outcome, after superseding any older group. */
  function finish(
    entry: Entry,
    press: number,
    outcome: Outcome,
    limit?: boolean,
  ) {
    supersede(entry, press)
    if (entry.groups[0]?.press === press) {
      entry.groups.shift()?.group.report(store.name, outcome, limit)
    }
  }

  function pump(entry: Entry) {
    if (entry.inFlight || !entry.pending) return
    entry.pending = false
    const put: Put = {
      press: entry.presses,
      flags: entry.wanted,
      timer: undefined,
      settled: false,
    }
    entry.inFlight = put
    put.timer = deps.setTimeout(() => unanswered(entry, put), PUT_TIMEOUT_MS)
    store.put(entry.ctx, put.flags).then(
      flags => accepted(entry, put, flags),
      (error: unknown) => {
        if (wasAnswered(error)) refused(entry, put, error)
        else unanswered(entry, put)
      },
    )
  }

  function settle(entry: Entry, put: Put): boolean {
    if (put.settled) return false
    put.settled = true
    deps.clearTimeout(put.timer)
    if (entry.inFlight === put) entry.inFlight = undefined
    return true
  }

  const isLatest = (entry: Entry, press: number) => entry.presses === press

  /** A put or read that is not the latest: the newer press stands. */
  function overtaken(entry: Entry) {
    supersede(entry, entry.presses)
    pump(entry)
    notify()
  }

  function accepted(entry: Entry, put: Put, flags: Flags) {
    if (!settle(entry, put)) return
    entry.acked = flags
    if (!isLatest(entry, put.press)) return overtaken(entry)
    if (store.writesAccepted) store.write(entry.ctx, flags)
    finish(entry, put.press, 'accepted')
    notify()
  }

  function refused(entry: Entry, put: Put, error: unknown) {
    if (!settle(entry, put)) return
    logger.error('Could not save activity subscription', {
      safeMessage: `${store.name}: ${failureName(error)}`,
    })
    if (!isLatest(entry, put.press)) return overtaken(entry)
    store.write(entry.ctx, entry.acked)
    finish(entry, put.press, 'refused', store.isLimit(error))
    notify()
  }

  function unanswered(entry: Entry, put: Put) {
    if (!settle(entry, put)) return
    if (!isLatest(entry, put.press)) return overtaken(entry)
    entry.reading = true
    const press = put.press
    store.read(entry.ctx).then(
      flags => {
        entry.reading = false
        if (!isLatest(entry, press)) return overtaken(entry)
        // The cache takes the store's value; the late put changes nothing.
        entry.acked = flags
        store.write(entry.ctx, flags)
        finish(entry, press, sameFlags(flags, put.flags) ? 'confirmed' : 'refused')
        notify()
      },
      () => {
        entry.reading = false
        if (!isLatest(entry, press)) return overtaken(entry)
        store.write(entry.ctx, entry.acked)
        finish(entry, press, 'refused')
        notify()
      },
    )
  }

  return {
    store: store.name,

    /** The store's cached truth for the subject (2.3, `truth`). */
    cached: (ctx: PressContext) => store.cached(ctx),

    /** Write the subject's flags to the store's cache. */
    write: (ctx: PressContext, flags: Flags) => store.write(ctx, flags),

    /**
     * A press of Save, inside the dialog's close callback, after the caller
     * has read `truth` (the store's cached value for the subject) and then
     * written `flags` to the cache. An idle saver takes `truth` as `acked`;
     * one with a put, a waiting press or a truth read keeps its own.
     */
    press(ctx: PressContext, flags: Flags, truth: Flags, group: PressGroup) {
      const key = pairKey(ctx.did, ctx.subject)
      let entry = entries.get(key)
      if (!entry) {
        entry = {
          ctx,
          acked: truth,
          wanted: flags,
          presses: 0,
          groups: [],
          inFlight: undefined,
          pending: false,
          reading: false,
        }
        entries.set(key, entry)
      } else if (isIdle(entry)) {
        entry.acked = truth
      }
      // The latest press's clients and profile are used from here.
      entry.ctx = ctx
      entry.wanted = flags
      entry.presses += 1
      entry.groups.push({press: entry.presses, group})
      entry.pending = true
      pump(entry)
      notify()
    },

    /**
     * The subject's pending press while the saver is not idle, else
     * `undefined`. The same object on every call until it changes, so it can
     * be a `useSyncExternalStore` snapshot.
     */
    pending(did: string, subject: string): Flags | undefined {
      const entry = entries.get(pairKey(did, subject))
      return entry && !isIdle(entry) ? entry.wanted : undefined
    },

    /** Called on every press, settle and truth-read end. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /** What the saver holds for a subject (tests). */
    status(did: string, subject: string) {
      const entry = entries.get(pairKey(did, subject))
      if (!entry) return undefined
      return {
        idle: isIdle(entry),
        acked: entry.acked,
        wanted: entry.wanted,
        presses: entry.presses,
      }
    },

    /** Forget everything (tests). */
    reset() {
      for (const entry of entries.values()) {
        if (entry.inFlight) deps.clearTimeout(entry.inFlight.timer)
      }
      entries.clear()
      listeners.clear()
    },
  }
}

/** Bluesky's store: the public pair (`ui.ts` `setBell`, unchanged). */
export const blueskyStore: Store = {
  name: 'bluesky',
  put: async (ctx, flags) => {
    await putBlueskySubscription(ctx.appview, ctx.subject, flags)
    return flags
  },
  read: async ctx => (await readBlueskyBell(ctx.appview, ctx.subject)).flags,
  write: (ctx, flags) =>
    setBell(ctx.queryClient, ctx.subject, flags, ctx.profile),
  cached: ctx => readBellTruth(ctx.queryClient, ctx.subject, ctx.profile),
  writesAccepted: false,
  isLimit: () => false,
}

/**
 * prism's store: the private pair, through the busy wrappers. The truth read
 * is a direct read of the whole list outside the query, with
 * `{shared: false}`, so it is fresh: it starts after the put's outcome and
 * never takes a throttled lead's body (2.3). Its cache is 2.2's list, for
 * the subject only; an accepted put's returned flags are written too.
 */
export const prismStore: Store = {
  name: 'prism',
  put: (ctx, flags) =>
    ctx.prism
      ? putPrismSubscription(ctx.prism, ctx.subject, flags)
      : Promise.reject(new Error('No prism client')),
  read: async ctx => {
    if (!ctx.prism) throw new Error('No prism client')
    const map = await readAllPrismSubscriptions(ctx.prism, {shared: false})
    return map[ctx.subject] ?? OFF
  },
  write: (ctx, flags) =>
    setPrivateFlags(ctx.queryClient, ctx.did, ctx.subject, flags),
  cached: ctx => readCachedPrivateFlags(ctx.queryClient, ctx.did, ctx.subject),
  writesAccepted: true,
  isLimit: error => classifyPrismError(error) === 'limit',
}

export type ActivitySavers = {
  bluesky: Saver
  prism: Saver
  toasts: ActivityToasts
}

export type ActivitySaversDeps = {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  toasts: ActivityToasts
  bluesky: Store
  prism: Store
}

/** The savers over the production stores; tests replace any dependency. */
export function createActivitySavers(
  overrides: Partial<ActivitySaversDeps> = {},
): ActivitySavers {
  const deps: ActivitySaversDeps = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    toasts: bellUi,
    bluesky: blueskyStore,
    prism: prismStore,
    ...overrides,
  }
  const timers = {setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout}
  return {
    bluesky: createSaver({store: deps.bluesky, ...timers}),
    prism: createSaver({store: deps.prism, ...timers}),
    toasts: deps.toasts,
  }
}

/**
 * One press of Save, run inside the dialog's close callback (2.3, steps 2 to
 * 4): only if the private pair is sent, cancel the list's fetches (a cancel
 * reverts synchronously, so the writes below stand); then for each pair that
 * changed, read the store's cached truth for the subject, write the press to
 * the cache, and hand it to the store's saver, all in one synchronous run,
 * with one `PressGroup` for the press. A list left with no data (a first
 * load cancelled) is invalidated, so a mounted observer reads it again.
 * Returns the pairs sent.
 */
export function savePress(
  activity: ActivitySavers,
  {ctx, before, after}: {ctx: PressContext; before: FourFlags; after: FourFlags},
): StoreName[] {
  const sent: StoreName[] = []
  if (!sameFlags(before.public, after.public)) sent.push('bluesky')
  if (ctx.prism && !sameFlags(before.private, after.private)) {
    sent.push('prism')
  }
  if (sent.length === 0) return sent
  const listKey = privateActivitySubscriptionsKey(ctx.did)
  if (sent.includes('prism')) {
    void ctx.queryClient?.cancelQueries({queryKey: listKey})
  }
  const group = createPressGroup(activity.toasts, {
    handle: ctx.handle,
    sent,
    before,
    after,
  })
  const hand = (saver: Saver, flags: Flags) => {
    // Read before the write, so an idle saver's `acked` is not the press.
    const truth = saver.cached(ctx)
    saver.write(ctx, flags)
    saver.press(ctx, flags, truth, group)
  }
  if (sent.includes('bluesky')) hand(activity.bluesky, after.public)
  if (sent.includes('prism')) {
    hand(activity.prism, after.private)
    if (ctx.queryClient && ctx.queryClient.getQueryData(listKey) === undefined) {
      void ctx.queryClient.invalidateQueries({queryKey: listKey})
    }
  }
  return sent
}

let savers: ActivitySavers | undefined

/** This tab's savers, made on first use. */
export function getActivitySavers(): ActivitySavers {
  if (!savers) savers = createActivitySavers()
  return savers
}
