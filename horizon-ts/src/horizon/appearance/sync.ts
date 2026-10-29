/*
 * Saving the appearance (Phase 3 design, 6.4 and 6.5; appearance storage
 * choice design, sections 4 to 8). `AppearanceSync` registers the signed-in
 * account's PDS client, and its prism client, here; this module only ever
 * calls them for their own DID.
 *
 * One queue per DID (`inFlight`) runs everything that writes: the store's
 * resolution, the flush, the record step and a non-member's `cleanup`, so no
 * write's completion lands under another's state. Edits are debounced (1000
 * ms after the last one); a choice change runs the queue at once.
 *
 * Which table decides the store (`appearanceMode`):
 * - members of a prism listing `private.appearance`: prism's row, the single
 *   source of truth for the choice and the value. Every write is one
 *   `putAppearance` swapped on `rev` (5.1); the public record is written only
 *   from prism's answer, by the record step (5.3);
 * - everyone else, members included while prism doesn't list the feature:
 *   the record. A record means `public`, none means `device` (5.2). A
 *   `public` flush is never sent with a null CID (AS5-L2, AS6-L1);
 * - unresolved (nothing answered in this run): edits show and stay pending,
 *   and nothing is written (5.5).
 */

import {type Client} from '@atproto/lex'

import {logger} from '#/logger'
import {type AppearanceQueueContext} from '#/horizon/appearance/context'
import {
  type AccountCopy,
  type PendingAppearance,
} from '#/horizon/appearance/device-value'
import {verifyMigration} from '#/horizon/appearance/migration'
import {
  showChoiceRefused,
  showRecordBlocked,
  showTooLarge,
} from '#/horizon/appearance/notices'
import {
  appearanceMode,
  asksPrism,
  exceedsPrismCap,
  getPrismAppearance,
  isPrismRefusal,
  isPrismSizeRefusal,
  isPrismSwapFailure,
  type PrismAppearanceAnswer,
  putPrismAppearance,
  readPrismAnswer,
} from '#/horizon/appearance/prism'
import {buildAppearanceRecord} from '#/horizon/appearance/record'
import {runRecordStep} from '#/horizon/appearance/record-step'
import {runRemovalFlow} from '#/horizon/appearance/removal'
import {
  deleteAppearanceRecord,
  isPdsSwapFailure,
  isRecordNotFound,
  isTransientPdsError,
  putAppearanceRecord,
  readAppearanceRecord,
} from '#/horizon/appearance/repo'
import {
  applyPrismAnswer,
  landedPending,
  memberTable,
  nonMemberTable,
  type RecordAnswer,
  withoutPendingStore,
} from '#/horizon/appearance/resolve'
import {
  getAppearanceState,
  registerAppearanceSync,
  updateAccountCopy,
} from '#/horizon/appearance/store'
import {appearanceSyncs} from '#/horizon/appearance/sync-platform'
import {
  kickTake,
  resetTakeForTests,
  withFreshTake,
} from '#/horizon/appearance/take'
import {subscribePrismFeatures} from '#/horizon/routing/features'
import {subscribeMembership} from '#/horizon/routing/membership'
import {BACKDROPS} from '#/horizon/switches'

export {rebase} from '#/horizon/appearance/resolve'

/** The debounce after the last edit. */
export const FLUSH_DELAY_MS = 1000

/** How old a copy may be before a visibility change re-reads it. */
export const STALE_AFTER_MS = 5 * 60 * 1000

/** Swap retries per flush. */
const MAX_SWAP_RETRIES = 2

let registered: {did: string; client: Client; prism?: Client} | null = null
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inFlight = new Set<string>()
const again = new Set<string>()
let toastShown = false

/**
 * The record as last read in this run, per DID. `checked`: the member
 * table's disagreement check has used it (once per read, 5.3).
 */
const runRecord = new Map<string, {answer: RecordAnswer; checked: boolean}>()
/** prism's answer as last applied in this run, per DID. */
const runPrism = new Map<string, PrismAppearanceAnswer>()
/** The sequence number of the last prism request sent, per DID (5.4). */
const prismSent = new Map<string, number>()
/** The sequence number of the last prism answer applied, per DID (5.4). */
const prismApplied = new Map<string, number>()
/** A migration whose verify failed skips its record step this run (6). */
const skipRecordStep = new Set<string>()
/** The table last seen per DID, so a change runs the queue. */
const modeSeen = new Map<string, string>()
let unsubscribeAnswers: (() => void) | null = null

