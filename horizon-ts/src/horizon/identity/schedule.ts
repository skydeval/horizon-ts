/*
 * When an identity entry is asked (Phase 5 design 4.5, PP-23, B-29): the
 * mount-time asks (a first read, stale while revalidate, a restored entry,
 * the profile's and hover card's fresh read), the retries of an unknown
 * while it is observed and the app is visible, the 60 s negative entries
 * and the 429 pause. The entries themselves live in the query cache
 * (`queries.ts`); this module holds only when to ask, in memory, and asks
 * through the `fetch` each observer hands it.
 *
 * - **Episodes.** A key's first unknown starts an episode. Each retry is
 *   timed from the arrival of the answer it repeats: with a token 5, 10, 20
 *   and 40 s, then every 60 s, none sent more than 5 minutes after the
 *   episode's first unknown; without a token 30 s, then every 5 minutes,
 *   none more than 15 minutes after. A record or none ends the episode.
 *   With a token the last observer's unmount ends it too; without one the
 *   episode (its next allowed ask and its cap) is kept across unmounts
 *   until the cap would have passed, so a remount in a scrolled feed never
 *   asks sooner than that cadence (P5R5-N6). Nothing is asked for a key
 *   with no observer.
 * - **At the cap** the key takes a 60 s negative entry (signed in), or
 *   waits for the cap time itself (signed out), and a later mount asks once
 *   and starts a new episode.
 * - **Hidden.** No retry is sent while the app is hidden; one that falls
 *   due then is sent on return, if still observed and inside its cap.
 * - **Errors** (network, 5xx, timeout, another 4xx) take a 60 s negative
 *   entry and are not retried while observed; a mount after it asks.
 * - **A 429** never counts as an answer: observed keys are asked again
 *   when the pause ends.
 * - **Fresh reads.** A profile or hover card mount asks whatever the
 *   entry's age unless its last answer is under 30 s old. Signed out, a
 *   kept episode's schedule is followed by the hover card; the profile
 *   asks once outside it (if its last answer is at least 30 s old),
 *   leaving the episode's cap alone and its next ask at least 30 s after
 *   this answer (P5R6-N5).
 * - **Account changes** drop every episode, so a signed-in reader's keys
 *   follow the signed-in cadence from their next unknown.
 */

import {AppState} from 'react-native'

