/*
 * The take (removed members design, section 6, simplified for pre-alpha; see
 * the implementation log). skydeval's rule: when a member is removed, prism
 * keeps their appearance for 7 days. The next time they sign in on a device,
 * Horizon copies it to that device and deletes prism's copy. If they are
 * signed in when removed, the copy happens then.
 *
 * - A take starts once per removal on a device: the removal flow starts it
 *   for a copy last resolved as a member (`removal.ts`), and `settle` for a
 *   device that never resolved the account (`withFreshTake`).
 * - At `fetch`, after each queue pass and outside the queue, prism is asked
 *   for the retained row (`getAppearance` with `includeRetained`): at most
 *   one answered ask per DID per run, one in flight, and an unanswered one
 *   again only after a minute. A retained value is copied here, with every
 *   field edited on this device since the removal kept (`fallback.fields`).
 * - At `release`, on a later launch once the wait has passed (a day on
 *   native, 8 days on web), the ask is repeated as a durability check and
 *   `releaseAppearance` deletes prism's copy. On web prism's 7-day expiry
 *   always comes first, so the ask answers `NotEnrolled` and nothing is
 *   released.
 * - A copy on `public` (a record followed, or Public chosen) ends the take:
 *   the record is the account's appearance, and prism's copy expires.
 *
 * Nothing a user saves waits on any of this: the non-member flush runs as
 * built, and the take never holds the queue.
 */

import {type Client, XrpcResponseError} from '@atproto/lex'

import {logger} from '#/logger'
import {IS_WEB} from '#/env'
import {
  type AccountCopy,
  type AppearanceTake,
} from '#/horizon/appearance/device-value'
import {showRemovalNote, showTakenNote} from '#/horizon/appearance/notices'
import {
  type AnswerBody,
  APPEARANCE_RETENTION_FEATURE,
  getPrismAppearance,
  isPrismSwapFailure,
  readPrismAnswer,
  releasePrismAppearance,
  type RetainedAppearance,
} from '#/horizon/appearance/prism'
import {rebase, unionFields} from '#/horizon/appearance/resolve'
import {getAppearanceState, updateStoredCopy} from '#/horizon/appearance/store'
import {
  classifyPrismCall,
  leadErrorOf,
} from '#/horizon/private/api/transient'
import {featuresAnswered, servesFeature} from '#/horizon/routing/features'
import {
  MEMBERSHIP_RECHECK_MIN_MS,
  requestMembershipRecheck,
} from '#/horizon/routing/membership'

/** How soon an unanswered ask may be sent again in the same run. */
export const TAKE_RETRY_MIN_MS = MEMBERSHIP_RECHECK_MIN_MS

/** The wait between the copy and the release on native: a day. */
export const RELEASE_WAIT_NATIVE_MS = 24 * 60 * 60 * 1000

/**
 * The wait on web: 8 days, which outlasts Safari's 7-day cap on
 * script-written storage. It also outlasts prism's 7-day retention, so on
 * web prism's expiry is the deletion.
 */
export const RELEASE_WAIT_WEB_MS = 8 * 24 * 60 * 60 * 1000

let webOverride: boolean | undefined

function releaseWaitMs(): number {
  return (webOverride ?? IS_WEB) ? RELEASE_WAIT_WEB_MS : RELEASE_WAIT_NATIVE_MS
}

/** One ask per DID in this run (memory only: a relaunch clears it). */
type Asked = {at: number; inFlight: boolean; answered: boolean}
const asked = new Map<string, Asked>()

/** What the take needs from the queue (`sync.ts`). */
export type TakeContext = {
  /** prism's client for the DID, at send time. */
  prism: Client | undefined
  /** Whether the account is still the signed-in one, on the same client. */
  stillCurrent: () => boolean
  /** Whether the non-member table applies in this run. */
  nonMember: () => boolean
}

/**
 * The never-resolved entry (removed members design, 6.1): a device that has
 * never resolved the account's store (no copy, or a copy a sign-out deleted)
 * starts a take on a removal answer, so a removed member's next sign-in on
 * a new device takes prism's copy too. `before` is the copy before this
 * derivation, `next` after it. Only on `device`: on `public` the record is
 * the account's appearance, and nothing is taken.
 */
export function withFreshTake(
  before: AccountCopy,
  next: AccountCopy,
  removed: boolean,
): AccountCopy {
  if (!removed || before.take || before.store !== null) return next
  if (!next.storeKnown || next.store !== 'device') return next
  return {
    ...next,
    take: {step: 'fetch', fresh: true, keptNote: false},
    fallback: {
      fields: unionFields(
        next.fallback?.fields ?? [],
        next.pending?.fields ?? [],
      ),
    },
  }
}

