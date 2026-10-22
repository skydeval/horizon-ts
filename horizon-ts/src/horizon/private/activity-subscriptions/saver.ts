/*
 * The saver (activity subscriptions design 2.1, AS-1): the bell's save to
 * Bluesky, in memory, per tab and per (account, subject). The dialog closes
 * at press and the bell shows the press; the saver then puts it to Bluesky
 * with the clients captured at press, one put in flight at a time, so only
 * the latest press follows the current put.
 *
 * - Accepted, and still the latest: the stock success toast, and the
 *   accepted flags go to the mirror.
 * - Refused (an answered error), and still the latest: the bell goes back to
 *   what Bluesky last accepted, the F-4 toast, and the mirror levels.
 * - No answer within 15 s, or a transport error at once: one `getProfile`
 *   read sets the bell to Bluesky's value; a read equal to the press counts
 *   as accepted, otherwise the F-4 toast and the mirror waits G after that
 *   put. A late answer to it changes nothing.
 *
 * A superseded answer shows nothing. A read never overwrites a newer press:
 * every read writes the bell only if `presses` has not moved since it began.
 * Nothing resumes after a reload; only the dirty mark survives (2.2).
 */

import {type Client} from '@atproto/lex'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {
  putBlueskySubscription,
  readBlueskyBell,
  wasAnswered,
} from '#/horizon/private/activity-subscriptions/api'
import {
  type Flags,
  pairKey,
  PUT_TIMEOUT_MS,
  sameFlags,
} from '#/horizon/private/activity-subscriptions/common'
import type * as bsky from '#/types/bsky'

/** The bell's visible side: the shadow, the cached list and the toasts. */
export type BellUi = {
  /** Set the profile shadow and the cached list to `flags`. */
  setBell: (
    queryClient: QueryClient | undefined,
    subject: string,
    flags: Flags,
    profile?: bsky.profile.AnyProfileView,
  ) => void
  /** The stock success toast; `before` is what the bell showed at press. */
  savedToast: (handle: string, flags: Flags, before: Flags) => void
  /** "Couldn't save notification settings for @handle" (F-4). */
  failedToast: (handle: string) => void
  /** The mirror's once-per-press toast while prism is not reached (2.2). */
  mirrorPendingToast: (flags: Flags) => void
}

/** What a press captures (AS1-N5): nothing later reads the current account. */
export type PressContext = {
  did: string
  subject: string
  handle: string
  profile?: bsky.profile.AnyProfileView
  appview: Client
  queryClient?: QueryClient
  /** What the bell showed before the press: the dialog's initial state. */
  before: Flags
}

/** How the mirror is told of an answer it should act on. */
export type HandoffKind = 'accepted' | 'confirmed' | 'refused'

export type SaverDeps = {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  ui: BellUi
  /** The mirror's hand-off (2.2). */
  handoff: (did: string, subject: string, kind: HandoffKind) => void
  /** Ask the mirror to look at the subject again at monotonic time `at`. */
  levelAt: (did: string, subject: string, at: number) => void
  /** G, for the wait after an unanswered put. */
  graceMs: number
}

type Put = {
  id: number
  flags: Flags
  sentAt: number
  timer: unknown
  settled: boolean
}

/** A put that went unanswered and was not confirmed by the 15 s read. */
type Unanswered = {sentAt: number; confirmed: boolean}

type Entry = {
  did: string
  subject: string
  handle: string
  profile?: bsky.profile.AnyProfileView
  appview: Client
  queryClient?: QueryClient
  /** What Bluesky last accepted in this run; at first the initial state. */
  acked: Flags
  /** When `acked` was accepted (or confirmed); `undefined` for the initial. */
  ackedAt: number | undefined
  /** The latest press. */
  wanted: Flags
  /** What the bell showed before the latest press, for the toast's wording. */
  before: Flags
  /** Raised at each press. */
  presses: number
  lastPressAt: number
  /** What the saver last set the bell to. */
  shown: Flags
  inFlight: Put | undefined
  /** `wanted` still has to be sent. */
  pending: boolean
  /** The 15 s read is running. */
  reading: boolean
  unanswered: Unanswered[]
}

