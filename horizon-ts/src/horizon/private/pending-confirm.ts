/*
 * The pending store's confirmation loop (prism busy design 6.6). A written
 * pending post is first asked about at `CONFIRM_AT_MS` after its write
 * (`confirmInBackground`); after that one store-wide loop asks prism about
 * every written entry still pending, every 30 to 60 s, then every 5 min once
 * the newest is 30 min old. It skips while the app is in the background or
 * prism is unwell, and runs at once on the catch-up (2.4) and when the app
 * comes back to the foreground. It stops on an account change and once
 * nothing is pending.
 *
 * Entries are kept past `PENDING_TTL_MS` while the author's PDS has them.
 * Once an entry's time is up the loop reads its record from the PDS (one
 * `getRecord`): `present` keeps it another `PENDING_TTL_MS`, `absent`
 * (`RecordNotFound`) drops it, anything else asks again in 2 min. An entry
 * prism listed in `unavailable[]` is kept another `PENDING_TTL_MS` with no
 * PDS read. Every pass notifies the store's listeners, so the "Syncing" label
 * turns on and off with it (D-19).
 */

import {AppState} from 'react-native'
import {XrpcResponseError} from '@atproto/lex'
import {AtUri, type DidString} from '@atproto/syntax'

import {logger} from '#/logger'
import {getPrivatePostsAnswered} from '#/horizon/private/api/reads'
import {registerCatchUpStep} from '#/horizon/private/catch-up'
import {
  CONFIRM_AT_MS,
  confirmPendingPost,
  dropAbsentPendingPost,
  getPendingPosts,
  notifyPrivateStores,
  PENDING_TTL_MS,
  pendingPhase,
  type PendingPost,
} from '#/horizon/private/store'
import {PP_COLLECTION} from '#/horizon/private/uri'
import {
  getCurrentClients,
  getCurrentDid,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {getPrismHealth, healthEnvironment} from '#/horizon/routing/health'
import {com} from '#/lexicons'

/** The loop's interval while an entry is younger than {@link CONFIRM_SLOW_AFTER_MS}: 30 to 60 s. */
export const CONFIRM_EVERY_MS = 30_000

/** After this long since the newest write, the loop slows to {@link CONFIRM_SLOW_MS}. */
export const CONFIRM_SLOW_AFTER_MS = 30 * 60_000

/** The loop's slow interval. */
export const CONFIRM_SLOW_MS = 5 * 60_000

/** When the PDS can't say, the entry is asked about again this much later. */
export const PENDING_RECHECK_MS = 2 * 60_000

/** When the loop next asks the PDS about an entry past its time, by URI. */
const nextPdsCheckAt = new Map<string, number>()

let timer: unknown
let timerAt: number | undefined
let running = false
let watching = false
let watchedDid: string | undefined

function now(): number {
  return healthEnvironment().now()
}

function writtenAt(entry: PendingPost): number {
  return entry.expiresAt - PENDING_TTL_MS
}

/** The entries the loop asks about: written, past their first confirmations. */
function dueEntries(): PendingPost[] {
  const last = CONFIRM_AT_MS[CONFIRM_AT_MS.length - 1]
  const at = now()
  return getPendingPosts().filter(
    entry =>
      pendingPhase(entry) === 'written' &&
      Number.isFinite(entry.expiresAt) &&
      at - writtenAt(entry) >= last,
  )
}

/** The written entries still pending, whatever their age. */
function writtenEntries(): PendingPost[] {
  return getPendingPosts().filter(
    entry =>
      pendingPhase(entry) === 'written' && Number.isFinite(entry.expiresAt),
  )
}

function clear() {
  const env = healthEnvironment()
  if (timer !== undefined) env.clearTimeout(timer)
  timer = undefined
  timerAt = undefined
}

/** Arm the next pass, or stop when nothing written is pending. */
function scheduleNext(delayMs?: number) {
  const entries = writtenEntries()
  if (entries.length === 0) {
    clear()
    return
  }
  const env = healthEnvironment()
  const newest = Math.max(...entries.map(writtenAt))
  const delay =
    delayMs ??
    (now() - newest >= CONFIRM_SLOW_AFTER_MS
      ? CONFIRM_SLOW_MS
      : CONFIRM_EVERY_MS * (1 + env.random()))
  const at = now() + delay
  if (timer !== undefined && timerAt !== undefined && timerAt <= at) return
  clear()
  timerAt = at
  timer = env.setTimeout(() => {
    timer = undefined
    timerAt = undefined
    void pass()
  }, delay)
}

async function readRecord(
  did: string,
  uri: string,
): Promise<'present' | 'absent' | 'unknown'> {
  const clients = getCurrentClients()
  if (!clients || clients.did !== did) return 'unknown'
  try {
    await clients.pdsClient.call(com.atproto.repo.getRecord, {
      repo: did as DidString,
      collection: PP_COLLECTION,
      rkey: new AtUri(uri).rkey,
    })
    return 'present'
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return 'absent'
    }
    return 'unknown'
  }
}

