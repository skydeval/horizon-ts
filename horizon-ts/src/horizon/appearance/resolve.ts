/*
 * Store resolution (appearance storage choice design, section 4): the two
 * tables as pure functions over an account copy. Members: prism's row is the
 * single source of truth for the choice and the value, and the record is
 * read only for the migration and the record step's disagreement check.
 * Non-members: the record is the only truth; a record means `public`, none
 * means `device`. Every prism answer is applied the same way, from any path
 * (`applyPrismAnswer`).
 */

import {
  type AccountCopy,
  type PendingAppearance,
} from '#/horizon/appearance/device-value'
import {type Appearance, isThemePrefField} from '#/horizon/appearance/model'
import {type PrismAppearanceAnswer} from '#/horizon/appearance/prism'

/** A record read: the record with its CID, or none. */
export type RecordAnswer =
  | {
      kind: 'record'
      appearance: Appearance
      raw: Record<string, unknown>
      cid: string
    }
  | {kind: 'none'}

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

function rebased(
  pending: PendingAppearance | null,
  base: Appearance | null,
): PendingAppearance | null {
  if (!pending || !base) return pending
  return {
    ...pending,
    appearance: rebase(base, pending.appearance, pending.fields),
  }
}

/** Whether a record read is this device's own `cleanup` record (AS2-N2). */
function isOwnRecord(copy: AccountCopy, record: RecordAnswer): boolean {
  return record.kind === 'record' && record.cid !== copy.cleanup?.cid
}

