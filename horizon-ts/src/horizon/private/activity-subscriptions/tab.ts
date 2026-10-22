/*
 * This tab's activity subscriptions machinery (activity subscriptions design
 * 2.1 to 2.3): one saver, one mirror and one reconcile, wired over the
 * device's dirty store, plus the schedule the host runs them on. Everything
 * is in memory, per tab or process; only the dirty set and
 * `reconciled:<did>` are on the device.
 */

import {AppState} from 'react-native'

import {IS_WEB} from '#/env'
import {
  deviceExpectsMirror,
  mirrorApplies,
  reconcileApplies,
  subscribeMirrorChecks,
} from '#/horizon/private/activity-subscriptions/checks'
import {
  GRACE_MS,
  monotonicNow,
  MOUNT_DELAY_MS,
  newToken,
  RECONCILE_INTERVAL_MS,
} from '#/horizon/private/activity-subscriptions/common'
import * as dirtyStore from '#/horizon/private/activity-subscriptions/dirty-store'
import {
  createMirror,
  type DirtyStore,
  type Mirror,
  type MirrorClients,
} from '#/horizon/private/activity-subscriptions/mirror'
import {createReconcile} from '#/horizon/private/activity-subscriptions/reconcile'
import {
  type BellUi,
  createSaver,
  type Saver,
} from '#/horizon/private/activity-subscriptions/saver'
import {bellUi} from '#/horizon/private/activity-subscriptions/ui'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {
  reportPrismError,
  requestMembershipRecheck,
} from '#/horizon/routing/membership'
import {
  ACTIVITY_SUBSCRIPTION_REMOVALS,
  PRIVATE_ACTIVITY_SUBSCRIPTIONS,
} from '#/horizon/switches'

export type ActivityTab = {
  saver: Saver
  mirror: Mirror
  reconcile: ReturnType<typeof createReconcile>
  store: DirtyStore
}

export type ActivityTabDeps = {
  store: DirtyStore
  ui: BellUi
  now: () => number
  wallNow: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  newToken: () => string
  current: () => MirrorClients | undefined
  enabled: () => boolean
  removals: () => boolean
  applies: typeof mirrorApplies
  expectsMirror: (did: string) => boolean
  subscribeChecks: (listener: () => void) => () => void
  reportError: (did: string, error: unknown) => void
}

function currentMirrorClients(): MirrorClients | undefined {
  const current = getCurrentClients()
  if (!current) return undefined
  return {
    did: current.did,
    prismClient: current.prismClient,
    appviewClient: current.appviewClient,
    queryClient: current.queryClient,
  }
}

/** The production dependencies; tests replace any of them. */
export function defaultTabDeps(): ActivityTabDeps {
  return {
    store: dirtyStore,
    ui: bellUi,
    now: monotonicNow,
    wallNow: Date.now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    newToken,
    current: currentMirrorClients,
    enabled: () => PRIVATE_ACTIVITY_SUBSCRIPTIONS,
    removals: () => ACTIVITY_SUBSCRIPTION_REMOVALS,
    applies: mirrorApplies,
    expectsMirror: deviceExpectsMirror,
    subscribeChecks: subscribeMirrorChecks,
    reportError: reportPrismError,
  }
}

export function createActivityTab(
  overrides: Partial<ActivityTabDeps> = {},
): ActivityTab {
  const deps = {...defaultTabDeps(), ...overrides}
  const onNotEnrolled = (did: string) => {
    // A rejoining member is copied at once (AS1-Q3).
    deps.store.clearReconciled(did)
    requestMembershipRecheck(did)
  }
  let mirror: Mirror | undefined
  const saver = createSaver({
    now: deps.now,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    ui: deps.ui,
    graceMs: GRACE_MS,
    handoff: (did, subject, kind) => mirror?.handoff(did, subject, kind),
    levelAt: (did, subject, at) => mirror?.levelAt(did, subject, at),
  })
  mirror = createMirror({
    store: deps.store,
    saver,
    ui: deps.ui,
    now: deps.now,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    newToken: deps.newToken,
    current: deps.current,
    enabled: deps.enabled,
    applies: deps.applies,
    expectsMirror: deps.expectsMirror,
    subscribeChecks: deps.subscribeChecks,
    reportError: deps.reportError,
    onNotEnrolled,
  })
  const reconcile = createReconcile({
    store: deps.store,
    mirror,
    wallNow: deps.wallNow,
    removals: deps.removals,
    reportError: deps.reportError,
    onNotEnrolled,
  })
  return {saver, mirror, reconcile, store: deps.store}
}

let tab: ActivityTab | undefined

/** This tab's machinery, made on first use. */
export function getActivityTab(): ActivityTab {
  if (!tab) tab = createActivityTab()
  return tab
}

