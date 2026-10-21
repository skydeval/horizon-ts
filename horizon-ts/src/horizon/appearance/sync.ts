/*
 * Reading and writing the appearance record (Phase 3 design, 6.4 and 6.5).
 * `AppearanceSync` registers the signed-in account's PDS client here; this
 * module only ever calls that client for its own DID. Writes are debounced
 * (1000 ms after the last edit), one in flight per DID, swapped on the CID
 * last read, and replace only the fields an edit named.
 */

import {type Client, type LexMap, XrpcResponseError} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'

import {logger} from '#/logger'
import * as Toast from '#/components/Toast'
import {type Appearance, isThemePrefField} from '#/horizon/appearance/model'
import {
  buildAppearanceRecord,
  parseAppearanceRecord,
} from '#/horizon/appearance/record'
import {
  getAppearanceState,
  registerAppearanceSync,
  updateAccountCopy,
} from '#/horizon/appearance/store'
import {
  APPEARANCE_COLLECTION,
  APPEARANCE_RKEY,
} from '#/horizon/lexicons/appearance'
import {APPEARANCE_SYNC, BACKDROPS} from '#/horizon/switches'
import {com} from '#/lexicons'

/** The debounce after the last edit. */
export const FLUSH_DELAY_MS = 1000

/** How old a copy may be before a visibility change re-reads it. */
export const STALE_AFTER_MS = 5 * 60 * 1000

/** Swap retries per flush. */
const MAX_SWAP_RETRIES = 2

let registered: {did: string; client: Client} | null = null
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inFlight = new Set<string>()
const again = new Set<string>()
let toastShown = false

function enabled() {
  return APPEARANCE_SYNC && BACKDROPS
}

function clientFor(did: string): Client | null {
  return registered && registered.did === did ? registered.client : null
}

function cancel(did: string) {
  const timer = timers.get(did)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(did)
}

/** Cancel every scheduled write (the opt-out turned on). */
export function cancelAllFlushes() {
  for (const did of [...timers.keys()]) cancel(did)
}

/** Write `did`'s pending edit 1000 ms after the last call. */
export function scheduleFlush(did: string) {
  if (!enabled()) return
  cancel(did)
  timers.set(
    did,
    setTimeout(() => {
      timers.delete(did)
      void flush(did)
    }, FLUSH_DELAY_MS),
  )
}

registerAppearanceSync({scheduleFlush, cancelAll: cancelAllFlushes})

/**
 * Register the signed-in account's client. Timers for every other DID are
 * cancelled; their pending edits stay for when that account is current.
 */
export function registerAppearanceClient(did: string, client: Client) {
  registered = {did, client}
  for (const other of [...timers.keys()]) if (other !== did) cancel(other)
}

/** Forget the client (sign-out, or the sync host unmounting). */
export function unregisterAppearanceClient(did: string) {
  if (registered?.did === did) registered = null
  cancel(did)
}

/** The pending fields of `pending` laid over a freshly read appearance. */
export function rebase(
  fresh: Appearance,
  pending: Appearance,
  fields: string[],
): Appearance {
  let out: Appearance = {...fresh, presets: [...fresh.presets]}
  for (const field of fields) {
    if (field === 'backdrop') out = {...out, backdrop: pending.backdrop}
    else if (field === 'custom') out = {...out, custom: pending.custom}
    else if (isThemePrefField(field)) {
      out = {...out, [field]: pending[field]}
      if (pending[field] === undefined) delete out[field]
    } else if (field.startsWith('preset:')) {
      const i = Number(field.slice('preset:'.length)) - 1
      if (i >= 0 && i < out.presets.length) out.presets[i] = pending.presets[i]
    }
  }
  return out
}

/**
 * Read `did`'s record and store it as the account's copy, rebasing a pending
 * edit onto it. Returns whether the read succeeded. Runs whether or not the
 * device is opted out. With `flushAfter`, a rebased pending edit is written
 * at once.
 */
export async function refresh(
  did: string,
  {flushAfter = true}: {flushAfter?: boolean} = {},
): Promise<boolean> {
  if (!enabled()) return false
  const client = clientFor(did)
  if (!client) return false
  let next: {
    record: Appearance | null
    raw: Record<string, unknown> | null
    cid: string | null
  }
  try {
    const res = await client.call(com.atproto.repo.getRecord, {
      repo: did as DidString,
      collection: APPEARANCE_COLLECTION,
      rkey: APPEARANCE_RKEY,
    })
    // Without a CID a write could not be swapped safely: keep the copy.
    if (!res.cid) return false
    const parsed = parseAppearanceRecord(res.value)
    next = parsed
      ? {record: parsed.appearance, raw: parsed.raw, cid: res.cid}
      : {record: null, raw: null, cid: null}
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      next = {record: null, raw: null, cid: null}
    } else {
      return false
    }
  }
  if (clientFor(did) !== client) return false
  let hasPending = false
  updateAccountCopy(did, copy => {
    const pending = copy.pending
    hasPending = pending !== null
    return {
      ...copy,
      ...next,
      syncedAt: Date.now(),
      // With no record the write is a full one of the pending appearance.
      pending:
        pending && next.record
          ? {
              ...pending,
              appearance: rebase(
                next.record,
                pending.appearance,
                pending.fields,
              ),
            }
          : pending,
    }
  })
  if (hasPending && flushAfter) void flush(did)
  return true
}