function enabled() {
  return appearanceSyncs() && BACKDROPS
}

function clientFor(did: string): Client | null {
  return registered && registered.did === did ? registered.client : null
}

function prismFor(did: string): Client | undefined {
  return registered && registered.did === did ? registered.prism : undefined
}

function copyOf(did: string): AccountCopy | undefined {
  return getAppearanceState().device.accounts[did]
}

function cancel(did: string) {
  const timer = timers.get(did)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(did)
}

/** Cancel every scheduled write. */
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

/** Run `did`'s queue now (a choice change, 5). */
export function flushNow(did: string) {
  if (!enabled()) return
  cancel(did)
  void flush(did)
}

registerAppearanceSync({scheduleFlush, flushNow})

/** A membership or feature answer changed: a new table runs the queue. */
function onAnswersChanged() {
  const did = registered?.did
  if (!did) return
  const {mode, removed} = appearanceMode(did)
  const key = `${mode}:${removed}`
  if (modeSeen.get(did) === key) return
  modeSeen.set(did, key)
  void flush(did)
}

/**
 * Register the signed-in account's PDS client and, for the member table,
 * its prism client. Timers for every other DID are cancelled; their pending
 * edits stay for when that account is current.
 */
export function registerAppearanceClient(
  did: string,
  client: Client,
  prism?: Client,
) {
  registered = {did, client, prism}
  for (const other of [...timers.keys()]) if (other !== did) cancel(other)
  if (!unsubscribeAnswers) {
    const offMembership = subscribeMembership(onAnswersChanged)
    const offFeatures = subscribePrismFeatures(onAnswersChanged)
    unsubscribeAnswers = () => {
      offMembership()
      offFeatures()
    }
  }
  const {mode, removed} = appearanceMode(did)
  modeSeen.set(did, `${mode}:${removed}`)
}

/** Forget the client (sign-out, or the sync host unmounting). */
export function unregisterAppearanceClient(did: string) {
  if (registered?.did === did) registered = null
  cancel(did)
}

function showBlockedOnce() {
  if (toastShown) return
  toastShown = true
  showRecordBlocked()
}

function takePrismSeq(did: string): number {
  const seq = (prismSent.get(did) ?? 0) + 1
  prismSent.set(did, seq)
  return seq
}

/**
 * Apply a prism answer (section 4) unless an answer to a later-sent prism
 * request was applied already (5.4). Returns whether it was applied.
 */
function applyPrism(
  did: string,
  seq: number,
  answer: PrismAppearanceAnswer,
): boolean {
  if (seq <= (prismApplied.get(did) ?? 0)) return false
  prismApplied.set(did, seq)
  runPrism.set(did, answer)
  const device = getAppearanceState().device.device
  updateAccountCopy(did, copy =>
    applyPrismAnswer(copy, answer, Date.now(), device),
  )
  return true
}

/** Read `getAppearance` and apply it; the latest applied answer, or undefined. */
async function readPrism(
  did: string,
  prism: Client,
): Promise<PrismAppearanceAnswer | undefined> {
  const seq = takePrismSeq(did)
  let body
  try {
    body = await getPrismAppearance(prism, did)
  } catch {
    return undefined
  }
  if (prismFor(did) !== prism) return undefined
  const answer = readPrismAnswer(body)
  if (!answer) return undefined
  applyPrism(did, seq, answer)
  return runPrism.get(did)
}

/**
 * Read the record into this run's answers. A read is dropped if the store
 * or the choice not yet landed changed while it was out (5.4), or the
 * account changed.
 */
async function readRecordInto(
  did: string,
  client: Client,
): Promise<RecordAnswer | undefined> {
  const before = copyOf(did)
  const store = before?.store ?? null
  const chosen = before?.pending?.store
  const answer = await readAppearanceRecord(client, did)
  if (!answer || clientFor(did) !== client) return undefined
  const now = copyOf(did)
  if ((now?.store ?? null) !== store || now?.pending?.store !== chosen) {
    return undefined
  }
  runRecord.set(did, {answer, checked: false})
  return answer
}

