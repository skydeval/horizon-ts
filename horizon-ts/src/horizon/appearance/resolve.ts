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
import {
  type Appearance,
  type AppearanceField,
  DEFAULT_APPEARANCE,
  isThemePrefField,
} from '#/horizon/appearance/model'
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

export function unionFields(
  a: readonly AppearanceField[],
  b: readonly AppearanceField[],
): AppearanceField[] {
  return [...new Set([...a, ...b])]
}

/**
 * Fold `fallback` into `pending` (removed members design, section 5): the
 * fields edited on this device since a removal join `pending.fields`, with
 * this device's value, so whatever row the copy meets next keeps them. With
 * no field named, `pending` is left as it is, so prism's own value is never
 * put back. `fallback` is dropped; `pending` is durable, so nothing is lost.
 */
export function mergeFallback(
  copy: AccountCopy,
  device: Appearance,
): AccountCopy {
  const fallback = copy.fallback
  if (!fallback) return copy
  const pending = copy.pending
  const fields = unionFields(pending?.fields ?? [], fallback.fields)
  if (fields.length === 0) return {...copy, fallback: null}
  return {
    ...copy,
    fallback: null,
    pending: {
      ...pending,
      fields,
      appearance: pending?.appearance ?? copy.record ?? device,
      seq: (pending?.seq ?? 0) + 1,
    },
  }
}

/**
 * Apply one prism answer (section 4): `store`, `storeKnown`, `rev` and the
 * value are stored, and `pending` is rebased onto the row's value, or onto
 * this device's own copy when the row says `device`. With no row only `rev`
 * changes (`''`); the member table decides the rest. A retained row is never
 * applied as the live copy: only its `rev` is stored, so a put swaps on it.
 *
 * A live row ends anything left from a removal (removed members design,
 * section 5): the edits made since are merged first with `private` (and
 * rebased onto prism's value with the rest of `pending`), and dropped with
 * `public` (they were made under "This device only", so they aren't
 * published) and `device` (the copy already holds them). `device` is this
 * device's own appearance, for a copy with no value.
 */
export function applyPrismAnswer(
  copy: AccountCopy,
  answer: PrismAppearanceAnswer,
  now: number = Date.now(),
  device: Appearance = DEFAULT_APPEARANCE,
): AccountCopy {
  if (!answer.row) {
    if (answer.retained) return {...copy, rev: answer.retained.rev}
    return {...copy, rev: '', syncedAt: now}
  }
  const merged =
    answer.store === 'private'
      ? mergeFallback(copy, device)
      : {...copy, fallback: null}
  const value = answer.store === 'device' ? null : answer.value
  const record = value ? value.appearance : merged.record
  const raw = value ? value.raw : merged.raw
  return {
    ...merged,
    store: answer.store,
    storeKnown: true,
    rev: answer.rev,
    record,
    raw: record ? (raw ?? {}) : null,
    cid: null,
    syncedAt: now,
    pending: rebased(merged.pending, record),
    memberDevice: answer.store === 'device',
    // The next member row answered clears the removal's notes (8.4).
    removalNoted: false,
    removalLine: false,
    removalTaken: false,
    // A member replaces or follows the row; no release is sent.
    take: null,
    fallback: null,
    // A row exists: the migration is no longer blocked by size.
    tooLarge: false,
    tooLargeLine: false,
  }
}

/**
 * Whether a copy meeting a retained row `rev` takes its value rather than
 * putting its own (removed members design, section 5, step 1): a copy with
 * no `fallback` never learned of the removal, so its copy is its last member
 * read; a take still at `fetch` never imported; and a `fallback.rev` that is
 * set (`''` counts) and not `rev` means the copy holds another row.
 */
function importsRetained(copy: AccountCopy, rev: string): boolean {
  if (!copy.fallback) return true
  if (copy.take?.step === 'fetch') return true
  return copy.fallback.rev !== undefined && copy.fallback.rev !== rev
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
    const next = applyPrismAnswer(copy, answer, Date.now(), device)
    if (record && checkRecord) {
      const disagrees =
        answer.store === 'public'
          ? record.kind === 'none' || !sameRecordValue(record.raw, next.raw)
          : record.kind === 'record'
      if (disagrees) next.recordDue = true
    }
    return {copy: next, resolved: true}
  }
  /*
   * No live row (none, or a retained one): nothing is created before
   * `getRecord` answers (AS8-N2). Every put below swaps on the retained
   * row's `rev`, which replaces it and makes it live.
   */
  const retained = answer.retained
  const rowRev = retained?.rev ?? ''
  if (!record) {
    return {copy: {...copy, rev: rowRev, storeKnown: false}, resolved: false}
  }
  /*
   * Resolved: the copy is classified as it is, then anything left from a
   * removal is merged into `pending` and cleared in the same write
   * (removed members design, section 5).
   */
  const imports = retained ? importsRetained(copy, retained.rev) : false
  const base: AccountCopy = {
    ...mergeFallback(copy, device),
    rev: rowRev,
    storeKnown: true,
    take: null,
    fallback: null,
  }
  const pending = base.pending
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
      seq: nextSeq(base),
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
  if (retained?.store === 'device') {
    /*
     * A retained `device` row and no record: the account chose "This
     * device only" as a member. The copy stays, `pending` folds, and a put
     * `{store: device}` replaces the retained row.
     */
    const folded = foldPending(base)
    if (user) return {copy: folded, resolved: true}
    return {
      copy: {
        ...folded,
        store: 'device',
        pending: {
          fields: [],
          appearance: folded.record ?? device,
          seq: nextSeq(folded),
          store: 'device',
          auto: true,
        },
      },
      resolved: true,
    }
  }
  const value = retained?.value
  if (value && imports) {
    /*
     * A copy that doesn't hold the retained row (or anything newer) takes
     * its value, with this device's edits since the removal laid over it,
     * and puts it back as `private`. A `public` value is imported as a
     * value, never followed as a store (AS4-L1).
     */
    const fields = pending?.fields ?? []
    const current = pending?.appearance ?? base.record ?? device
    const next: PendingAppearance = {
      fields,
      appearance: rebase(value.appearance, current, fields),
      seq: nextSeq(base),
      store: user ?? 'private',
    }
    if (!user) next.auto = true
    return {
      copy: {...base, record: value.appearance, raw: value.raw, pending: next},
      resolved: true,
    }
  }
  if (value && base.record && base.store !== 'device') {
    /*
     * A copy that holds the retained row or newer: its own copy replaces
     * the row, so no retained row outlives a resolved run (RM2R2-N5). A
     * copy on `device` moves up below, as it would with no row.
     */
    if (user) return {copy: base, resolved: true}
    return {
      copy: {
        ...base,
        pending: {
          fields: pending?.fields ?? [],
          appearance: pending?.appearance ?? base.record,
          seq: nextSeq(base),
          store: 'private',
          auto: true,
        },
      },
      resolved: true,
    }
  }
  if (base.store === 'device') {
    if (user) return {copy: base, resolved: true}
    // 8.1, 8.5: keep `device` only on positive evidence.
    const target = base.memberDevice ? 'device' : 'private'
    return {
      copy: {
        ...base,
        pending: {
          fields: pending?.fields ?? [],
          appearance: pending?.appearance ?? base.record ?? device,
          seq: nextSeq(base),
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