function isTransient(error: unknown) {
  if (!(error instanceof XrpcResponseError)) return true
  const status = error.status
  return status === 401 || status === 429 || status >= 500
}

function isSwapFailure(error: unknown) {
  return (
    error instanceof XrpcResponseError &&
    (error.error === 'InvalidSwap' || error.status === 404)
  )
}

function showBlockedToast() {
  if (toastShown) return
  toastShown = true
  Toast.show(
    t`Your appearance could not be saved to your account. It is saved on this device.`,
    {type: 'warning'},
  )
}

/**
 * One write attempt: 'retry' after a swap failure whose re-read succeeded,
 * within the retry budget; 'done' otherwise (written, nothing to write, or
 * kept pending for the next trigger).
 */
async function attempt(
  did: string,
  client: Client,
  retries: number,
): Promise<'done' | 'retry'> {
  const state = getAppearanceState().device
  let copy = state.accounts[did]
  if (state.optOut || !copy?.pending || copy.blocked) return 'done'
  if (copy.syncedAt === 0) {
    if (!(await refresh(did, {flushAfter: false}))) return 'done'
    copy = getAppearanceState().device.accounts[did]
  }
  const sent = copy?.pending
  if (!copy || !sent) return 'done'
  const record = buildAppearanceRecord(
    copy.raw,
    sent.appearance,
    sent.fields,
    new Date(),
  )
  let cid: string
  try {
    const res = await client.call(com.atproto.repo.putRecord, {
      repo: did as DidString,
      collection: APPEARANCE_COLLECTION,
      rkey: APPEARANCE_RKEY,
      // Horizon's fields plus values kept as read from the repo (lex values).
      record: record as LexMap,
      swapRecord: copy.cid,
    })
    cid = res.cid
  } catch (error) {
    if (isSwapFailure(error)) {
      if (retries >= MAX_SWAP_RETRIES) return 'done'
      return (await refresh(did, {flushAfter: false})) ? 'retry' : 'done'
    }
    if (isTransient(error)) return 'done'
    updateAccountCopy(did, c => ({...c, blocked: true}))
    logger.warn('appearance: the PDS refused the appearance record', {
      safeMessage: error instanceof Error ? error.message : String(error),
    })
    showBlockedToast()
    return 'done'
  }
  const {$type: _type, ...raw} = record
  let more = false
  updateAccountCopy(did, c => {
    more = c.pending !== null && c.pending.seq !== sent.seq
    return {
      ...c,
      record: sent.appearance,
      raw,
      cid,
      syncedAt: Date.now(),
      pending: more ? c.pending : null,
    }
  })
  if (more) scheduleFlush(did)
  return 'done'
}

/**
 * Write `did`'s pending edit, if any, when signed in as `did`, not opted
 * out and not blocked. A copy never read is read first, so a full write
 * never replaces a record this device has not seen. One write is in flight
 * per DID; a flush asked for meanwhile runs after it.
 */
export async function flush(did: string, retries = 0): Promise<void> {
  if (!enabled()) return
  const client = clientFor(did)
  if (!client) return
  if (inFlight.has(did)) {
    again.add(did)
    return
  }
  inFlight.add(did)
  let outcome: 'done' | 'retry' = 'done'
  try {
    outcome = await attempt(did, client, retries)
  } finally {
    inFlight.delete(did)
  }
  if (outcome === 'retry') {
    again.delete(did)
    await flush(did, retries + 1)
  } else if (again.delete(did)) {
    await flush(did)
  }
}

/** Whether `did`'s copy is old enough to re-read on a visibility change. */
export function isStale(did: string, now: number = Date.now()) {
  const copy = getAppearanceState().device.accounts[did]
  return !copy || now - copy.syncedAt > STALE_AFTER_MS
}

/** Tests only. */
export function resetAppearanceSyncForTests() {
  cancelAllFlushes()
  registered = null
  inFlight.clear()
  again.clear()
  toastShown = false
  registerAppearanceSync({scheduleFlush, cancelAll: cancelAllFlushes})
}
