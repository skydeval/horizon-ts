/*
 * Change list 3, item 10: custom stripes in the model, the record (and its
 * presets), the device cache, and the editor's add, remove and reorder. Item
 * 4's hemisphere is a device setting, checked here with the device value.
 */

import {describe, expect, it, jest} from '@jest/globals'

import {
  defaultDeviceValue,
  parseDeviceValue,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {
  type Appearance,
  type CustomConfig,
  DEFAULT_APPEARANCE,
  STRIPES_MAX,
  STRIPES_MIN,
} from '#/horizon/appearance/model'
import {
  buildAppearanceRecord,
  parseAppearanceRecord,
  parseCustom,
} from '#/horizon/appearance/record'
import {
  addStripe,
  canAddStripe,
  canRemoveStripe,
  editorConfig,
  initEditor,
  isEditorValid,
  moveStripe,
  onHexChange,
  onSlider,
  removeStripe,
  sameConfig,
  setMode,
  setStripe,
} from '#/horizon/appearance/settings/editor'
import {appearanceRecord} from '#/horizon/lexicons/appearance'

jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => undefined,
  writeDeviceJson: () => {},
  subscribeDeviceJson: () => () => {},
}))

const NOW = new Date('2026-10-20T12:00:00.000Z')
const SAVED = '2026-10-19T10:00:00.000Z'
const STRIPES = ['#112233', '#445566', '#778899']

const STRIPED: CustomConfig = {
  mode: 'stripes',
  a: '#FFE2FF',
  b: '#CCFFFF',
  stripes: STRIPES,
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    $type: 'app.nearhorizon.actor.appearance',
    version: 1,
    backdrop: 'custom',
    custom: {mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'},
    updatedAt: SAVED,
    ...overrides,
  }
}