/**
 * Run the table that applies, with this run's answers. Synchronous; the
 * queue runs whatever it decides.
 */
function settle(did: string) {
  const {mode, removed} = appearanceMode(did)
  const read = runRecord.get(did)
  if (mode === 'member') {
    const answer = runPrism.get(did)
    if (!answer) return
    const check = !!read && !read.checked
    const device = getAppearanceState().device.device
    updateAccountCopy(
      did,
      copy => memberTable(copy, answer, read?.answer, check, device).copy,
    )
    if (read && check) read.checked = true
    return
  }
  if (mode === 'non-member') {
    // A copy last resolved as a member goes through the removal flow first.
    if ((copyOf(did)?.rev ?? null) !== null) return
    updateAccountCopy(did, copy =>
      withFreshTake(copy, nonMemberTable(copy, read?.answer).copy, removed),
    )
  }
}

/** The take, after a queue pass and outside it (removed members design, 6.4). */
function kick(did: string) {
  const client = clientFor(did)
  if (!client || appearanceMode(did).mode === 'unresolved') return
  void kickTake(did, {
    prism: prismFor(did),
    stillCurrent: () => clientFor(did) === client,
    nonMember: () => appearanceMode(did).mode === 'non-member',
  })
}

function contextFor(
  did: string,
  client: Client,
  prism?: Client,
): AppearanceQueueContext {
  return {
    did,
    client,
    getCopy: () => copyOf(did),
    update: change => updateAccountCopy(did, change),
    readPrism: () =>
      prism ? readPrism(did, prism) : Promise.resolve(undefined),
    readRecord: () => readAppearanceRecord(client, did),
    setRecordRead: answer => runRecord.set(did, {answer, checked: true}),
    stillCurrent: () => clientFor(did) === client,
    stillMember: () => appearanceMode(did).mode === 'member',
    retry: () => void flush(did),
    showBlocked: showBlockedOnce,
  }
}

/**
 * Read `did`'s record (and, from the persisted membership, its prism row)
 * and apply them with the table that applies. Returns whether the record
 * read succeeded. With `flushAfter`, the queue runs after (a pending edit
 * is written, a due record step runs).
 */
export async function refresh(
  did: string,
  {flushAfter = true}: {flushAfter?: boolean} = {},
): Promise<boolean> {
  if (!enabled()) return false
  const client = clientFor(did)
  if (!client) return false
  const prism = prismFor(did)
  const [record] = await Promise.all([
    readRecordInto(did, client),
    prism && asksPrism(did) ? readPrism(did, prism) : Promise.resolve(),
  ])
  if (clientFor(did) !== client) return false
  settle(did)
  if (flushAfter) void flush(did)
  return record !== undefined
}

/** A non-member's `cleanup` (7.3): needs only the PDS, whatever the membership. */
async function runCleanup(did: string, client: Client) {
  const cleanup = copyOf(did)?.cleanup
  if (!cleanup) return
  try {
    await deleteAppearanceRecord(client, did, cleanup.cid)
    updateAccountCopy(did, c => ({...c, cleanup: null}))
    runRecord.set(did, {answer: {kind: 'none'}, checked: true})
  } catch (error) {
    if (isRecordNotFound(error)) return
    if (isPdsSwapFailure(error)) {
      /*
       * The record changed: another device chose `public`. Stop, re-read
       * and derive again (AS1-L1).
       */
      updateAccountCopy(did, c => ({...c, cleanup: null}))
      runRecord.delete(did)
    }
  }
}

/**
 * Fold a landed `device` change, and any edit made since, into the copy: a
 * newer choice stays.
 */
function foldOnDevice(copy: AccountCopy, sentStore?: string): AccountCopy {
  const pending = copy.pending
  if (!pending) return copy
  const record = pending.fields.length > 0 ? pending.appearance : copy.record
  const newer = pending.store && pending.store !== sentStore
  return {
    ...copy,
    record,
    raw: record ? (copy.raw ?? {}) : null,
    pending: newer
      ? {...pending, fields: [], appearance: record ?? pending.appearance}
      : null,
  }
}