function sameTake(a: AppearanceTake | null, b: AppearanceTake): boolean {
  return !!a && a.step === b.step && a.rev === b.rev
}

/** The core's removal note (8.4), when the take says it is owed. */
function withKeptNote(
  copy: AccountCopy,
  take: AppearanceTake,
  notes: {kept: boolean},
): AccountCopy {
  if (!take.keptNote || copy.removalNoted) return copy
  notes.kept = true
  return {...copy, removalNoted: true, removalLine: true}
}

/**
 * Nothing retained (`NotEnrolled`, or a prism without the retention): the
 * device keeps its own copy. A fresh take forgets `fallback` too, so a
 * never-member's first join is as before; a removal-flow take keeps it for
 * the rejoin.
 */
function withNothingRetained(
  copy: AccountCopy,
  take: AppearanceTake,
  notes: {kept: boolean},
): AccountCopy {
  const next = {
    ...copy,
    take: null,
    fallback: take.fresh ? null : copy.fallback,
  }
  return take.step === 'fetch' ? withKeptNote(next, take, notes) : next
}

/**
 * The copy (removed members design, 6.5): prism's value, with this device's
 * value for every field edited here since the removal, in one write with
 * the take moved to `release` and the note's flags.
 */
function withCopy(
  copy: AccountCopy,
  take: AppearanceTake,
  retained: RetainedAppearance,
  value: NonNullable<RetainedAppearance['value']>,
  notes: {taken: boolean},
): AccountCopy {
  const device = getAppearanceState().device.device
  const fields = unionFields(
    copy.fallback?.fields ?? [],
    copy.pending?.fields ?? [],
  )
  const current = copy.pending?.appearance ?? copy.record ?? device
  const taken = !copy.removalNoted
  notes.taken = taken
  return {
    ...copy,
    record: rebase(value.appearance, current, fields),
    raw: value.raw,
    pending: null,
    take: {
      step: 'release',
      rev: retained.rev,
      copiedAt: Date.now(),
      keptNote: take.keptNote,
    },
    fallback: {fields, rev: retained.rev},
    removalNoted: true,
    removalLine: taken ? true : copy.removalLine,
    removalTaken: taken ? true : copy.removalTaken,
  }
}

type Answer =
  | {kind: 'retained'; retained: RetainedAppearance}
  | {kind: 'live'}
  | {kind: 'none'}
  | {kind: 'unreadable'}
  | {kind: 'refused'}

function answerOf(body: AnswerBody | undefined, error: unknown): Answer {
  if (body !== undefined) {
    if (body.retainedUntil === undefined) return {kind: 'live'}
    const read = readPrismAnswer(body)
    if (!read || read.row || !read.retained) return {kind: 'unreadable'}
    return {kind: 'retained', retained: read.retained}
  }
  const lead = leadErrorOf(error)
  if (lead instanceof XrpcResponseError && lead.error === 'NotEnrolled') {
    return {kind: 'none'}
  }
  return {kind: 'refused'}
}

function warn(message: string, detail: string) {
  logger.warn(`appearance: ${message}`, {safeMessage: detail})
}

/** End a take whose copy is on `public` (removed members design, 6.3). */
function endOnPublic(did: string, take: AppearanceTake) {
  updateStoredCopy(did, c => {
    if (!sameTake(c.take, take) || c.store !== 'public' || c.pending?.store) {
      return null
    }
    let fallback = c.fallback
    if (take.fresh) fallback = null
    else if (take.step === 'fetch' && fallback) {
      /*
       * The copy now holds the record's values and a member `rev` prism
       * never confirmed in this removal: at a rejoin it must not import
       * prism's row over them.
       */
      fallback = {fields: fallback.fields}
    }
    return {...c, take: null, fallback}
  })
}

/**
 * After each queue pass (`sync.ts`), not awaited: ask prism for the
 * retained row when the stored take is due, and act on the answer.
 */
