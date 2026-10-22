/*
 * The prism mirror (activity subscriptions design 2.2, AS-2): levels prism's
 * copy of each dirty subject to Bluesky, for the current account with its
 * clients, one levelling at a time per subject in a tab.
 *
 * The checks (`checks.ts`): known not to apply removes the key; not answered
 * yet keeps it and waits; a confirmed member with the feature for write
 * levels. For a subject whose saver is idle:
 * - (a) a put this tab's saver had accepted (or confirmed by the 15 s read)
 *   less than G ago, with every put answered or confirmed and the key still
 *   holding this tab's own token: put those flags, with no read;
 * - (b) a put that went unanswered less than G ago: wait until G has passed;
 * - (c) otherwise read Bluesky (`getProfile`) and put what it shows, not
 *   before mount + 20 s for a token present at mount, nor before G after
 *   first seeing a foreign token. A blocked profile is put off.
 *
 * A key is removed only if it still holds the token read when the levelling
 * began. Transient failures retry at 15 s, 1, 5, 15 and 60 min, once per
 * press, with one toast per press. A hand-off of an accepted press that finds
 * the key gone, with no foreign token seen since, writes a fresh token of its
 * own (AS5-N2).
 */

import {type Client} from '@atproto/lex'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {
  classifyPrismError,
  failureName,
  putPrismSubscription,
  readBlueskyBell,
} from '#/horizon/private/activity-subscriptions/api'
import {type MirrorApplies} from '#/horizon/private/activity-subscriptions/checks'
import {
  type Flags,
  GRACE_MS,
  MOUNT_DELAY_MS,
  OFF,
  pairKey,
  RETRY_SCHEDULE_MS,
  sameFlags,
} from '#/horizon/private/activity-subscriptions/common'
import {
  type BellUi,
  type HandoffKind,
  type Saver,
} from '#/horizon/private/activity-subscriptions/saver'

/** The dirty store's functions (`dirty-store.ts`, `dirty-store.web.ts`). */
export type DirtyStore = {
  readToken: (did: string, subject: string) => string | undefined
  writeToken: (did: string, subject: string, token: string) => void
  removeToken: (did: string, subject: string) => void
  listSubjects: (did: string) => string[]
  subscribeDirty: (
    listener: (did: string, subject: string) => void,
  ) => () => void
  readReconciled: (did: string) => number | undefined
  writeReconciled: (did: string, at: number) => void
  clearReconciled: (did: string) => void
}

/** The current account's clients, as the mirror and the reconcile use them. */
export type MirrorClients = {
  did: string
  prismClient: Client
  appviewClient: Client
  queryClient?: QueryClient
}

export type MirrorDeps = {
  store: DirtyStore
  saver: Saver
  ui: BellUi
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  newToken: () => string
  /** The current account's clients, or `undefined` signed out. */
  current: () => MirrorClients | undefined
  /** The switch (`PRIVATE_ACTIVITY_SUBSCRIPTIONS`). */
  enabled: () => boolean
  applies: (did: string) => MirrorApplies
  /** The device holds `member` and the feature (the "still unanswered" toast). */
  expectsMirror: (did: string) => boolean
  subscribeChecks: (listener: () => void) => () => void
  /** A failed prism call, for membership (`reportPrismError`). */
  reportError: (did: string, error: unknown) => void
  /** prism answered `NotEnrolled`. */
  onNotEnrolled: (did: string) => void
}

type LevelOptions = {
  /** A step of the retry sequence. */
  scheduled?: boolean
  /** The saver's hand-off. */
  handoff?: boolean
}

type Mount = {
  at: number
  /** The tokens present when the host mounted, by subject. */
  present: Map<string, string>
}

export type Mirror = ReturnType<typeof createMirror>