/** The non-member flush (5.2). */
async function nonMemberFlush(
  did: string,
  client: Client,
  retries: number,
): Promise<'done' | 'retry'> {
  let copy = copyOf(did)
  if (!copy?.storeKnown) return 'done'
  // Never a `public` flush with a null CID: the derivation gives `device`.
  if (copy.store === 'public' && !copy.cid) {
    updateAccountCopy(did, c => ({...c, store: 'device'}))
    copy = copyOf(did)
    if (!copy) return 'done'
  }
  const sent = copy.pending
  if (!sent) return 'done'
  // "Private, synced" isn't offered to non-members (8.3 step 4).
  const chosen = sent.store === 'private' ? 'device' : sent.store
  const target = chosen ?? copy.store
  if (target === 'device' && copy.store === 'device') {
    updateAccountCopy(did, c => foldOnDevice(c, sent.store))
    return 'done'
  }
  // While a delete is still to land, the record is never written (7.3).
  if (copy.cleanup) return 'done'
  if (copy.store === 'public' && target === 'device') {
    const cid = copy.cid as string
    let failed = false
    try {
      await deleteAppearanceRecord(client, did, cid)
      runRecord.set(did, {answer: {kind: 'none'}, checked: true})
    } catch {
      failed = true
    }
    updateAccountCopy(did, c => ({
      ...foldOnDevice(c, sent.store),
      store: 'device',
      storeKnown: true,
      cid: null,
      cleanup: failed ? {cid} : c.cleanup,
    }))
    return 'done'
  }
  if (target !== 'public' || copy.blocked) return 'done'
  const create = copy.store !== 'public'
  // A create writes every field: there is no record to keep fields from.
  const record = buildAppearanceRecord(
    create ? null : copy.raw,
    sent.appearance,
    sent.fields,
    new Date(),
  )
  let cid: string
  try {
    cid = await putAppearanceRecord(
      client,
      did,
      record,
      create ? null : copy.cid,
    )
  } catch (error) {
    if (isPdsSwapFailure(error)) {
      if (retries >= MAX_SWAP_RETRIES) return 'done'
      // Re-read and derive again: no record gives `device` (AS5-L2).
      runRecord.delete(did)
      if (!(await readRecordInto(did, client))) return 'done'
      settle(did)
      return 'retry'
    }
    if (isTransientPdsError(error)) return 'done'
    updateAccountCopy(did, c => ({...c, blocked: true}))
    logger.warn('appearance: the PDS refused the appearance record', {
      safeMessage: error instanceof Error ? error.message : String(error),
    })
    showBlockedOnce()
    return 'done'
  }
  const {$type: _type, ...raw} = record
  let more = false
  updateAccountCopy(did, c => {
    const pending = landedPending(c.pending, sent)
    more = pending !== null
    return {
      ...c,
      store: 'public',
      storeKnown: true,
      record: sent.appearance,
      raw,
      cid,
      syncedAt: Date.now(),
      pending,
    }
  })
  runRecord.set(did, {
    answer: {kind: 'record', appearance: sent.appearance, raw, cid},
    checked: true,
  })
  if (more) scheduleFlush(did)
  return 'done'
}

/**
 * After an `InvalidSwap` re-read (5.1): an `auto` choice is dropped (the
 * row exists now, and `recordDue` is set as for a landed `auto` put); a
 * user's `public` is dropped when another device changed the store since
 * this one read it (AS8-N4). Anything else is kept.
 */
function afterSwapFailure(
  did: string,
  before: AccountCopy['store'],
  reread: PrismAppearanceAnswer,
) {
  if (!reread.row) return
  let refused = false
  updateAccountCopy(did, c => {
    const pending = c.pending
    if (!pending?.store) return c
    if (pending.auto) {
      return {...c, pending: withoutPendingStore(pending), recordDue: true}
    }
    if (pending.store === 'public' && reread.store !== before) {
      refused = true
      return {...c, pending: withoutPendingStore(pending)}
    }
    return c
  })
  if (refused) showChoiceRefused()
}

/**
 * prism refused (or would refuse) the value for its size, 16 KiB:
 * - the migration's `auto` put: marked `tooLarge`, durably, so it isn't
 *   tried again at every sign-in. The account stays public and the record
 *   is untouched. The note's line shows once per account on this device;
 * - a user's choice: the old choice stays, with the same text as a toast;
 * - an edit with no choice change: `blocked`, as any refused edit.
 * A migration refused (no row, the record still public) marks `tooLarge`
 * whichever put it was, so only a later edit or choice tries it again.
 */