/** One pass: ask prism about the due entries, then the PDS about the expired. */
async function pass(): Promise<void> {
  if (running) return
  const did = getCurrentDid()
  const clients = getCurrentClients()
  if (!did || !clients || clients.did !== did) {
    clear()
    return
  }
  if (AppState.currentState !== 'active') {
    scheduleNext()
    return
  }
  running = true
  try {
    const listed = new Set<string>()
    const due = dueEntries()
    if (due.length > 0 && getPrismHealth(did).causes.size === 0) {
      try {
        const {posts, answer} = await getPrivatePostsAnswered(
          clients.prismClient,
          due.map(entry => entry.uri),
        )
        for (const post of posts) confirmPendingPost(post.uri)
        for (const item of answer.unavailable) listed.add(item.uri)
      } catch (error) {
        logger.warn('pending posts: confirmation failed', {safeMessage: error})
      }
    }
    // Entries past their time: kept while the PDS has them (6.6).
    const at = now()
    for (const entry of writtenEntries()) {
      const checkAt = nextPdsCheckAt.get(entry.uri) ?? entry.expiresAt
      if (checkAt > at) continue
      if (listed.has(entry.uri)) {
        nextPdsCheckAt.set(entry.uri, at + PENDING_TTL_MS)
        continue
      }
      const state = await readRecord(did, entry.uri)
      if (getCurrentDid() !== did) return
      if (state === 'absent') {
        nextPdsCheckAt.delete(entry.uri)
        dropAbsentPendingPost(entry.uri)
      } else {
        nextPdsCheckAt.set(
          entry.uri,
          now() + (state === 'present' ? PENDING_TTL_MS : PENDING_RECHECK_MS),
        )
      }
    }
  } finally {
    running = false
    notifyPrivateStores()
    scheduleNext()
  }
}

function watch() {
  if (watching) return
  watching = true
  watchedDid = getCurrentDid()
  subscribeCurrentClients(() => {
    const next = getCurrentDid()
    if (next === watchedDid) return
    watchedDid = next
    nextPdsCheckAt.clear()
    clear()
  })
  AppState.addEventListener('change', state => {
    if (state === 'active') void confirmPendingNow()
  })
  registerCatchUpStep(() => {
    void confirmPendingNow()
  })
}

/**
 * Start the loop for the pending entries, once their first confirmations
 * have run (`confirmInBackground`). Nothing runs with nothing pending.
 */
export function startPendingLoop(): void {
  watch()
  scheduleNext()
}

/**
 * One pass at once (the catch-up, the app back in the foreground). Resolves
 * once it is done.
 */
export function confirmPendingNow(): Promise<void> {
  if (writtenEntries().length === 0) return Promise.resolve()
  clear()
  return pass()
}

/** Stop the loop and forget its PDS times (tests). */
export function resetPendingLoop(): void {
  clear()
  nextPdsCheckAt.clear()
  running = false
}
