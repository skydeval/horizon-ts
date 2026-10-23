import {describe, expect, it} from '@jest/globals'

import {
  defaultDeviceValue,
  type DeviceAppearanceV1,
  emptyAccountCopy,
  parseDeviceValue,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {DEFAULT_APPEARANCE, emptyPresetSlots} from '#/horizon/appearance/model'

describe('the device value (T10)', () => {
  it('defaults on a missing, corrupt or other-version value', () => {
    expect(parseDeviceValue(undefined)).toEqual(defaultDeviceValue())
    expect(parseDeviceValue('{not json')).toEqual(defaultDeviceValue())
    expect(parseDeviceValue('[]')).toEqual(defaultDeviceValue())
    expect(parseDeviceValue(JSON.stringify({v: 2, optOut: true}))).toEqual(
      defaultDeviceValue(),
    )
    expect(defaultDeviceValue()).toEqual({
      v: 1,
      device: DEFAULT_APPEARANCE,
      accounts: {},
      frameStyle: 'bars',
      softness: {dim: 40, dark: 50},
      grain: false,
      southern: false,
    })
  })

  it('parses each field leniently', () => {
    const parsed = parseDeviceValue(
      JSON.stringify({
        v: 1,
        device: {
          backdrop: 7,
          custom: {mode: 'solid', a: '#abcdef'},
          presets: 'x',
        },
        optOut: 'yes',
        frameStyle: 'circles',
        insetCard: 1,
        softness: {dim: 'x', dark: 250.4},
        accounts: {
          'did:plc:a': {
            record: {backdrop: 'pride.bi'},
            raw: {backdrop: 'pride.bi', version: 1},
            cid: 'bafy',
            syncedAt: 5,
            pending: {
              fields: ['backdrop', 'nonsense', 'preset:3'],
              appearance: {backdrop: 'pride.ace'},
              seq: 2,
            },
            blocked: true,
          },
          'did:plc:b': 'broken',
          'did:plc:c': {record: null, raw: {x: 1}, cid: 'bafy', syncedAt: -1},
        },
      }),
    )
    expect(parsed.device.backdrop).toBe('none')
    expect(parsed.device.custom).toEqual({
      mode: 'solid',
      a: '#ABCDEF',
      b: '#ABCDEF',
    })
    expect(parsed.device.presets).toEqual(emptyPresetSlots())
    expect(parsed).not.toHaveProperty('optOut')
    expect(parsed.frameStyle).toBe('bars')
    expect(parsed.softness).toEqual({dim: 40, dark: 100})
    expect(Object.keys(parsed.accounts)).toEqual(['did:plc:a', 'did:plc:c'])
    const a = parsed.accounts['did:plc:a']
    expect(a.record?.backdrop).toBe('pride.bi')
    expect(a.cid).toBe('bafy')
    expect(a.pending?.fields).toEqual(['backdrop', 'preset:3'])
    expect(a.pending?.appearance.backdrop).toBe('pride.ace')
    expect(a.pending?.seq).toBe(2)
    expect(a.blocked).toBe(true)
    const c = parsed.accounts['did:plc:c']
    expect(c).toEqual(emptyAccountCopy())
  })

  it('reads every frame style, retired Buttons as Bars, and the retired inset toggle as Gutter', () => {
    const read = (value: Record<string, unknown>) =>
      parseDeviceValue(JSON.stringify({v: 1, ...value})).frameStyle
    for (const style of ['bars', 'edges', 'gutter', 'headerBand'] as const) {
      expect(read({frameStyle: style})).toBe(style)
    }
    // Buttons was removed (round 2 list): a stored pick reads as Bars.
    expect(read({frameStyle: 'buttons'})).toBe('bars')
    expect(read({frameStyle: 'circles'})).toBe('bars')
    expect(read({})).toBe('bars')
    expect(read({frameStyle: 'bars', insetCard: true})).toBe('gutter')
    expect(read({insetCard: true})).toBe('gutter')
    expect(read({frameStyle: 'buttons', insetCard: true})).toBe('bars')
    expect(read({frameStyle: 'edges', insetCard: true})).toBe('edges')
    // Written back without the retired field.
    const parsed = parseDeviceValue(
      JSON.stringify({v: 1, frameStyle: 'bars', insetCard: true}),
    )
    expect(JSON.parse(serializeDeviceValue(parsed))).not.toHaveProperty(
      'insetCard',
    )
  })

  it('ignores a stored opt-out from the removed toggle and drops it on write', () => {
    const parsed = parseDeviceValue(
      JSON.stringify({
        v: 1,
        device: {backdrop: 'pride.bi'},
        optOut: true,
        grain: true,
      }),
    )
    expect(parsed).not.toHaveProperty('optOut')
    expect(parsed.device.backdrop).toBe('pride.bi')
    expect(parsed.grain).toBe(true)
    expect(JSON.parse(serializeDeviceValue(parsed))).not.toHaveProperty(
      'optOut',
    )
  })

  it('round trips', () => {
    const presets = emptyPresetSlots()
    presets[9] = {
      name: 'Ten',
      custom: {mode: 'twoTone', a: '#000000', b: '#FFFFFF'},
      savedAt: '2026-10-19T00:00:00.000Z',
    }
    const value: DeviceAppearanceV1 = {
      v: 1,
      device: {
        backdrop: 'custom',
        custom: {mode: 'solid', a: '#101010', b: '#202020'},
        presets,
      },
      frameStyle: 'headerBand',
      softness: {dim: 0, dark: 73},
      grain: true,
      southern: true,
      accounts: {
        'did:plc:a': {
          ...emptyAccountCopy(),
          record: DEFAULT_APPEARANCE,
          raw: {version: 1, extra: [1, 2]},
          cid: 'bafyabc',
          syncedAt: 1234,
          pending: {fields: ['custom'], appearance: DEFAULT_APPEARANCE, seq: 4},
          blocked: false,
        },
      },
    }
    expect(parseDeviceValue(serializeDeviceValue(value))).toEqual(value)
  })
})