export async function kickTake(did: string, ctx: TakeContext): Promise<void> {
  if (!ctx.nonMember()) {
    // A member pass: a later removal in this run asks afresh.
    asked.delete(did)
    return
  }
  const copy = getAppearanceState().device.accounts[did]
  const take = copy?.take
  if (!copy || !take) return
  if (copy.store === 'public' && !copy.pending?.store) {
    endOnPublic(did, take)
    return
  }
  // A choice in flight, or the record unanswered: the take waits.
  if (!copy.storeKnown || copy.pending?.store || copy.store !== 'device') return
  if (take.step === 'release') {
    if (Date.now() - (take.copiedAt ?? 0) < releaseWaitMs()) return
  }
  const prism = ctx.prism
  if (!prism) return
  if (
    featuresAnswered(did) &&
    !servesFeature(APPEARANCE_RETENTION_FEATURE, did)
  ) {
    // A prism without the retention keeps nothing: as `NotEnrolled`.
    const notes = {kept: false}
    updateStoredCopy(did, c =>
      sameTake(c.take, take) ? withNothingRetained(c, take, notes) : null,
    )
    if (notes.kept) showRemovalNote()
    return
  }
  const last = asked.get(did)
  const now = Date.now()
  if (last && (last.inFlight || last.answered)) return
  if (last && now - last.at < TAKE_RETRY_MIN_MS) return
  const entry: Asked = {at: now, inFlight: true, answered: false}
  asked.set(did, entry)
  let body: AnswerBody | undefined
  let error: unknown
  try {
    body = await getPrismAppearance(prism, did)
  } catch (caught) {
    error = caught
  }
  entry.inFlight = false
  if (asked.get(did) !== entry) return
  // Unanswered (down, busy, a timeout): a later pass asks again.
  if (body === undefined && classifyPrismCall(error) !== 'permanent') return
  const answer = answerOf(body, error)

  /*
   * Re-checked against the stored copy (another tab may have copied first,
   * or a choice landed meanwhile). A dropped answer counts as unanswered.
   */
  const out: {applies: boolean; release?: string; recheck: boolean} = {
    applies: false,
    recheck: false,
  }
  const notes = {kept: false, taken: false}
  updateStoredCopy(did, c => {
    out.applies =
      ctx.stillCurrent() &&
      ctx.nonMember() &&
      sameTake(c.take, take) &&
      c.store === 'device' &&
      c.storeKnown &&
      !c.pending?.store
    if (!out.applies) return null
    switch (answer.kind) {
      case 'none':
        return withNothingRetained(c, take, notes)
      case 'live':
        // A member again, and the probe hasn't said so yet.
        out.recheck = true
        return null
      case 'unreadable':
        warn('prism answered a retained appearance Horizon cannot read', did)
        return null
      case 'refused':
        warn(
          'prism refused the retained appearance read',
          error instanceof Error ? error.message : String(error),
        )
        return null
      case 'retained': {
        const {retained} = answer
        if (take.step === 'release') {
          if (retained.rev === take.rev) {
            out.release = retained.rev
            return null
          }
          /*
           * Another retained row: a later removal this device never saw.
           * The take starts again at `fetch`, and the next run copies it.
           */
          return {
            ...c,
            take: {step: 'fetch', keptNote: retained.store === 'private'},
            removalNoted: false,
          }
        }
        if (retained.store === 'device') {
          // The account chose "This device only": nothing to copy.
          return withKeptNote(
            {
              ...c,
              take: null,
              fallback: {fields: c.fallback?.fields ?? [], rev: retained.rev},
            },
            take,
            notes,
          )
        }
        const value = retained.value
        if (!value) {
          // Never copy or release a value this build can't read (AS1-N2).
          warn('prism retained an appearance Horizon cannot read', did)
          return null
        }
        return withCopy(c, take, retained, value, notes)
      }
    }
  })
  if (!out.applies) return
  entry.answered = true
  if (notes.taken) showTakenNote()
  if (notes.kept) showRemovalNote()
  if (out.recheck) requestMembershipRecheck(did, {force: true})
  if (out.release !== undefined) await sendRelease(did, prism, out.release)
}

/** Delete prism's copy (removed members design, 6.6). */
async function sendRelease(did: string, prism: Client, rev: string) {
  try {
    await releasePrismAppearance(prism, did, rev)
  } catch (error) {
    // Kept for the next launch: the wait has passed, so it asks again then.
    if (classifyPrismCall(error) !== 'permanent') return
    /*
     * `InvalidSwap`: the row changed (a rejoin replaced it). `InvalidRequest`:
     * a member again, whose device replaces the row. Either way prism's copy
     * is no longer this device's to release.
     */
    if (!isPrismSwapFailure(error)) {
      warn(
        'prism refused the appearance release',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  // `{}`, also when nothing was left to release: done.
  updateStoredCopy(did, c =>
    c.take?.step === 'release' && c.take.rev === rev ? {...c, take: null} : null,
  )
}

/** Tests only: forget this run's asks (a relaunch). */
export function resetTakeForTests() {
  asked.clear()
}

/** Tests only: the web wait (true), the native one (false), or the build's. */
export function setTakeWebForTests(web: boolean | undefined) {
  webOverride = web
}