describe('reading custom stripes', () => {
  it('reads the mode and the colours, uppercased, in order', () => {
    expect(
      parseCustom({
        mode: 'stripes',
        a: '#ffe2ff',
        b: '#ccffff',
        stripes: ['#aabbcc', '#000000'],
      }),
    ).toEqual({
      mode: 'stripes',
      a: '#FFE2FF',
      b: '#CCFFFF',
      stripes: ['#AABBCC', '#000000'],
    })
  })

  it('a record from before change list 3 reads exactly as it did', () => {
    const parsed = parseAppearanceRecord(record())!
    expect(parsed.appearance.custom).toEqual({
      mode: 'twoTone',
      a: '#FFE2FF',
      b: '#CCFFFF',
    })
    expect('stripes' in parsed.appearance.custom).toBe(false)
    // Written back, no stripes appear.
    const built = buildAppearanceRecord(
      parsed.raw,
      parsed.appearance,
      ['custom'],
      NOW,
    )
    expect(built.custom).toEqual({mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'})
  })

  it('unusable stripes are dropped; the stripes mode then reads as two-tone', () => {
    for (const stripes of [
      ['#000000'],
      Array(STRIPES_MAX + 1).fill('#000000'),
      ['#000000', 'red'],
      '#000000',
    ]) {
      expect(
        parseCustom({mode: 'stripes', a: '#101010', b: '#202020', stripes}),
      ).toEqual({mode: 'twoTone', a: '#101010', b: '#202020'})
    }
    // An unknown mode still makes the whole custom unreadable, as before.
    expect(parseCustom({mode: 'plaid', a: '#101010'})).toBeNull()
  })

  it('stripes are kept while one-tone or two-tone', () => {
    expect(
      parseCustom({mode: 'solid', a: '#101010', stripes: STRIPES})!.stripes,
    ).toEqual(STRIPES)
  })
})

describe('writing custom stripes', () => {
  const appearance: Appearance = {
    ...DEFAULT_APPEARANCE,
    backdrop: 'custom',
    custom: STRIPED,
    presets: DEFAULT_APPEARANCE.presets.map((_p, i) =>
      i === 2
        ? {
            custom: {
              mode: 'stripes',
              a: '#000000',
              b: '#FFFFFF',
              stripes: Array(STRIPES_MAX).fill('#ABCDEF'),
            },
            savedAt: SAVED,
          }
        : null,
    ),
  }

  it('on the custom and in presets, valid by the schema, read back the same', () => {
    const built = buildAppearanceRecord(null, appearance, [], NOW)
    expect(built.custom).toEqual({
      mode: 'stripes',
      a: '#FFE2FF',
      b: '#CCFFFF',
      stripes: STRIPES,
    })
    expect(appearanceRecord.safeValidate(built).success).toBe(true)
    const back = parseAppearanceRecord(built)!.appearance
    expect(back.custom).toEqual(STRIPED)
    expect(back.presets[2]!.custom.stripes).toHaveLength(STRIPES_MAX)
    expect(back.presets).toEqual(appearance.presets)
  })

  it('the schema holds 2 to 8 colours of seven characters', () => {
    const custom = (stripes: string[]) =>
      appearanceRecord.safeValidate(
        record({custom: {mode: 'stripes', a: '#000000', stripes}}),
      ).success
    expect(custom(['#000000', '#FFFFFF'])).toBe(true)
    expect(custom(Array(STRIPES_MAX).fill('#000000'))).toBe(true)
    expect(custom(['#000000'])).toBe(false)
    expect(custom(Array(STRIPES_MAX + 1).fill('#000000'))).toBe(false)
    expect(custom(['#000000', '#FFF'])).toBe(false)
  })

  it('a write that does not name the custom keeps its stripes as read', () => {
    const parsed = parseAppearanceRecord(
      record({custom: {mode: 'stripes', a: '#000000', stripes: STRIPES}}),
    )!
    const built = buildAppearanceRecord(
      parsed.raw,
      {...parsed.appearance, backdrop: 'pride.trans'},
      ['backdrop'],
      NOW,
    )
    expect(built.custom).toEqual({
      mode: 'stripes',
      a: '#000000',
      stripes: STRIPES,
    })
  })

  it('the device cache keeps them, and the hemisphere setting', () => {
    const json = serializeDeviceValue({
      ...defaultDeviceValue(),
      device: appearance,
      southern: true,
    })
    const value = parseDeviceValue(json)
    expect(value.device.custom).toEqual(STRIPED)
    expect(value.device.presets[2]!.custom.mode).toBe('stripes')
    expect(value.southern).toBe(true)
    expect(defaultDeviceValue().southern).toBe(false)
    expect(
      parseDeviceValue(JSON.stringify({v: 1, southern: 'yes'})).southern,
    ).toBe(false)
  })
})

describe('the stripes editor', () => {
  const twoTone: CustomConfig = {mode: 'twoTone', a: '#FF0000', b: '#0000FF'}

  it('Stripes first chosen starts from the two-tone colours', () => {
    const start = initEditor(twoTone)
    expect(start.stripes).toBeUndefined()
    expect(editorConfig(start)).toEqual(twoTone)
    const striped = setMode(start, 'stripes')
    expect(editorConfig(striped)).toEqual({
      ...twoTone,
      mode: 'stripes',
      stripes: ['#FF0000', '#0000FF'],
    })
    // Back to two-tone and again: the stripes are kept, not re-seeded.
    const edited = setStripe(
      striped,
      0,
      onSlider(striped.stripes![0], 'g', 255),
    )
    const again = setMode(setMode(edited, 'twoTone'), 'stripes')
    expect(editorConfig(again).stripes).toEqual(['#FFFF00', '#0000FF'])
  })

  it('adds up to 8 at the bottom, in the bottom colour, then no more', () => {
    let state = setMode(initEditor(twoTone), 'stripes')
    while (canAddStripe(state)) state = addStripe(state)
    expect(state.stripes).toHaveLength(STRIPES_MAX)
    expect(editorConfig(state).stripes!.slice(1)).toEqual(
      Array(STRIPES_MAX - 1).fill('#0000FF'),
    )
    expect(addStripe(state)).toBe(state)
  })

  it('removes down to 2, then no more; out of range does nothing', () => {
    let state = setMode(initEditor({...STRIPED, stripes: STRIPES}), 'stripes')
    expect(removeStripe(state, 7)).toBe(state)
    state = removeStripe(state, 1)
    expect(editorConfig(state).stripes).toEqual(['#112233', '#778899'])
    expect(state.stripes).toHaveLength(STRIPES_MIN)
    expect(canRemoveStripe(state)).toBe(false)
    expect(removeStripe(state, 0)).toBe(state)
  })

  it('moves a stripe up or down, clamped at the ends', () => {
    const state = initEditor(STRIPED)
    expect(editorConfig(moveStripe(state, 2, -1)).stripes).toEqual([
      '#112233',
      '#778899',
      '#445566',
    ])
    expect(editorConfig(moveStripe(state, 0, 1)).stripes).toEqual([
      '#445566',
      '#112233',
      '#778899',
    ])
    expect(editorConfig(moveStripe(state, 0, -5)).stripes).toEqual(STRIPES)
    expect(moveStripe(state, 0, -1)).toBe(state)
    expect(moveStripe(state, 2, 1)).toBe(state)
    expect(editorConfig(moveStripe(state, 0, 9)).stripes).toEqual([
      '#445566',
      '#778899',
      '#112233',
    ])
  })

  it('an invalid stripe blocks Apply only in Stripes', () => {
    const state = initEditor(STRIPED)
    const broken = setStripe(state, 1, onHexChange(state.stripes![1], '#12'))
    expect(isEditorValid(broken)).toBe(false)
    expect(isEditorValid(setMode(broken, 'twoTone'))).toBe(true)
    // The committed colour stays until the text is a colour again.
    expect(editorConfig(broken).stripes).toEqual(STRIPES)
  })

  it('sameConfig tells stripes apart', () => {
    expect(sameConfig(STRIPED, {...STRIPED, stripes: [...STRIPES]})).toBe(true)
    expect(
      sameConfig(STRIPED, {...STRIPED, stripes: [...STRIPES].reverse()}),
    ).toBe(false)
    expect(sameConfig(twoTone, {...twoTone, stripes: STRIPES})).toBe(false)
  })
})