/** The timers and foreground the sync host uses; injectable for tests. */
export type SyncEnvironment = {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** Wall-clock time, as `reconciled:<did>` holds it. */
  wallNow: () => number
  /** Web: the tab is visible. Native: the app is active. */
  isForeground: () => boolean
  /** Call `callback` on each return to the foreground; returns unsubscribe. */
  onForeground: (callback: () => void) => () => void
  /** The current account's clients, when they are `did`'s. */
  clients: (did: string) => MirrorClients | undefined
  /** The switch and the run's checks (2.3, "When it runs"). */
  canReconcile: (did: string) => boolean
  subscribeChecks: (listener: () => void) => () => void
}

export function defaultSyncEnvironment(): SyncEnvironment {
  const hasDocument = IS_WEB && typeof document !== 'undefined'
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    wallNow: Date.now,
    isForeground: () =>
      hasDocument
        ? document.visibilityState === 'visible'
        : AppState.currentState === 'active',
    onForeground: callback => {
      if (hasDocument) {
        const listener = () => {
          if (document.visibilityState === 'visible') callback()
        }
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      }
      const subscription = AppState.addEventListener('change', state => {
        if (state === 'active') callback()
      })
      return () => subscription.remove()
    },
    clients: did => {
      const current = currentMirrorClients()
      return current?.did === did ? current : undefined
    },
    canReconcile: did =>
      PRIVATE_ACTIVITY_SUBSCRIPTIONS && reconcileApplies(did),
    subscribeChecks: subscribeMirrorChecks,
  }
}

/**
 * Attempts are at least this far apart whatever the trigger, so a run that
 * keeps failing is not repeated on every return to the foreground.
 */
export const RECONCILE_MIN_SPACING_MS = GRACE_MS

/**
 * Run the mirror and the reconcile for `did` while the host is mounted for
 * it (2.2, 2.3): keys left from an earlier run are levelled 20 s after
 * mount; every dirty key on each return to the foreground; the reconcile
 * when due (no complete run in the last hour), checked 20 s after its
 * conditions hold, on each return to the foreground, and when it next falls
 * due while in the foreground (at most an hour after the last attempt).
 * Returns the stop function.
 */
export function startActivitySync(
  activity: ActivityTab,
  did: string,
  env: SyncEnvironment = defaultSyncEnvironment(),
): () => void {
  let stopped = false
  let ready = false
  let readyTimer: unknown
  let dueTimer: unknown
  let lastAttempt: number | undefined
  const unmountMirror = activity.mirror.mount(did)

  /**
   * Check again when the run next falls due: at most an hour, and at least
   * the minimum spacing, from now.
   */
  const armDue = () => {
    if (stopped) return
    if (dueTimer !== undefined) env.clearTimeout(dueTimer)
    const record = activity.store.readReconciled(did)
    const next = Math.max(
      (record ?? -Infinity) + RECONCILE_INTERVAL_MS,
      (lastAttempt ?? -Infinity) + RECONCILE_INTERVAL_MS,
    )
    const wait = Number.isFinite(next)
      ? Math.min(
          RECONCILE_INTERVAL_MS,
          Math.max(RECONCILE_MIN_SPACING_MS, next - env.wallNow()),
        )
      : RECONCILE_INTERVAL_MS
    dueTimer = env.setTimeout(() => {
      dueTimer = undefined
      check()
      // In the background the next return to the foreground checks and re-arms.
      if (env.isForeground()) armDue()
    }, wait)
  }

  const check = () => {
    if (stopped || !ready || !env.isForeground()) return
    if (!env.canReconcile(did)) return
    const clients = env.clients(did)
    if (!clients || !activity.reconcile.isDue(did)) return
    const now = env.wallNow()
    if (lastAttempt !== undefined && now - lastAttempt < RECONCILE_MIN_SPACING_MS) {
      return
    }
    lastAttempt = now
    void activity.reconcile.run(clients).finally(armDue)
  }

  const armReady = () => {
    if (stopped || ready || readyTimer !== undefined) return
    if (!env.canReconcile(did)) return
    readyTimer = env.setTimeout(() => {
      readyTimer = undefined
      ready = true
      check()
      armDue()
    }, MOUNT_DELAY_MS)
  }

  armReady()
  const unsubscribeChecks = env.subscribeChecks(() => {
    armReady()
    check()
  })
  const unsubscribeForeground = env.onForeground(() => {
    void activity.mirror.levelAll(did)
    armReady()
    check()
    if (ready) armDue()
  })

  return () => {
    stopped = true
    if (readyTimer !== undefined) env.clearTimeout(readyTimer)
    if (dueTimer !== undefined) env.clearTimeout(dueTimer)
    unsubscribeChecks()
    unsubscribeForeground()
    unmountMirror()
  }
}