export function createMirror(deps: MirrorDeps) {
  const {store, saver} = deps
  /** The token this tab last wrote, per key. */
  const ownTokens = new Map<string, string>()
  /** A token this tab did not write, and when it first saw it. */
  const foreign = new Map<string, {token: string; at: number}>()
  const mounts = new Map<string, Mount>()
  const waits = new Map<string, {at: number; timer: unknown}>()
  /** The retry sequence of the latest press that started one, per key. */
  const schedules = new Map<
    string,
    {press: number; step: number; timer: unknown}
  >()
  /** The press whose on or off toast was shown, per key. */
  const toasted = new Map<string, number>()
  const runs = new Map<string, Promise<void>>()
  /** A trigger that came during a levelling: run again, with its options. */
  const again = new Map<string, LevelOptions>()

  function runAgain(key: string, opts: LevelOptions = {}) {
    const held = again.get(key) ?? {}
    again.set(key, {
      scheduled: held.scheduled || opts.scheduled,
      handoff: held.handoff || opts.handoff,
    })
  }

  function noteToken(did: string, subject: string, token: string) {
    const key = pairKey(did, subject)
    if (ownTokens.get(key) === token) return
    if (mounts.get(did)?.present.get(subject) === token) return
    if (foreign.get(key)?.token === token) return
    foreign.set(key, {token, at: deps.now()})
  }

  function removeIf(did: string, subject: string, token: string) {
    if (store.readToken(did, subject) === token) {
      store.removeToken(did, subject)
    }
  }

  function waitUntil(did: string, subject: string, at: number) {
    const key = pairKey(did, subject)
    const existing = waits.get(key)
    if (existing && existing.at <= at) return
    if (existing) deps.clearTimeout(existing.timer)
    const timer = deps.setTimeout(
      () => {
        if (waits.get(key)?.timer === timer) waits.delete(key)
        void level(did, subject)
      },
      Math.max(0, at - deps.now()),
    )
    waits.set(key, {at, timer})
  }

  function startSchedule(did: string, subject: string, press: number) {
    const key = pairKey(did, subject)
    const existing = schedules.get(key)
    if (existing?.press === press) return
    if (existing?.timer !== undefined) deps.clearTimeout(existing.timer)
    const entry = {press, step: 0, timer: undefined as unknown}
    const arm = () => {
      entry.timer = deps.setTimeout(() => {
        entry.timer = undefined
        entry.step += 1
        // A finished sequence stays recorded: it never restarts for a press.
        if (entry.step < RETRY_SCHEDULE_MS.length) arm()
        void level(did, subject, {scheduled: true})
      }, RETRY_SCHEDULE_MS[entry.step])
    }
    arm()
    schedules.set(key, entry)
  }

  /** Stop the sequence; the press stays recorded so it never restarts. */
  function clearSchedule(key: string) {
    const existing = schedules.get(key)
    if (!existing || existing.timer === undefined) return
    deps.clearTimeout(existing.timer)
    existing.timer = undefined
  }

  function pendingToast(did: string, subject: string) {
    const st = saver.status(did, subject)
    const key = pairKey(did, subject)
    if (!st || st.presses === 0 || toasted.get(key) === st.presses) return
    toasted.set(key, st.presses)
    deps.ui.mirrorPendingToast(st.latest)
  }

  function transient(did: string, subject: string) {
    const st = saver.status(did, subject)
    if (!st || st.presses === 0) return
    startSchedule(did, subject, st.presses)
    pendingToast(did, subject)
  }

  /** The earliest time rule (c) may read for this token. */
  function notBefore(did: string, subject: string, token: string): number {
    const key = pairKey(did, subject)
    const mount = mounts.get(did)
    if (mount?.present.get(subject) === token) return mount.at + MOUNT_DELAY_MS
    if (ownTokens.get(key) === token) return 0
    noteToken(did, subject, token)
    const seen = foreign.get(key)
    return (seen?.at ?? deps.now()) + GRACE_MS
  }

  async function put(
    clients: MirrorClients,
    subject: string,
    token: string,
    flags: Flags,
  ) {
    const {did} = clients
    const key = pairKey(did, subject)
    try {
      await putPrismSubscription(clients.prismClient, subject, flags)
    } catch (error) {
      deps.reportError(did, error)
      const kind = classifyPrismError(error)
      if (kind === 'transient' || kind === 'conflict') {
        logger.warn('activity subscriptions: mirror put failed', {
          name: failureName(error),
        })
        transient(did, subject)
        return
      }
      // Not retried: refused for good, or the account left the network.
      logger.warn('activity subscriptions: mirror put refused', {
        name: failureName(error),
      })
      removeIf(did, subject, token)
      clearSchedule(key)
      if (kind === 'not-enrolled') deps.onNotEnrolled(did)
      return
    }
    removeIf(did, subject, token)
    clearSchedule(key)
  }

  async function levelOnce(did: string, subject: string, opts: LevelOptions) {
    const clients = deps.current()
    if (!deps.enabled() || !clients || clients.did !== did) return
    const key = pairKey(did, subject)
    const token = store.readToken(did, subject)
    if (!token) return
    noteToken(did, subject, token)

    const applies = deps.applies(did)
    if (applies === 'no') {
      removeIf(did, subject, token)
      clearSchedule(key)
      return
    }
    const st = saver.status(did, subject)
    if (applies === 'wait') {
      if (st && st.presses > 0) {
        if (opts.handoff) startSchedule(did, subject, st.presses)
        if (opts.scheduled && deps.expectsMirror(did)) {
          pendingToast(did, subject)
        }
      }
      return
    }
    // The saver's hand-off comes when it is done.
    if (st && !st.idle) return

    const now = deps.now()
    // (a) Send the acknowledged flags.
    if (
      st &&
      ownTokens.get(key) === token &&
      st.unansweredSentAt === undefined &&
      st.ackedAt !== undefined &&
      now - st.ackedAt < GRACE_MS
    ) {
      await put(clients, subject, token, st.acked)
      return
    }
    // (b) Wait for G after an unanswered put.
    if (st?.unansweredSentAt !== undefined) {
      const until = st.unansweredSentAt + GRACE_MS
      if (now < until) {
        waitUntil(did, subject, until)
        return
      }
    }
    // (c) Level from Bluesky, not before its set time.
    const earliest = notBefore(did, subject, token)
    if (now < earliest) {
      waitUntil(did, subject, earliest)
      return
    }
    const presses = saver.presses(did, subject)
    let bell
    try {
      bell = await readBlueskyBell(clients.appviewClient, subject)
    } catch (error) {
      // The key stays; the schedule and the triggers try again.
      logger.warn('activity subscriptions: levelling read failed', {
        name: failureName(error),
      })
      return
    }
    if (saver.presses(did, subject) !== presses) return
    if (store.readToken(did, subject) !== token) {
      runAgain(key)
      return
    }
    if (bell.blocked) {
      await put(clients, subject, token, OFF)
      return
    }
    const before = saver.status(did, subject)
    const changes = !before || !sameFlags(before.shown, bell.flags)
    saver.showRead(did, subject, presses, bell.flags, clients.queryClient)
    if (
      before &&
      before.presses > 0 &&
      changes &&
      !sameFlags(bell.flags, before.latest)
    ) {
      deps.ui.failedToast(before.handle)
    }
    await put(clients, subject, token, bell.flags)
  }

  function level(
    did: string,
    subject: string,
    opts: LevelOptions = {},
  ): Promise<void> {
    const key = pairKey(did, subject)
    const running = runs.get(key)
    if (running) {
      runAgain(key, opts)
      return running
    }
    const run = (async () => {
      try {
        let options: LevelOptions | undefined = opts
        while (options) {
          again.delete(key)
          await levelOnce(did, subject, options)
          options = again.get(key)
        }
      } catch (error) {
        logger.error('activity subscriptions: levelling failed', {
          safeMessage: error,
        })
      } finally {
        runs.delete(key)
      }
    })()
    runs.set(key, run)
    return run
  }

  function levelAll(did: string): Promise<void> {
    return Promise.all(
      store.listSubjects(did).map(subject => level(did, subject)),
    ).then(() => undefined)
  }

  return {
    /**
     * A press: mark the subject dirty with a fresh token of this tab's own,
     * one synchronous device write.
     */
    markPressed(did: string, subject: string) {
      const token = deps.newToken()
      ownTokens.set(pairKey(did, subject), token)
      store.writeToken(did, subject, token)
    },

    /** The saver's hand-off (2.2, "When the mirror runs"). */
    handoff(did: string, subject: string, kind: HandoffKind) {
      if (!deps.enabled()) return
      const key = pairKey(did, subject)
      if (kind !== 'refused' && store.readToken(did, subject) === undefined) {
        const st = saver.status(did, subject)
        const seen = foreign.get(key)
        // The key was levelled since this press; a foreign token is newer.
        if (!seen || (st && seen.at < st.lastPressAt)) {
          const token = deps.newToken()
          ownTokens.set(key, token)
          store.writeToken(did, subject, token)
        }
      }
      void level(did, subject, {handoff: true})
    },

    /** Look at the subject again at monotonic time `at`. */
    levelAt(did: string, subject: string, at: number) {
      waitUntil(did, subject, at)
    },

    /** Level one subject now (subject to its rules). */
    level,

    /** Level every dirty subject of `did`. */
    levelAll,

    /**
     * Whether the reconcile must leave the subject to the mirror: still in
     * the dirty set, or with work in this tab's saver.
     */
    isBusy(did: string, subject: string): boolean {
      if (store.readToken(did, subject) !== undefined) return true
      const st = saver.status(did, subject)
      return !!st && !st.idle
    },

    /**
     * The host mounted for `did`: keys present now are levelled 20 s from
     * now, and no trigger levels them sooner; membership and feature answers
     * level again; another tab's presses are noted as foreign. Returns the
     * unmount.
     */
    mount(did: string): () => void {
      const present = new Map<string, string>()
      for (const subject of store.listSubjects(did)) {
        const token = store.readToken(did, subject)
        if (token) present.set(subject, token)
      }
      const mount: Mount = {at: deps.now(), present}
      mounts.set(did, mount)
      const timer = deps.setTimeout(() => void levelAll(did), MOUNT_DELAY_MS)
      const unsubscribeChecks = deps.subscribeChecks(() => void levelAll(did))
      const unsubscribeStore = store.subscribeDirty((keyDid, subject) => {
        const token = store.readToken(keyDid, subject)
        if (!token) return
        const key = pairKey(keyDid, subject)
        if (ownTokens.get(key) === token) return
        noteToken(keyDid, subject, token)
        const seen = foreign.get(key)
        if (keyDid === did && seen?.token === token) {
          waitUntil(keyDid, subject, seen.at + GRACE_MS)
        }
      })
      return () => {
        deps.clearTimeout(timer)
        unsubscribeChecks()
        unsubscribeStore()
        if (mounts.get(did) === mount) mounts.delete(did)
        for (const [key, wait] of waits) {
          if (key.startsWith(`${did} `)) {
            deps.clearTimeout(wait.timer)
            waits.delete(key)
          }
        }
      }
    },

    /** Forget everything (tests). */
    reset() {
      for (const wait of waits.values()) deps.clearTimeout(wait.timer)
      for (const schedule of schedules.values()) {
        deps.clearTimeout(schedule.timer)
      }
      ownTokens.clear()
      foreign.clear()
      mounts.clear()
      waits.clear()
      schedules.clear()
      toasted.clear()
      runs.clear()
      again.clear()
    },
  }
}