import {
  FRESH_READ_FLOOR_MS,
  NEGATIVE_MS,
  SIGNED_IN_CAP_MS,
  SIGNED_IN_DELAYS_MS,
  SIGNED_OUT_CAP_MS,
  SIGNED_OUT_DELAYS_MS,
} from '#/horizon/identity/config'
import {
  getCurrentClients,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'

/** How a component observes a key. */
export type ObserveMode = 'post' | 'profile' | 'hover'

/** What one ask of a key came to. */
export type IdentityOutcome =
  | {kind: 'answer'}
  | {kind: 'unknown'; authed: boolean}
  | {kind: 'error'}
  | {kind: 'limited'; until: number}

/** The entry's cached state, as the mount decision needs it. */
export type KeyState = {
  hasData: boolean
  dataUpdatedAt: number
  /** The last answer's arrival this run (any outcome but a 429), or 0. */
  answeredAt: number
  /** Whether a record, none, unknown or error arrived this run. */
  settledThisRun: boolean
  fetching: boolean
}

/** One key, as an observer hands it over. */
export type ScheduledKey = {
  hash: string
  staleMs: number
  state: () => KeyState
  /**
   * Start an ask; concurrent asks share one fetch. Resolves when it has
   * settled, never rejects.
   */
  fetch: () => Promise<unknown>
  /** The 429 pause end, or 0. */
  pausedUntil: () => number
}

type Episode = {
  firstUnknownAt: number
  /** Unknown answers in this episode that counted toward the cadence. */
  answers: number
  authed: boolean
  nextAskAt: number
  /** No retry is sent after this. */
  capAt: number
  /** No retry is left before the cap (signed out: kept until `capAt`). */
  exhausted: boolean
}

type Entry = {
  key: ScheduledKey
  observers: Map<symbol, ObserveMode>
  episode?: Episode
  negativeUntil: number
  timer?: ReturnType<typeof setTimeout>
  dueWhileHidden: boolean
  /** The current ask is the profile's once-outside-the-schedule ask. */
  outsideAsk: boolean
}

/** The visibility the retries follow (`AppState`; tests swap it). */
export type VisibilityEnv = {
  isVisible(): boolean
  subscribe(listener: () => void): () => void
}

const appStateVisibility: VisibilityEnv = {
  isVisible: () => AppState.currentState === 'active',
  subscribe: listener => {
    const subscription = AppState.addEventListener('change', listener)
    return () => subscription.remove()
  },
}

const entries = new Map<string, Entry>()
let visibility: VisibilityEnv = appStateVisibility
let unwatchVisibility: (() => void) | undefined
let unwatchAccount: (() => void) | undefined
let watchedDid: string | undefined

function cadence(authed: boolean) {
  return authed
    ? {delays: SIGNED_IN_DELAYS_MS, cap: SIGNED_IN_CAP_MS}
    : {delays: SIGNED_OUT_DELAYS_MS, cap: SIGNED_OUT_CAP_MS}
}

function delayAfter(authed: boolean, answers: number): number {
  const {delays} = cadence(authed)
  return delays[Math.min(answers - 1, delays.length - 1)]
}

function clearTimer(entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = undefined
}

function dropEpisodes() {
  for (const entry of entries.values()) {
    entry.episode = undefined
    clearTimer(entry)
    entry.dueWhileHidden = false
  }
}

function watch() {
  if (!unwatchVisibility) {
    unwatchVisibility = visibility.subscribe(onVisibilityChange)
  }
  if (!unwatchAccount) {
    watchedDid = getCurrentClients()?.did
    unwatchAccount = subscribeCurrentClients(() => {
      const did = getCurrentClients()?.did
      if (did === watchedDid) return
      watchedDid = did
      dropEpisodes()
    })
  }
}

function onVisibilityChange() {
  if (!visibility.isVisible()) return
  for (const entry of entries.values()) {
    if (!entry.dueWhileHidden) continue
    entry.dueWhileHidden = false
    fire(entry)
  }
}

function entryFor(key: ScheduledKey): Entry {
  let entry = entries.get(key.hash)
  if (!entry) {
    entry = {
      key,
      observers: new Map(),
      negativeUntil: 0,
      dueWhileHidden: false,
      outsideAsk: false,
    }
    entries.set(key.hash, entry)
  } else {
    entry.key = key
  }
  return entry
}

function ask(entry: Entry, {outside = false}: {outside?: boolean} = {}) {
  clearTimer(entry)
  entry.outsideAsk = outside
  void entry.key.fetch()
}

function arm(entry: Entry, at: number) {
  clearTimer(entry)
  if (entry.observers.size === 0) return
  entry.timer = setTimeout(
    () => {
      entry.timer = undefined
      fire(entry)
    },
    Math.max(0, at - Date.now()),
  )
}

/** A scheduled ask fell due. */
function fire(entry: Entry) {
  if (entry.observers.size === 0) return
  if (!visibility.isVisible()) {
    entry.dueWhileHidden = true
    return
  }
  const now = Date.now()
  const paused = entry.key.pausedUntil()
  if (paused > now) {
    arm(entry, paused)
    return
  }
  const episode = entry.episode
  if (episode) {
    if (episode.exhausted) return
    if (now > episode.capAt) {
      endAtCap(entry, now)
      return
    }
    if (now < episode.nextAskAt) {
      arm(entry, episode.nextAskAt)
      return
    }
  }
  if (entry.key.state().fetching) return
  ask(entry)
}

function endAtCap(entry: Entry, now: number) {
  const episode = entry.episode
  entry.negativeUntil = now + NEGATIVE_MS
  if (episode && !episode.authed) {
    episode.exhausted = true
    episode.nextAskAt = episode.capAt
  } else {
    entry.episode = undefined
  }
  clearTimer(entry)
}

function lastAnswerAt(state: KeyState): number {
  return Math.max(state.answeredAt, state.hasData ? state.dataUpdatedAt : 0)
}

/** What a mount (or a page prefetch, as a post) does now. */
function onMount(entry: Entry, mode: ObserveMode) {
  const now = Date.now()
  const key = entry.key
  const state = key.state()
  const episode = entry.episode
  if (episode && now >= episode.capAt) entry.episode = undefined
  if (state.fetching) return
  const paused = key.pausedUntil()
  if (paused > now) {
    arm(entry, paused)
    return
  }
  const sinceAnswer = now - lastAnswerAt(state)
  if (entry.episode) {
    if (mode === 'profile' && sinceAnswer >= FRESH_READ_FLOOR_MS) {
      ask(entry, {outside: true})
      return
    }
    if (entry.episode.exhausted) return
    arm(entry, entry.episode.nextAskAt)
    return
  }
  if (entry.negativeUntil > now) return
  if (mode !== 'post') {
    if (sinceAnswer >= FRESH_READ_FLOOR_MS) ask(entry)
    return
  }
  if (!state.hasData) {
    ask(entry)
    return
  }
  if (!state.settledThisRun) {
    // Restored from disk: refetched on mount, whatever its age.
    ask(entry)
    return
  }
  if (now - state.dataUpdatedAt > key.staleMs) ask(entry)
}

/**
 * Observe `key` while a component shows it. Returns the stop function,
 * called on unmount.
 */
export function observeIdentityKey(
  key: ScheduledKey,
  mode: ObserveMode,
): () => void {
  watch()
  const entry = entryFor(key)
  const id = Symbol(key.hash)
  entry.observers.set(id, mode)
  onMount(entry, mode)
  return () => {
    entry.observers.delete(id)
    if (entry.observers.size > 0) return
    clearTimer(entry)
    entry.dueWhileHidden = false
    // Signed in, an unmount ends the episode; signed out it is kept.
    if (entry.episode?.authed) entry.episode = undefined
  }
}

/**
 * Ask `key` now if a post mounting now would (a page's prefetch, 4.6),
 * without observing it.
 */
export function prefetchIdentityKey(
  key: ScheduledKey,
): Promise<unknown> | undefined {
  watch()
  const entry = entryFor(key)
  const now = Date.now()
  const state = key.state()
  if (state.fetching) return key.fetch()
  if (key.pausedUntil() > now) return undefined
  if (entry.episode && now < entry.episode.capAt) return undefined
  if (entry.negativeUntil > now) return undefined
  if (
    !state.hasData ||
    !state.settledThisRun ||
    now - state.dataUpdatedAt > key.staleMs
  ) {
    return key.fetch()
  }
  return undefined
}

/**
 * Record what an ask of `hash` came to, at its arrival `at` (from the
 * query function).
 */
export function reportIdentityOutcome(
  key: ScheduledKey,
  outcome: IdentityOutcome,
  at: number = Date.now(),
) {
  watch()
  const entry = entryFor(key)
  const outside = entry.outsideAsk
  entry.outsideAsk = false
  switch (outcome.kind) {
    case 'answer':
      entry.episode = undefined
      entry.negativeUntil = 0
      clearTimer(entry)
      return
    case 'error':
      entry.episode = undefined
      entry.negativeUntil = at + NEGATIVE_MS
      clearTimer(entry)
      return
    case 'limited':
      arm(entry, outcome.until)
      return
    case 'unknown': {
      let episode = entry.episode
      if (episode && at >= episode.capAt) episode = undefined
      if (!episode) {
        episode = {
          firstUnknownAt: at,
          answers: 0,
          authed: outcome.authed,
          nextAskAt: at,
          capAt: at + cadence(outcome.authed).cap,
          exhausted: false,
        }
        entry.episode = episode
      }
      if (outside) {
        // The profile's ask outside the schedule moves neither the cap nor
        // the count; the next ask waits at least the fresh-read floor.
        episode.nextAskAt = Math.max(
          episode.nextAskAt,
          at + FRESH_READ_FLOOR_MS,
        )
      } else {
        episode.authed = outcome.authed
        episode.capAt = episode.firstUnknownAt + cadence(outcome.authed).cap
        episode.answers++
        episode.nextAskAt = at + delayAfter(outcome.authed, episode.answers)
      }
      if (episode.exhausted) return
      if (episode.nextAskAt > episode.capAt) {
        endAtCap(entry, at)
        return
      }
      arm(entry, episode.nextAskAt)
      return
    }
  }
}

/** Test-only: swap the visibility the retries follow. */
export function setIdentityVisibility(env: VisibilityEnv | undefined) {
  unwatchVisibility?.()
  unwatchVisibility = undefined
  visibility = env ?? appStateVisibility
}

/** Test-only: forget every entry, timer and subscription. */
export function resetIdentitySchedule() {
  for (const entry of entries.values()) clearTimer(entry)
  entries.clear()
  unwatchVisibility?.()
  unwatchVisibility = undefined
  unwatchAccount?.()
  unwatchAccount = undefined
  watchedDid = undefined
}
