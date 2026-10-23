/*
 * prism's side of "Save my appearance" (appearance storage choice design,
 * sections 3, 4 and 8.2): `getAppearance` and `putAppearance` through the
 * busy-prism wrappers, their answers parsed into one shape, and which table
 * decides an account's store in this run.
 *
 * Everything prism-backed is gated on `private.appearance`. Until prism lists
 * it, a member's store is decided as a non-member's is (the record versus
 * the device), no migration runs, and the setting offers two rows.
 */

import {type Client, type LexMap, XrpcResponseError} from '@atproto/lex'

import {logger} from '#/logger'
import {
  type AppearanceStore,
  parseStore,
} from '#/horizon/appearance/device-value'
import {type Appearance} from '#/horizon/appearance/model'
import {
  type BuiltAppearanceRecord,
  parseAppearanceRecord,
} from '#/horizon/appearance/record'
import {nearhorizon} from '#/horizon/lexicons'
import {
  reportedPrismCall,
  reportedPrismWrite,
} from '#/horizon/private/api/reads'
import {featuresAnswered, servesFeature} from '#/horizon/routing/features'
import {
  getMembership,
  isMembershipConfirmed,
} from '#/horizon/routing/membership'

export const APPEARANCE_FEATURE = 'private.appearance'

/** A row's value, parsed; null when prism's value doesn't parse. */
export type PrismAppearanceValue = {
  appearance: Appearance
  raw: Record<string, unknown>
} | null

/**
 * prism's feature for the 7-day retention (prism's reply): `includeRetained`,
 * `retainedUntil` and `releaseAppearance`.
 */
export const APPEARANCE_RETENTION_FEATURE = 'private.appearanceRetention'

/**
 * A row prism kept after a removal (removed members design, section 5):
 * never the live choice. `value` is null with `device`, or when it doesn't
 * parse.
 */
export type RetainedAppearance = {
  store: AppearanceStore
  rev: string
  value: PrismAppearanceValue
}

/**
 * One prism answer, from a get or a put (section 4). A retained row is
 * `row: false` with `retained`, so every site that tests `row` treats it as
 * no row.
 */
export type PrismAppearanceAnswer =
  | {row: false; retained?: RetainedAppearance}
  | {
      row: true
      store: AppearanceStore
      rev: string
      /** The value with `private` and `public`; null with `device`. */
      value: PrismAppearanceValue
    }

export type AnswerBody = {
  store?: string
  appearance?: unknown
  rev?: string
  retainedUntil?: string
}

/**
 * An answer body as Horizon reads it. Undefined for a `store` Horizon
 * doesn't know (a newer prism): read as unanswered, so nothing is written
 * under a choice this build can't follow. The same for a retained row.
 */
export function readPrismAnswer(
  body: AnswerBody,
): PrismAppearanceAnswer | undefined {
  const retained = body.retainedUntil !== undefined
  if (body.store === undefined) return {row: false}
  const store = parseStore(body.store)
  if (!store) {
    logger.warn('appearance: prism answered a store Horizon does not know', {
      safeMessage: String(body.store),
    })
    return undefined
  }
  const parsed =
    store === 'device' ? null : parseAppearanceRecord(body.appearance)
  const value = parsed ? {appearance: parsed.appearance, raw: parsed.raw} : null
  const rev = body.rev ?? ''
  if (retained) return {row: false, retained: {store, rev, value}}
  return {row: true, store, rev, value}
}

/**
 * The reader's row (`getAppearance`), always with `includeRetained`;
 * throws on any failure.
 */
export async function getPrismAppearance(
  prism: Client,
  did: string,
): Promise<AnswerBody> {
  const params = {includeRetained: true}
  const res = await reportedPrismCall(nearhorizon.privateGetAppearance, {
    did,
    params,
    send: signal =>
      prism.call(nearhorizon.privateGetAppearance, params, {signal}),
  })
  return res.body
}

/**
 * Release the row prism kept after a removal, swapped on `rev`
 * (`releaseAppearance`); throws on failure. `{}` also when nothing is kept.
 */
export async function releasePrismAppearance(
  prism: Client,
  did: string,
  rev: string,
): Promise<void> {
  await reportedPrismWrite(nearhorizon.privateReleaseAppearance, {
    did,
    send: () => prism.call(nearhorizon.privateReleaseAppearance, {rev}),
  })
}