/** What the mirror reads of a subject's saver. */
export type SaverStatus = {
  /** Nothing in flight, nothing waiting, no 15 s read. */
  idle: boolean
  handle: string
  acked: Flags
  ackedAt: number | undefined
  /** The latest press. */
  latest: Flags
  presses: number
  lastPressAt: number
  shown: Flags
  /** The latest send time of an unanswered, unconfirmed put. */
  unansweredSentAt: number | undefined
}

export type Saver = ReturnType<typeof createSaver>

export function createSaver(deps: SaverDeps) {
  const entries = new Map<string, Entry>()
  let nextId = 1

  function setShown(entry: Entry, flags: Flags) {
    entry.shown = flags
    deps.ui.setBell(entry.queryClient, entry.subject, flags, entry.profile)
  }

  function isLatest(entry: Entry, put: Put) {
    return sameFlags(entry.wanted, put.flags)
  }

  function pump(entry: Entry) {
    if (entry.inFlight || !entry.pending) return
    entry.pending = false
    send(entry, entry.wanted)
  }

  function send(entry: Entry, flags: Flags) {
    const put: Put = {
      id: nextId++,
      flags,
      sentAt: deps.now(),
      timer: undefined,
      settled: false,
    }
    entry.inFlight = put
    put.timer = deps.setTimeout(() => unanswered(entry, put), PUT_TIMEOUT_MS)
    putBlueskySubscription(entry.appview, entry.subject, flags).then(
      () => accepted(entry, put),
      error => {
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

  function accepted(entry: Entry, put: Put) {
    if (!settle(entry, put)) return
    entry.acked = put.flags
    entry.ackedAt = deps.now()
    if (isLatest(entry, put)) {
      entry.pending = false
      deps.ui.savedToast(entry.handle, put.flags, entry.before)
      deps.handoff(entry.did, entry.subject, 'accepted')
    } else {
      pump(entry)
    }
  }

  function refused(entry: Entry, put: Put, error: unknown) {
    if (!settle(entry, put)) return
    logger.error('Could not save activity subscription', {message: error})
    if (isLatest(entry, put)) {
      entry.pending = false
      setShown(entry, entry.acked)
      deps.ui.failedToast(entry.handle)
      deps.handoff(entry.did, entry.subject, 'refused')
    } else {
      pump(entry)
    }
  }

  function unanswered(entry: Entry, put: Put) {
    if (!settle(entry, put)) return
    const record: Unanswered = {sentAt: put.sentAt, confirmed: false}
    entry.unanswered.push(record)
    const levelAt = put.sentAt + deps.graceMs
    if (!isLatest(entry, put)) {
      // A waiting newer press is sent now.
      deps.levelAt(entry.did, entry.subject, levelAt)
      pump(entry)
      return
    }
    entry.pending = false
    entry.reading = true
    const presses = entry.presses
    readBlueskyBell(entry.appview, entry.subject).then(
      bell => {
        entry.reading = false
        if (entry.presses !== presses) {
          // A newer press came during the read: it stands.
          deps.levelAt(entry.did, entry.subject, levelAt)
          pump(entry)
          return
        }
        setShown(entry, bell.flags)
        if (sameFlags(bell.flags, put.flags)) {
          // Bluesky holds the press; the late put can only write the same.
          record.confirmed = true
          entry.acked = put.flags
          entry.ackedAt = deps.now()
          deps.handoff(entry.did, entry.subject, 'confirmed')
        } else {
          deps.ui.failedToast(entry.handle)
          deps.levelAt(entry.did, entry.subject, levelAt)
        }
        pump(entry)
      },
      () => {
        entry.reading = false
        if (entry.presses === presses) {
          setShown(entry, entry.acked)
          deps.ui.failedToast(entry.handle)
        }
        deps.levelAt(entry.did, entry.subject, levelAt)
        pump(entry)
      },
    )
  }

  return {
    /**
     * A press of Save, after the dialog closed and the bell shows `flags`.
     * The caller has marked the subject dirty (2.2) and written the bell.
     */
    press(ctx: PressContext, flags: Flags) {
      const key = pairKey(ctx.did, ctx.subject)
      let entry = entries.get(key)
      if (!entry) {
        entry = {
          did: ctx.did,
          subject: ctx.subject,
          handle: ctx.handle,
          profile: ctx.profile,
          appview: ctx.appview,
          queryClient: ctx.queryClient,
          acked: ctx.before,
          ackedAt: undefined,
          wanted: flags,
          before: ctx.before,
          presses: 0,
          lastPressAt: 0,
          shown: flags,
          inFlight: undefined,
          pending: false,
          reading: false,
          unanswered: [],
        }
        entries.set(key, entry)
      }
      // The latest press's account clients and profile are used from here.
      entry.handle = ctx.handle
      entry.profile = ctx.profile ?? entry.profile
      entry.appview = ctx.appview
      entry.queryClient = ctx.queryClient
      entry.wanted = flags
      entry.before = ctx.before
      entry.presses += 1
      entry.lastPressAt = deps.now()
      entry.shown = flags
      entry.pending = true
      pump(entry)
    },

    /**
     * A press of Save with `OPTIMISTIC_ACTIVITY_SUBSCRIPTIONS` off: the stock
     * dialog puts and waits itself, and reports its answer with
     * `stockAnswered`. Until then the subject counts as in flight.
     */
    stockPress(ctx: PressContext, flags: Flags) {
      const key = pairKey(ctx.did, ctx.subject)
      const entry: Entry = entries.get(key) ?? {
        did: ctx.did,
        subject: ctx.subject,
        handle: ctx.handle,
        profile: ctx.profile,
        appview: ctx.appview,
        queryClient: ctx.queryClient,
        acked: ctx.before,
        ackedAt: undefined,
        wanted: flags,
        before: ctx.before,
        presses: 0,
        lastPressAt: 0,
        shown: ctx.before,
        inFlight: undefined,
        pending: false,
        reading: false,
        unanswered: [],
      }
      entries.set(key, entry)
      entry.wanted = flags
      entry.before = ctx.before
      entry.presses += 1
      entry.lastPressAt = deps.now()
      entry.inFlight = {
        id: nextId++,
        flags,
        sentAt: deps.now(),
        timer: undefined,
        settled: false,
      }
    },

    /**
     * The stock dialog's answer: accepted flags go to the mirror (rule a), a
     * failure has the mirror level from Bluesky.
     */
    stockAnswered(did: string, subject: string, flags: Flags, ok: boolean) {
      const entry = entries.get(pairKey(did, subject))
      if (!entry) return
      entry.inFlight = undefined
      if (ok) {
        entry.acked = flags
        entry.ackedAt = deps.now()
        entry.shown = flags
        deps.handoff(did, subject, 'accepted')
      } else {
        deps.handoff(did, subject, 'refused')
      }
    },

    /** The subject's saver as the mirror reads it; `undefined`: no press. */
    status(did: string, subject: string): SaverStatus | undefined {
      const entry = entries.get(pairKey(did, subject))
      if (!entry) return undefined
      let unansweredSentAt: number | undefined
      for (const put of entry.unanswered) {
        if (put.confirmed) continue
        unansweredSentAt = Math.max(unansweredSentAt ?? put.sentAt, put.sentAt)
      }
      return {
        idle: !entry.inFlight && !entry.pending && !entry.reading,
        handle: entry.handle,
        acked: entry.acked,
        ackedAt: entry.ackedAt,
        latest: entry.wanted,
        presses: entry.presses,
        lastPressAt: entry.lastPressAt,
        shown: entry.shown,
        unansweredSentAt,
      }
    },

    /** Presses so far for the subject (0 without a saver). */
    presses(did: string, subject: string): number {
      return entries.get(pairKey(did, subject))?.presses ?? 0
    },

    /**
     * A levelling read's value for the bell: written only when no press came
     * since the read began (`presses`). Returns whether it was written.
     */
    showRead(
      did: string,
      subject: string,
      presses: number,
      flags: Flags,
      queryClient: QueryClient | undefined,
    ): boolean {
      const entry = entries.get(pairKey(did, subject))
      if ((entry?.presses ?? 0) !== presses) return false
      if (entry) setShown(entry, flags)
      else deps.ui.setBell(queryClient, subject, flags)
      return true
    },

    /** Forget everything (tests). */
    reset() {
      for (const entry of entries.values()) {
        if (entry.inFlight) deps.clearTimeout(entry.inFlight.timer)
      }
      entries.clear()
    },
  }
}
