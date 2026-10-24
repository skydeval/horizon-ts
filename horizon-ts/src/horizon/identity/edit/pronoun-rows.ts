/*
 * The pronoun set editor's model (Phase 5 design 7.1, 7.2), pure. A row is
 * one set, typed as forms separated by `/`; nothing else splits a form, so
 * commas, middle dots and spaces inside a form survive (2.3 item 4). A row
 * the user has not touched keeps its forms exactly as read, so a form such
 * as "he/him" that another client wrote as one form is not split on save
 * (P5R1-N6, pronouns spec rule 4). Forms over their limit are refused with
 * a note, never cut.
 */

import {countGraphemes} from 'unicode-segmenter/grapheme'

/** One set as the editor holds it. */
export type PronounRow = {
  /** A key for the list, stable across edits. */
  key: string
  /** What the user sees and types. */
  text: string
  /**
   * The forms as read, while the row is untouched; cleared by the first
   * edit.
   */
  original?: string[]
  /** The index of the set in the record read, while untouched. */
  from?: number
}

/** A set to write: its forms, and the index of the set it came from. */
export type PronounSetInput = {forms: string[]; from?: number}

/** Limits of one pronouns field (design 4.1). */
export type PronounLimits = {
  sets: number
  forms: number
  graphemes: number
  bytes: number
}

/** `app.nearhorizon.actor.pronouns`: 10 sets of 1 to 12 forms. */
export const ACCOUNT_PRONOUN_LIMITS: PronounLimits = {
  sets: 10,
  forms: 12,
  graphemes: 24,
  bytes: 64,
}

/**
 * A member's pronouns: the stricter of the member lexicon (6 sets of 6
 * forms, 240 bytes) and the pronouns spec (64 bytes), as 4.1 asks.
 */
export const MEMBER_PRONOUN_LIMITS: PronounLimits = {
  sets: 6,
  forms: 6,
  graphemes: 24,
  bytes: 64,
}

/**
 * The preset chips (7.1, 7.4). They are values written into the record, in
 * the user's own words, so they are not translated. "any" and "ask me" are
 * one-form sets.
 */
export const PRONOUN_PRESETS: readonly string[] = [
  'she/her',
  'he/him',
  'they/them',
  'she/they',
  'he/they',
  'it/its',
  'xe/xem',
  'ze/zir',
  'fae/faer',
  'ey/em',
  'any',
  'ask me',
]

let nextKey = 0

function newKey(): string {
  nextKey += 1
  return `row-${nextKey}`
}

/** The rows of sets as read: untouched, each keeping its forms. */
export function rowsFromSets(
  sets: readonly (readonly string[])[],
): PronounRow[] {
  return sets.map((forms, from) => ({
    key: newKey(),
    text: forms.join('/'),
    original: [...forms],
    from,
  }))
}

/** A new row (empty, or from a preset chip). */
export function newRow(text = ''): PronounRow {
  return {key: newKey(), text}
}

/** The row after the user typed `text`: no longer untouched. */
export function editRow(row: PronounRow, text: string): PronounRow {
  return {key: row.key, text}
}

/** A row's forms: as read when untouched, else split on `/` and trimmed. */
export function rowForms(row: PronounRow): string[] {
  if (row.original) return row.original
  return row.text
    .split('/')
    .map(form => form.trim())
    .filter(form => form.length > 0)
}

/** The sets to write. Rows with no forms (blank) are left out. */
export function setsFromRows(rows: readonly PronounRow[]): PronounSetInput[] {
  const sets: PronounSetInput[] = []
  for (const row of rows) {
    const forms = rowForms(row)
    if (forms.length === 0) continue
    sets.push(
      row.original && row.from !== undefined
        ? {forms, from: row.from}
        : {forms},
    )
  }
  return sets
}

/** Whether two lists of sets hold the same forms in the same order. */
export function sameSets(
  a: readonly {forms: readonly string[]}[] | readonly (readonly string[])[],
  b: readonly {forms: readonly string[]}[] | readonly (readonly string[])[],
): boolean {
  const formsOf = (set: {forms: readonly string[]} | readonly string[]) =>
    Array.isArray(set) ? set : (set as {forms: readonly string[]}).forms
  if (a.length !== b.length) return false
  return a.every((set, i) => {
    const x = formsOf(set)
    const y = formsOf(b[i])
    return x.length === y.length && x.every((form, j) => form === y[j])
  })
}

/** Why one row cannot be written. */
export type RowProblem =
  {kind: 'formTooLong'; form: string} | {kind: 'tooManyForms'}

function bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Whether a form is within `limits`. */
export function formFits(form: string, limits: PronounLimits): boolean {
  return countGraphemes(form) <= limits.graphemes && bytes(form) <= limits.bytes
}

/** One row's problem under `limits`, or `null`. */
export function rowProblem(
  row: PronounRow,
  limits: PronounLimits,
): RowProblem | null {
  const forms = rowForms(row)
  const long = forms.find(form => !formFits(form, limits))
  if (long !== undefined) return {kind: 'formTooLong', form: long}
  if (forms.length > limits.forms) return {kind: 'tooManyForms'}
  return null
}

/** Whether the rows can be written: every row fits, and not too many sets. */
export function rowsValid(
  rows: readonly PronounRow[],
  limits: PronounLimits,
): boolean {
  if (setsFromRows(rows).length > limits.sets) return false
  return rows.every(row => rowProblem(row, limits) === null)
}

/** Whether sets to write break `limits` (the write path's own check). */
export function setsValid(
  sets: readonly PronounSetInput[],
  limits: PronounLimits,
): boolean {
  if (sets.length > limits.sets) return false
  return sets.every(
    set =>
      set.forms.length >= 1 &&
      set.forms.length <= limits.forms &&
      set.forms.every(form => formFits(form, limits)),
  )
}

/** Move the row at `index` by `delta` (reorder); out of range is a no-op. */
export function moveRow(
  rows: readonly PronounRow[],
  index: number,
  delta: -1 | 1,
): PronounRow[] {
  const to = index + delta
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) {
    return [...rows]
  }
  const next = [...rows]
  const [row] = next.splice(index, 1)
  next.splice(to, 0, row)
  return next
}
