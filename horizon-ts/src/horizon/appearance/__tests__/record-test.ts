import {describe, expect, it} from '@jest/globals'

import {
  type Appearance,
  DEFAULT_APPEARANCE,
  DEFAULT_CUSTOM,
  emptyPresetSlots,
} from '#/horizon/appearance/model'
import {
  buildAppearanceRecord,
  parseAppearanceRecord,
} from '#/horizon/appearance/record'
import {appearanceRecord} from '#/horizon/lexicons/appearance'

const NOW = new Date('2026-10-19T12:00:00.000Z')
const SAVED = '2026-10-18T10:00:00.000Z'

function full(overrides: Record<string, unknown> = {}) {
  return {
    $type: 'app.nearhorizon.actor.appearance',
    version: 1,
    backdrop: 'pride.trans',
    custom: {mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'},
    presets: [
      {
        slot: 1,
        custom: {mode: 'solid', a: '#112233', b: '#112233'},
        savedAt: SAVED,
      },
    ],
    updatedAt: SAVED,
    ...overrides,
  }
}

describe('the schema (T9)', () => {
  it('accepts a full record', () => {
    expect(appearanceRecord.safeValidate(full()).success).toBe(true)
  })

  it('rejects 11 presets, slot 0 and 11, an 8-character hex', () => {
    const preset = (slot: number) => ({
      slot,
      custom: {mode: 'solid', a: '#112233'},
      savedAt: SAVED,
    })
    const eleven = Array.from({length: 11}, () => preset(1))
    expect(appearanceRecord.safeValidate(full({presets: eleven})).success).toBe(
      false,
    )
    expect(
      appearanceRecord.safeValidate(full({presets: [preset(0)]})).success,
    ).toBe(false)
    expect(
      appearanceRecord.safeValidate(full({presets: [preset(11)]})).success,
    ).toBe(false)
    expect(
      appearanceRecord.safeValidate(
        full({custom: {mode: 'solid', a: '#1122334'}}),
      ).success,
    ).toBe(false)
  })
})

describe('parseAppearanceRecord (T9)', () => {
  it('null for a non-object or another type', () => {
    expect(parseAppearanceRecord(null)).toBeNull()
    expect(parseAppearanceRecord([1])).toBeNull()
    expect(parseAppearanceRecord({$type: 'app.bsky.feed.post'})).toBeNull()
  })

  it('reads a full record, raw without $type', () => {
    const parsed = parseAppearanceRecord(full())!
    expect(parsed.appearance.backdrop).toBe('pride.trans')
    expect(parsed.appearance.custom).toEqual(DEFAULT_CUSTOM)
    expect(parsed.appearance.presets[0]).toEqual({
      custom: {mode: 'solid', a: '#112233', b: '#112233'},
      savedAt: SAVED,
    })
    expect(parsed.appearance.presets.slice(1).every(p => p === null)).toBe(true)
    expect(parsed.raw.$type).toBeUndefined()
    expect(parsed.raw.version).toBe(1)
  })

  it('each field leniently', () => {
    expect(parseAppearanceRecord({backdrop: ''})!.appearance.backdrop).toBe(
      'none',
    )
    expect(
      parseAppearanceRecord({backdrop: 'x'.repeat(65)})!.appearance.backdrop,
    ).toBe('none')
    expect(
      parseAppearanceRecord({backdrop: 'future.one'})!.appearance.backdrop,
    ).toBe('future.one')
    expect(
      parseAppearanceRecord({custom: {mode: 'gradient', a: '#112233'}})!
        .appearance.custom,
    ).toEqual(DEFAULT_CUSTOM)
    expect(
      parseAppearanceRecord({custom: {mode: 'solid', a: '112233'}})!.appearance
        .custom,
    ).toEqual(DEFAULT_CUSTOM)
    expect(
      parseAppearanceRecord({custom: {mode: 'solid', a: '#aabbcc'}})!.appearance
        .custom,
    ).toEqual({
      mode: 'solid',
      a: '#AABBCC',
      b: '#AABBCC',
    })
    expect(
      parseAppearanceRecord({
        custom: {mode: 'twoTone', a: '#aabbcc', b: 'red'},
      })!.appearance.custom,
    ).toEqual(DEFAULT_CUSTOM)

    const presets = parseAppearanceRecord({
      presets: [
        {
          slot: 3,
          custom: {mode: 'solid', a: '#000001'},
          savedAt: SAVED,
          name: 'Mine',
        },
        {slot: 3, custom: {mode: 'solid', a: '#000002'}, savedAt: SAVED},
        {slot: 0, custom: {mode: 'solid', a: '#000003'}, savedAt: SAVED},
        {slot: 4.5, custom: {mode: 'solid', a: '#000003'}, savedAt: SAVED},
        {slot: 5, custom: {mode: 'solid', a: '#000004'}},
        {
          slot: 6,
          custom: {mode: 'solid', a: '#000005'},
          savedAt: SAVED,
          name: '',
        },
      ],
    })!.appearance.presets
    expect(presets[2]).toEqual({
      name: 'Mine',
      custom: {mode: 'solid', a: '#000001', b: '#000001'},
      savedAt: SAVED,
    })
    expect(presets[4]).toBeNull()
    expect(presets[5]).toEqual({
      custom: {mode: 'solid', a: '#000005', b: '#000005'},
      savedAt: SAVED,
    })
    expect(presets.filter(Boolean)).toHaveLength(2)
  })
})

describe('buildAppearanceRecord (T9)', () => {
  const appearance: Appearance = {
    backdrop: 'pride.ace',
    custom: {mode: 'solid', a: '#123456', b: '#654321'},
    presets: (() => {
      const slots = emptyPresetSlots()
      slots[2] = {
        custom: {mode: 'twoTone', a: '#000000', b: '#FFFFFF'},
        savedAt: SAVED,
      }
      return slots
    })(),
  }

  it('writes everything when the repo has no record', () => {
    const record = buildAppearanceRecord(null, appearance, ['backdrop'], NOW)
    expect(record).toEqual({
      $type: 'app.nearhorizon.actor.appearance',
      version: 1,
      backdrop: 'pride.ace',
      custom: {mode: 'solid', a: '#123456', b: '#654321'},
      presets: [
        {
          slot: 3,
          custom: {mode: 'twoTone', a: '#000000', b: '#FFFFFF'},
          savedAt: SAVED,
        },
      ],
      updatedAt: NOW.toISOString(),
    })
    expect(appearanceRecord.safeValidate(record).success).toBe(true)
  })

  it('replaces only the named fields and keeps the rest as read', () => {
    const raw = {
      version: 2,
      backdrop: 'pride.trans',
      custom: {mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'},
      futureField: {deep: true},
      presets: [
        {slot: 7, custom: {mode: 'future', a: '#111111'}, savedAt: SAVED},
        {weird: true},
        {slot: 3, custom: {mode: 'solid', a: '#222222'}, savedAt: SAVED},
        {slot: 1, custom: {mode: 'solid', a: '#333333'}, savedAt: SAVED},
      ],
      updatedAt: SAVED,
    }
    const record = buildAppearanceRecord(raw, appearance, ['backdrop'], NOW)
    expect(record.backdrop).toBe('pride.ace')
    expect(record.custom).toEqual(raw.custom)
    expect(record.futureField).toEqual({deep: true})
    expect(record.version).toBe(2)
    expect(record.presets).toEqual([
      raw.presets[3],
      raw.presets[2],
      raw.presets[0],
      raw.presets[1],
    ])

    const withPreset = buildAppearanceRecord(
      raw,
      appearance,
      ['preset:3', 'preset:7'],
      NOW,
    )
    expect(withPreset.backdrop).toBe('pride.trans')
    expect(withPreset.presets).toEqual([
      raw.presets[3],
      {
        slot: 3,
        custom: {mode: 'twoTone', a: '#000000', b: '#FFFFFF'},
        savedAt: SAVED,
      },
      raw.presets[1],
    ])
  })

  it('omits empty presets and always writes b', () => {
    const raw = {
      version: 1,
      presets: [
        {slot: 3, custom: {mode: 'solid', a: '#222222'}, savedAt: SAVED},
      ],
      updatedAt: SAVED,
    }
    const cleared = {...appearance, presets: emptyPresetSlots()}
    const record = buildAppearanceRecord(
      raw,
      cleared,
      ['preset:3', 'custom'],
      NOW,
    )
    expect('presets' in record).toBe(false)
    expect(record.custom).toEqual({mode: 'solid', a: '#123456', b: '#654321'})
  })

  it('round trips through the parser', () => {
    const record = buildAppearanceRecord(null, appearance, [], NOW)
    expect(parseAppearanceRecord(record)!.appearance).toEqual(appearance)
    const defaults = buildAppearanceRecord(null, DEFAULT_APPEARANCE, [], NOW)
    expect(parseAppearanceRecord(defaults)!.appearance).toEqual(
      DEFAULT_APPEARANCE,
    )
  })
})
