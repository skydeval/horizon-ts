/*
 * The per-account TID clock (Phase 5 design, Appendix A; P5R2-B1, P5R3-Q1).
 *
 * Stock `TID.next()` keeps one clock id and one counter for the whole page,
 * so every account used in one page without a reload writes rkeys that share
 * them, a public link between the accounts. Here each account gets its own
 * random clock id per page load, never equal to another account's in the
 * page, and its own copy of stock's counter.
 *
 * No React, no storage, no network: the state is module-level and lives as
 * long as the page (on native, the JavaScript runtime).
 */
import {TID} from '@atproto/common-web'

import {PER_ACCOUNT_TID_CLOCK} from '#/horizon/switches'

const CLOCK_IDS = 32

/** DID to clock id, this page. */
const clockIds = new Map<string, number>()
/** DID to stock's `lastTimestamp`, per account. */
const lastMs = new Map<string, number>()
/** DID to stock's `timestampCount`, per account. */
const counts = new Map<string, number>()
/** DID to the last timestamp returned, in microseconds. */
const lastMicros = new Map<string, number>()

/*
 * An integer in 0..n-1. The crypto source keeps one account's visible draws
 * from predicting another's through a shared `Math.random` state; without it,
 * stock's own source.
 */
function randomBelow(n: number): number {
  const c = (globalThis as {crypto?: Crypto}).crypto
  if (typeof c?.getRandomValues === 'function') {
    const u = c.getRandomValues(new Uint32Array(1))[0]
    return Math.floor((u / 4294967296) * n)
  }
  return Math.floor(Math.random() * n)
}

function assertDid(did: string) {
  if (typeof did !== 'string' || !did.startsWith('did:')) {
    // The value is not put in the message.
    throw new Error('nextTid: not a DID')
  }
}

/**
 * The clock id `did`'s TIDs carry in this page load, 0 to 31. Drawn at
 * random the first time it is asked for, never equal to another account's
 * in this page while a free value remains, and kept until the page reloads.
 */
export function clockIdFor(did: string): number {
  assertDid(did)
  const known = clockIds.get(did)
  if (known !== undefined) return known
  const taken = new Set(clockIds.values())
  let free: number[] = []
  for (let i = 0; i < CLOCK_IDS; i++) {
    if (!taken.has(i)) free.push(i)
  }
  if (free.length === 0) {
    free = Array.from({length: CLOCK_IDS}, (_, i) => i)
  }
  const id = free[randomBelow(free.length)]
  clockIds.set(did, id)
  return id
}

/**
 * The next TID for `did`: newer than `prev` when given, and newer than every
 * TID this page made for `did`.
 */
export function nextTid(did: string, prev?: TID): TID {
  if (!PER_ACCOUNT_TID_CLOCK) {
    // Stock, for bisecting only.
    return TID.next(prev)
  }
  const clock = clockIdFor(did)

  // Stock's `TID.next` arithmetic, on this account's own entries.
  const last = lastMs.get(did) ?? 0
  const time = Math.max(Date.now(), last)
  let count = counts.get(did) ?? 0
  if (time === last) {
    count += 1
    counts.set(did, count)
  }
  lastMs.set(did, time)
  let t = time * 1000 + count

  // Stock's own `prev` rule.
  if (prev !== undefined && t <= prev.timestamp()) {
    t = prev.timestamp() + 1
  }
  // Strictly increasing per account, even just after a `prev` bump.
  const lastT = lastMicros.get(did)
  if (lastT !== undefined) {
    t = Math.max(t, lastT + 1)
  }
  lastMicros.set(did, t)
  return TID.fromTime(t, clock)
}

/** `nextTid` on strings. */
export function nextTidStr(did: string, prev?: string): string {
  if (!PER_ACCOUNT_TID_CLOCK) {
    return TID.nextStr(prev)
  }
  return nextTid(
    did,
    prev === undefined ? undefined : TID.fromStr(prev),
  ).toString()
}
