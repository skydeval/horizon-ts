/*
 * `app.nearhorizon.actor.appearance` (Phase 3 design, 5.1 and 5.2), written
 * by hand in the stock generated record shape. Public, one per account, rkey
 * `self`, in the account's own repo. The schema types writes and is used by
 * tests; reads parse leniently (`appearance/record.ts`) so one bad field
 * never loses the others.
 *
 * Change list 2 added, all optional: `pattern` on `#customBackdrop` (item
 * 7), and `colorMode`, `darkTheme`, `font` and `fontSize` on the record
 * (item 11). A field an account never set is absent, and a reader keeps
 * its own setting for it.
 */

import {l} from '@atproto/lex'

export const APPEARANCE_COLLECTION = 'app.nearhorizon.actor.appearance'
export const APPEARANCE_RKEY = 'self'

/** `#customBackdrop`. */
export type CustomBackdropRecord = {
  mode: 'solid' | 'twoTone' | l.UnknownString
  a: string
  b?: string
  /** A quiet pattern over a one-tone. */
  pattern?: 'dots' | 'grid' | 'lines' | l.UnknownString
}

/** `#preset`. */
export type PresetRecord = {
  slot: number
  name?: string
  custom: CustomBackdropRecord
  savedAt: l.DatetimeString
}

/** The record, as written. */
export type AppearanceRecord = {
  $type: 'app.nearhorizon.actor.appearance'
  version: number
  backdrop?: string
  custom?: CustomBackdropRecord
  presets?: PresetRecord[]
  /** The account's colour mode. */
  colorMode?: 'system' | 'light' | 'dark' | l.UnknownString
  /** The account's dark theme. */
  darkTheme?: 'dim' | 'dark' | l.UnknownString
  /** The account's font. */
  font?: 'system' | 'theme' | l.UnknownString
  /** The account's font size. */
  fontSize?: 'smaller' | 'default' | 'larger' | l.UnknownString
  updatedAt: l.DatetimeString
}

const customBackdrop = l.object({
  mode: l.string<{knownValues: ['solid', 'twoTone']}>(),
  a: l.string({minLength: 7, maxLength: 7}),
  b: l.optional(l.string({minLength: 7, maxLength: 7})),
  pattern: l.optional(
    l.string<{knownValues: ['dots', 'grid', 'lines']}>({maxLength: 32}),
  ),
})

const preset = l.object({
  slot: l.integer({minimum: 1, maximum: 10}),
  name: l.optional(l.string({maxLength: 640, maxGraphemes: 64})),
  custom: customBackdrop,
  savedAt: l.string({format: 'datetime'}),
})

export const appearanceRecord = l.record<'literal:self', AppearanceRecord>(
  'literal:self',
  APPEARANCE_COLLECTION,
  l.object({
    version: l.integer({minimum: 1}),
    backdrop: l.optional(l.string({maxLength: 64})),
    custom: l.optional(customBackdrop),
    presets: l.optional(l.array(preset, {maxLength: 10})),
    colorMode: l.optional(
      l.string<{knownValues: ['system', 'light', 'dark']}>({maxLength: 32}),
    ),
    darkTheme: l.optional(
      l.string<{knownValues: ['dim', 'dark']}>({maxLength: 32}),
    ),
    font: l.optional(
      l.string<{knownValues: ['system', 'theme']}>({maxLength: 32}),
    ),
    fontSize: l.optional(
      l.string<{knownValues: ['smaller', 'default', 'larger']}>({
        maxLength: 32,
      }),
    ),
    updatedAt: l.string({format: 'datetime'}),
  }),
)