function refusedTooLarge(did: string, sent: PendingAppearance) {
  let toast = false
  let warn = false
  updateAccountCopy(did, c => {
    const next: AccountCopy = {...c}
    if (c.rev === '' && c.store === 'public') {
      next.noteDue = false
      next.tooLarge = true
      if (sent.auto && !c.tooLarge) next.tooLargeLine = true
    }
    if (sent.auto) {
      if (c.pending?.auto) next.pending = withoutPendingStore(c.pending)
    } else if (sent.store) {
      if (c.pending?.store === sent.store) {
        next.pending = withoutPendingStore(c.pending)
        toast = true
      }
    } else {
      next.blocked = true
      warn = true
    }
    return next
  })
  if (toast) showTooLarge()
  if (warn) showBlockedOnce()
}

/** Whether prism's last answer applied in this run was a retained row. */
function lastAnswerRetained(did: string): boolean {
  const answer = runPrism.get(did)
  return !!answer && !answer.row && !!answer.retained
}

/** The member flush (5.1): one put, swapped on `rev`. */
async function memberFlush(
  did: string,
  prism: Client,
  retries: number,
): Promise<'done' | 'retry'> {
  const copy = copyOf(did)
  if (!copy?.storeKnown) return 'done'
  const sent = copy.pending
  if (!sent) return 'done'
  const target = sent.store ?? copy.store
  if (!target) return 'done'
  /*
   * `device` on both sides folds and sends nothing, except over a retained
   * row: the put `{store: device}` has to reach prism, or the row expires.
   */
  if (
    target === 'device' &&
    copy.store === 'device' &&
    copy.rev !== '' &&
    !lastAnswerRetained(did)
  ) {
    updateAccountCopy(did, c => foldOnDevice(c, sent.store))
    return 'done'
  }
  // An edit prism refused for good waits for the next app start.
  if (copy.blocked && !sent.store) return 'done'
  /*
   * A row's value keeps the fields it holds; a move up from `device`, or a
   * first put with no row's value, writes every field of this device's copy.
   */
  const raw =
    copy.store === 'private' || copy.store === 'public' ? copy.raw : null
  const appearance =
    target === 'device'
      ? undefined
      : buildAppearanceRecord(raw, sent.appearance, sent.fields, new Date())
  const before = copy.store
  const migrating = !!sent.auto && target === 'private' && copy.noteDue
  // A value over prism's cap is refused before it is sent.
  if (appearance && exceedsPrismCap(appearance)) {
    refusedTooLarge(did, sent)
    return 'done'
  }
  const seq = takePrismSeq(did)
  let body
  try {
    body = await putPrismAppearance(prism, did, {
      store: target,
      appearance,
      swapRev: copy.rev ?? '',
    })
  } catch (error) {
    if (prismFor(did) !== prism) return 'done'
    if (isPrismSwapFailure(error)) {
      if (retries >= MAX_SWAP_RETRIES) return 'done'
      const reread = await readPrism(did, prism)
      if (!reread) return 'done'
      afterSwapFailure(did, before, reread)
      return 'retry'
    }
    if (isPrismRefusal(error)) {
      logger.warn('appearance: prism refused the appearance put', {
        safeMessage: error instanceof Error ? error.message : String(error),
      })
      if (isPrismSizeRefusal(error)) {
        refusedTooLarge(did, sent)
      } else if (sent.store) {
        // 7.1: the radio reverts.
        let reverted = false
        updateAccountCopy(did, c => {
          if (c.pending?.store !== sent.store) return c
          reverted = true
          return {...c, pending: withoutPendingStore(c.pending)}
        })
        if (reverted) showChoiceRefused()
      } else {
        updateAccountCopy(did, c => ({...c, blocked: true}))
        showBlockedOnce()
      }
    }
    // Anything else keeps `pending`; `NotEnrolled` starts the removal flow.
    return 'done'
  }
  if (prismFor(did) !== prism) return 'done'
  const answer = readPrismAnswer(body)
  if (!answer) return 'done'
  const applied = applyPrism(did, seq, answer)
  const due =
    (answer.row && answer.store === 'public') ||
    before === 'public' ||
    !!sent.auto
  let more = false
  updateAccountCopy(did, c => {
    let next: AccountCopy = {...c, pending: landedPending(c.pending, sent)}
    if (target === 'device' && sent.fields.length > 0) {
      // `device`: the edit folds into this device's own copy.
      next = {...next, record: sent.appearance, raw: next.raw ?? {}}
    } else if (!applied && appearance) {
      // A later read was applied first: show what landed until re-read.
      const {$type: _type, ...sentRaw} = appearance
      next = {...next, record: sent.appearance, raw: sentRaw}
    }
    if (due) next.recordDue = true
    more = next.pending !== null
    return next
  })
  if (migrating && appearance && !verifyMigration(appearance, answer)) {
    logger.error('appearance: prism answered a different migrated value', {
      safeMessage: 'migration verify mismatch',
    })
    updateAccountCopy(did, c => ({...c, noteDue: false}))
    skipRecordStep.add(did)
  }
  if (!applied) void readPrism(did, prism)
  if (more) scheduleFlush(did)
  return 'done'
}