/** One put (5.1): the whole value, swapped on `swapRev`; throws on failure. */
export async function putPrismAppearance(
  prism: Client,
  did: string,
  input: {
    store: AppearanceStore
    appearance?: BuiltAppearanceRecord
    swapRev: string
  },
): Promise<AnswerBody> {
  return reportedPrismWrite(nearhorizon.privatePutAppearance, {
    did,
    send: () =>
      prism.call(nearhorizon.privatePutAppearance, {
        store: input.store,
        ...(input.appearance
          ? {appearance: input.appearance as unknown as LexMap}
          : {}),
        swapRev: input.swapRev,
      }),
  })
}

function errorName(error: unknown): string | undefined {
  return error instanceof XrpcResponseError ? error.error : undefined
}

/** `InvalidSwap`: another device wrote since this one read (5.1). */
export function isPrismSwapFailure(error: unknown): boolean {
  return errorName(error) === 'InvalidSwap'
}

/** prism refused the put for good (`InvalidRequest`, 7.1). */
export function isPrismRefusal(error: unknown): boolean {
  return errorName(error) === 'InvalidRequest'
}

/**
 * prism's cap on the value: 16 KiB of compact JSON (prism's reply, "where it
 * differs"). The one refusal a legacy record can still hit.
 */
export const PRISM_APPEARANCE_MAX_BYTES = 16 * 1024

/** UTF-8 bytes of `text`, counted as prism counts its compact JSON. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (
      code >= 0xd800 &&
      code < 0xdc00 &&
      i + 1 < text.length &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/**
 * Whether prism would refuse `value` for its size. Checked before the put,
 * so a value that can't fit is never sent.
 */
export function exceedsPrismCap(value: BuiltAppearanceRecord): boolean {
  return utf8Length(JSON.stringify(value)) > PRISM_APPEARANCE_MAX_BYTES
}

/**
 * prism refused the value for its size (`InvalidRequest`, "appearance is
 * too large", or the 64 KiB body bound, "input is too large").
 */
export function isPrismSizeRefusal(error: unknown): boolean {
  return (
    isPrismRefusal(error) &&
    error instanceof Error &&
    /too large/i.test(error.message)
  )
}

/**
 * Which table decides `did`'s store in this run:
 * - `member`: membership `member` and the features answered in this run,
 *   with `private.appearance` listed: prism's row decides;
 * - `non-member`: `not-member` answered in this run (`removed`: the probe's
 *   `notEligible` or a private call's `NotEnrolled`, 8.2), or an answered
 *   membership whose features lack `private.appearance`: the record versus
 *   the device decides;
 * - `unresolved`: nothing answered yet in this run, or `indexing` with the
 *   feature listed (the move waits for `member`, 8.1).
 */
export function appearanceMode(did: string): {
  mode: 'member' | 'non-member' | 'unresolved'
  removed: boolean
} {
  if (!isMembershipConfirmed(did)) return {mode: 'unresolved', removed: false}
  const state = getMembership(did)
  if (state === 'not-member') return {mode: 'non-member', removed: true}
  if (state !== 'member' && state !== 'indexing') {
    return {mode: 'unresolved', removed: false}
  }
  if (!featuresAnswered(did)) return {mode: 'unresolved', removed: false}
  const listed = servesFeature(APPEARANCE_FEATURE, did)
  if (!listed) return {mode: 'non-member', removed: false}
  return state === 'member'
    ? {mode: 'member', removed: false}
    : {mode: 'unresolved', removed: false}
}

/**
 * Whether a sign-in read should ask prism too, in parallel with the record
 * (section 4): from the persisted membership and features. A launch with no
 * held list waits for the probe (the queue reads prism once the member table
 * applies), so a prism that doesn't list `private.appearance` is never sent
 * these methods.
 */
export function asksPrism(did: string): boolean {
  if (getMembership(did) === 'not-member') return false
  return servesFeature(APPEARANCE_FEATURE, did)
}

/**
 * Whether the setting offers "Private, synced": a member whose prism lists
 * `private.appearance` (by the held answer, for rendering).
 */
export function offersPrivateAppearance(did: string | undefined): boolean {
  return (
    !!did &&
    getMembership(did) === 'member' &&
    servesFeature(APPEARANCE_FEATURE, did)
  )
}