/** Two record values (without `$type`) are the same. */
export function sameRecordValue(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): boolean {
  if (!a || !b) return a === b
  return stableJson(a) === stableJson(b)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, v]) => key !== '$type' && v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    return `{${entries
      .map(([key, v]) => `${JSON.stringify(key)}:${stableJson(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Apply one prism answer (section 4): `store`, `storeKnown`, `rev` and the
 * value are stored, and `pending` is rebased onto the row's value, or onto
 * this device's own copy when the row says `device`. With no row only `rev`
 * changes (`''`); the member table decides the rest.
 */
export function applyPrismAnswer(
  copy: AccountCopy,
  answer: PrismAppearanceAnswer,
  now: number = Date.now(),
): AccountCopy {
  if (!answer.row) return {...copy, rev: '', syncedAt: now}
  const value = answer.store === 'device' ? null : answer.value
  const record = value ? value.appearance : copy.record
  const raw = value ? value.raw : copy.raw
  return {
    ...copy,
    store: answer.store,
    storeKnown: true,
    rev: answer.rev,
    record,
    raw: record ? (raw ?? {}) : null,
    cid: null,
    syncedAt: now,
    pending: rebased(copy.pending, record),
    memberDevice: answer.store === 'device',
    // The next member row answered clears it (8.4).
    removalNoted: false,
    // A row exists: the migration is no longer blocked by size.
    tooLarge: false,
    tooLargeLine: false,
  }
}

function nextSeq(copy: AccountCopy): number {
  return (copy.pending?.seq ?? 0) + 1
}

/**
 * The member table (section 4). `record` is the record read in this run
 * (undefined: unanswered); `checkRecord` asks for the disagreement check,
 * once per read (5.3). `device` is this device's own appearance, for a copy
 * never read. Returns the next copy and whether the store is resolved.
 */
export function memberTable(
  copy: AccountCopy,
  answer: PrismAppearanceAnswer,
  record: RecordAnswer | undefined,
  checkRecord: boolean,
  device: Appearance,
): {copy: AccountCopy; resolved: boolean} {
  if (answer.row) {
    const next = applyPrismAnswer(copy, answer)
    if (record && checkRecord) {
      const disagrees =
        answer.store === 'public'
          ? record.kind === 'none' || !sameRecordValue(record.raw, next.raw)
          : record.kind === 'record'
      if (disagrees) next.recordDue = true
    }
    return {copy: next, resolved: true}
  }
  // No row: nothing is created before `getRecord` answers (AS8-N2).
  if (!record) {
    return {copy: {...copy, rev: '', storeKnown: false}, resolved: false}
  }
  const base: AccountCopy = {...copy, rev: '', storeKnown: true}
  const pending = copy.pending
  // A row creation already pending: nothing more to decide.
  if (pending?.auto) return {copy: base, resolved: true}
  const user = pending?.store
  if (record.kind === 'record' && isOwnRecord(copy, record)) {
    /*
     * A migration prism refused for its size is not tried again at sign-in:
     * the account stays public, the record untouched. An edit or a user's
     * choice tries again (the flush checks the size before any put).
     */
    if (copy.tooLarge && !user && !pending?.fields.length) {
      return {
        copy: {
          ...base,
          store: 'public',
          record: record.appearance,
          raw: record.raw,
          cid: null,
          noteDue: false,
        },
        resolved: true,
      }
    }
    /*
     * The migration (section 6): the record as the copy's value, any
     * pending edit rebased onto it, and a put of the result. A user's
     * choice made just before stands in for the `auto` store (8.1).
     */
    const target = user ?? 'private'
    const migrated: PendingAppearance = {
      fields: pending?.fields ?? [],
      appearance: pending
        ? rebase(record.appearance, pending.appearance, pending.fields)
        : record.appearance,
      seq: nextSeq(copy),
      store: target,
    }
    if (!user) migrated.auto = true
    return {
      copy: {
        ...base,
        store: 'public',
        record: record.appearance,
        raw: record.raw,
        cid: null,
        pending: migrated,
        noteDue: target === 'private',
      },
      resolved: true,
    }
  }
  if (copy.store === 'device') {
    if (user) return {copy: base, resolved: true}
    // 8.1, 8.5: keep `device` only on positive evidence.
    const target = copy.memberDevice ? 'device' : 'private'
    return {
      copy: {
        ...base,
        pending: {
          fields: pending?.fields ?? [],
          appearance: pending?.appearance ?? copy.record ?? device,
          seq: nextSeq(copy),
          store: target,
          auto: true,
        },
      },
      resolved: true,
    }
  }
  /*
   * The copy says `private` or `public` (a device that never learned of a
   * removal), or there is no copy: `private`, and nothing is put until the
   * first edit. Never a remembered `public` (AS4-L1).
   */
  return {copy: {...base, store: 'private'}, resolved: true}
}

/**
 * The non-member table (section 4): a record (not this device's `cleanup`
 * record) means `public`, with `pending` rebased onto it; none means
 * `device`. Undefined `record` (unanswered) leaves the store unresolved.
 */
export function nonMemberTable(
  copy: AccountCopy,
  record: RecordAnswer | undefined,
  now: number = Date.now(),
): {copy: AccountCopy; resolved: boolean} {
  if (!record) return {copy: {...copy, storeKnown: false}, resolved: false}
  if (record.kind === 'record' && isOwnRecord(copy, record)) {
    return {
      copy: {
        ...copy,
        store: 'public',
        storeKnown: true,
        record: record.appearance,
        raw: record.raw,
        cid: record.cid,
        syncedAt: now,
        pending: rebased(copy.pending, record.appearance),
      },
      resolved: true,
    }
  }
  return {
    copy: {...copy, store: 'device', storeKnown: true, cid: null, syncedAt: now},
    resolved: true,
  }
}

/**
 * Fold `pending` into the copy's own value (a `device` store keeps edits on
 * this device). A choice change not yet applied stays.
 */
export function foldPending(copy: AccountCopy): AccountCopy {
  const pending = copy.pending
  if (!pending) return copy
  const record = pending.fields.length > 0 ? pending.appearance : copy.record
  return {
    ...copy,
    record,
    raw: record ? (copy.raw ?? {}) : null,
    pending: pending.store
      ? {...pending, fields: [], appearance: record ?? pending.appearance}
      : null,
  }
}

/**
 * `pending` after a write of `sent` landed: cleared if nothing newer came
 * (its `seq` is the one sent), else kept without the landed choice.
 */
export function landedPending(
  current: PendingAppearance | null,
  sent: PendingAppearance,
): PendingAppearance | null {
  if (!current || current.seq === sent.seq) return null
  if (current.store === sent.store && !!current.auto === !!sent.auto) {
    const {store: _store, auto: _auto, ...rest} = current
    return rest.fields.length > 0 ? rest : null
  }
  return current
}

/** `pending` without its choice change; null when nothing else is left. */
export function withoutPendingStore(
  pending: PendingAppearance | null,
): PendingAppearance | null {
  if (!pending) return null
  const {store: _store, auto: _auto, ...rest} = pending
  return rest.fields.length > 0 ? rest : null
}