async function nonMemberAttempt(
  did: string,
  client: Client,
  retries: number,
  removed: boolean,
): Promise<'done' | 'retry'> {
  if ((copyOf(did)?.rev ?? null) !== null) {
    const finished = await runRemovalFlow(contextFor(did, client), removed)
    if (!finished) return 'done'
  }
  if (!runRecord.has(did)) {
    if (!(await readRecordInto(did, client))) return 'done'
  }
  settle(did)
  return nonMemberFlush(did, client, retries)
}

async function memberAttempt(
  did: string,
  client: Client,
  prism: Client,
  retries: number,
): Promise<'done' | 'retry'> {
  if (!runPrism.has(did)) {
    if (!(await readPrism(did, prism))) return 'done'
  }
  // The migration and a first move-up need the record answered (AS8-N2).
  if (!runPrism.get(did)?.row && !runRecord.has(did)) {
    if (!(await readRecordInto(did, client))) return 'done'
  }
  settle(did)
  const outcome = await memberFlush(did, prism, retries)
  if (outcome === 'retry') return 'retry'
  if (!skipRecordStep.has(did)) {
    await runRecordStep(contextFor(did, client, prism))
  }
  return 'done'
}

/**
 * One pass of the queue: 'retry' after a swap failure whose re-read
 * succeeded, within the retry budget; 'done' otherwise (written, nothing to
 * write, or kept pending for the next trigger).
 */
async function attempt(
  did: string,
  client: Client,
  retries: number,
): Promise<'done' | 'retry'> {
  if (copyOf(did)?.cleanup) await runCleanup(did, client)
  if (clientFor(did) !== client) return 'done'
  const {mode, removed} = appearanceMode(did)
  if (mode === 'unresolved') return 'done'
  if (mode === 'non-member') {
    return nonMemberAttempt(did, client, retries, removed)
  }
  const prism = prismFor(did)
  if (!prism) return 'done'
  return memberAttempt(did, client, prism, retries)
}

/**
 * Run `did`'s queue when signed in as `did`: resolve the store, write a
 * pending edit or choice, run a due record step or cleanup. One run is in
 * flight per DID; a run asked for meanwhile follows it.
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
  } else {
    kick(did)
  }
}

/** Whether `did`'s copy is old enough to re-read on a visibility change. */
export function isStale(did: string, now: number = Date.now()) {
  const copy = getAppearanceState().device.accounts[did]
  return !copy || now - copy.syncedAt > STALE_AFTER_MS
}

/** Tests only: forget this run's answers too (a relaunch). */
export function resetAppearanceSyncForTests() {
  cancelAllFlushes()
  registered = null
  inFlight.clear()
  again.clear()
  toastShown = false
  runRecord.clear()
  runPrism.clear()
  prismSent.clear()
  prismApplied.clear()
  skipRecordStep.clear()
  modeSeen.clear()
  resetTakeForTests()
  unsubscribeAnswers?.()
  unsubscribeAnswers = null
  registerAppearanceSync({scheduleFlush, flushNow})
}
