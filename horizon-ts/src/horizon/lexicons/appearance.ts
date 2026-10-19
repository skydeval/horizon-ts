/*
 * `app.nearhorizon.actor.appearance` (Phase 3 design, 5.1 and 5.2), written
 * by hand in the stock generated record shape. Public, one per account, rkey
 * `self`, in the account's own repo. The schema types writes and is used by
 * tests; reads parse leniently (`appearance/record.ts`) so one bad field
 * never loses the others.
 */

import {l} from '@atproto/lex'

export const APPEARANCE_COLLECTION = 'app.nearhorizon.actor.appearance'
export const APPEARANCE_RKEY = 'self'

/** `#customBackdrop`. */
export type CustomBackdropRecord = {
  mode: 'solid' | 'twoTone' | l.UnknownString
  a: string
  b?: string
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
  updatedAt: l.DatetimeString
}

const customBackdrop = l.object({
  mode: l.string<{knownValues: ['solid', 'twoTone']}>(),
  a: l.string({minLength: 7, maxLength: 7}),
  b: l.optional(l.string({minLength: 7, maxLength: 7})),
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
    updatedAt: l.string({format: 'datetime'}),
  }),
)
