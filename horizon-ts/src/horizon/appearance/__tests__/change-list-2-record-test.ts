import {describe, expect, it, jest} from '@jest/globals'

import {
  defaultDeviceValue,
  emptyAccountCopy,
  parseDeviceValue,
  serializeDeviceValue,
} from '#/horizon/appearance/device-value'
import {
  type Appearance,
  DEFAULT_APPEARANCE,
  DEFAULT_CUSTOM,
} from '#/horizon/appearance/model'
import {
  buildAppearanceRecord,
  parseAppearanceRecord,
  parseCustom,
} from '#/horizon/appearance/record'
import {rebase} from '#/horizon/appearance/sync'
import {
  migrateRemovedSolid,
  REMOVED_SOLIDS,
  resolveBackdrop,
} from '#/horizon/backdrops/registry'
import {appearanceRecord} from '#/horizon/lexicons/appearance'

// `sync.ts` (for `rebase`) loads the store, the toast and the logger.
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
}))
jest.mock('#/components/Toast', () => ({show: () => {}}))
jest.mock('#/logger', () => ({
  logger: {warn: () => {}, error: () => {}, info: () => {}, debug: () => {}},
}))
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => undefined,
  writeDeviceJson: () => {},
  subscribeDeviceJson: () => () => {},
}))

const NOW = new Date('2026-10-20T12:00:00.000Z')
const SAVED = '2026-10-19T10:00:00.000Z'

function record(overrides: Record<string, unknown> = {}) {
  return {
    $type: 'app.nearhorizon.actor.appearance',
    version: 1,
    backdrop: 'pride.trans',
    custom: {mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'},
    updatedAt: SAVED,
    ...overrides,
  }
}

describe('removed solids (change list 2, item 9)', () => {
  it('every removed solid reads as a custom one-tone of its colour', () => {
    expect(Object.keys(REMOVED_SOLIDS)).toHaveLength(9)
    for (const [id, color] of Object.entries(REMOVED_SOLIDS)) {
      const parsed = parseAppearanceRecord(record({backdrop: id}))!
      expect(parsed.appearance.backdrop).toBe('custom')
      // The two-tone's second colour is kept for switching back.
      expect(parsed.appearance.custom).toEqual({
        mode: 'solid',
        a: color,
        b: '#CCFFFF',
      })
      // It draws the solid's colour, top to bottom.
      expect(resolveBackdrop(parsed.appearance)!.stripes).toEqual([
        color,
        color,
      ])
      // The raw value keeps what the repo said until a write.
      expect(parsed.raw.backdrop).toBe(id)
    }
  })

  it('leaves every other appearance alone, unknown ids included', () => {
    const a = {...DEFAULT_APPEARANCE, backdrop: 'pride.ace'}
    expect(migrateRemovedSolid(a)).toBe(a)
    const unknown = {...DEFAULT_APPEARANCE, backdrop: 'solids.teal'}
    expect(migrateRemovedSolid(unknown)).toBe(unknown)
    expect(resolveBackdrop(unknown)).toBeNull()
  })

  it('the device cache reads the same: own value, copies and pending', () => {
    const stored = {
      ...DEFAULT_APPEARANCE,
      backdrop: 'solids.blue',
      custom: {mode: 'twoTone' as const, a: '#111111', b: '#222222'},
    }
    const json = serializeDeviceValue({
      ...defaultDeviceValue(),
      device: stored,
      accounts: {
        'did:plc:a': {
          ...emptyAccountCopy(),
          record: {...DEFAULT_APPEARANCE, backdrop: 'solids.violet'},
          raw: {backdrop: 'solids.violet'},
          cid: 'c1',
          syncedAt: 5,
          pending: {
            fields: ['backdrop'],
            appearance: {...DEFAULT_APPEARANCE, backdrop: 'solids.mist'},
            seq: 1,
          },
          blocked: false,
        },
      },
    })
    const value = parseDeviceValue(json)
    expect(value.device.backdrop).toBe('custom')
    expect(value.device.custom).toEqual({
      mode: 'solid',
      a: '#2F5F9E',
      b: '#222222',
    })
    const copy = value.accounts['did:plc:a']
    expect(copy.record!.backdrop).toBe('custom')
    expect(copy.record!.custom.a).toBe('#6B4A8E')
    expect(copy.pending!.appearance.custom.a).toBe('#E9EEF5')
  })

  it('any write over a record naming a solid puts the one-tone back', () => {
    const parsed = parseAppearanceRecord(record({backdrop: 'solids.red'}))!
    // An edit that named only a preset slot still writes the migration.
    const built = buildAppearanceRecord(
      parsed.raw,
      parsed.appearance,
      ['preset:1'],
      NOW,
    )
    expect(built.backdrop).toBe('custom')
    expect(built.custom).toEqual({mode: 'solid', a: '#B4534B', b: '#CCFFFF'})
    expect(appearanceRecord.safeValidate(built).success).toBe(true)
    // Read back, it is the same appearance.
    expect(parseAppearanceRecord(built)!.appearance).toEqual(parsed.appearance)
    // A record not naming a solid is written field by field as before.
    const plain = parseAppearanceRecord(record())!
    const kept = buildAppearanceRecord(
      plain.raw,
      {
        ...plain.appearance,
        custom: {mode: 'solid', a: '#000000', b: '#000000'},
      },
      ['backdrop'],
      NOW,
    )
    expect(kept.custom).toEqual({mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'})
  })
})

describe('the pattern field (change list 2, item 7)', () => {
  it('parses known patterns, drops unknown ones, keeps the colours', () => {
    expect(parseCustom({mode: 'solid', a: '#101010', pattern: 'dots'})).toEqual(
      {mode: 'solid', a: '#101010', b: '#101010', pattern: 'dots'},
    )
    expect(
      parseCustom({mode: 'solid', a: '#101010', pattern: 'stars'}),
    ).toEqual({mode: 'solid', a: '#101010', b: '#101010'})
  })

  it('writes and reads it, on the custom and in presets, valid by the schema', () => {
    const appearance: Appearance = {
      ...DEFAULT_APPEARANCE,
      backdrop: 'custom',
      custom: {mode: 'solid', a: '#334455', b: '#334455', pattern: 'grid'},
      presets: DEFAULT_APPEARANCE.presets.map((_p, i) =>
        i === 0
          ? {
              custom: {
                mode: 'solid',
                a: '#EEEEEE',
                b: '#EEEEEE',
                pattern: 'lines',
              },
              savedAt: SAVED,
            }
          : null,
      ),
    }
    const built = buildAppearanceRecord(null, appearance, [], NOW)
    expect(built.custom).toEqual({
      mode: 'solid',
      a: '#334455',
      b: '#334455',
      pattern: 'grid',
    })
    expect(appearanceRecord.safeValidate(built).success).toBe(true)
    const back = parseAppearanceRecord(built)!.appearance
    expect(back.custom.pattern).toBe('grid')
    expect(back.presets[0]!.custom.pattern).toBe('lines')
  })

  it('draws only on a one-tone', () => {
    const solid = resolveBackdrop({
      ...DEFAULT_APPEARANCE,
      backdrop: 'custom',
      custom: {mode: 'solid', a: '#334455', b: '#334455', pattern: 'dots'},
    })!
    expect(solid.pattern).toBe('dots')
    const twoTone = resolveBackdrop({
      ...DEFAULT_APPEARANCE,
      backdrop: 'custom',
      custom: {...DEFAULT_CUSTOM, pattern: 'dots'},
    })!
    expect(twoTone.pattern).toBeUndefined()
  })
})

describe('the theme fields (change list 2, item 11)', () => {
  it('the schema accepts them', () => {
    expect(
      appearanceRecord.safeValidate(
        record({
          colorMode: 'dark',
          darkTheme: 'dim',
          font: 'system',
          fontSize: 'larger',
        }),
      ).success,
    ).toBe(true)
  })

  it('reads known values only, each on its own', () => {
    const parsed = parseAppearanceRecord(
      record({
        colorMode: 'dark',
        darkTheme: 'purple',
        font: 'theme',
        fontSize: 3,
      }),
    )!
    expect(parsed.appearance.colorMode).toBe('dark')
    expect(parsed.appearance.font).toBe('theme')
    expect('darkTheme' in parsed.appearance).toBe(false)
    expect('fontSize' in parsed.appearance).toBe(false)
    // A record without them has none.
    const none = parseAppearanceRecord(record())!.appearance
    for (const field of ['colorMode', 'darkTheme', 'font', 'fontSize']) {
      expect(field in none).toBe(false)
    }
  })

  it('writes a named field, removes a cleared one, keeps the others', () => {
    const parsed = parseAppearanceRecord(
      record({colorMode: 'light', font: 'system'}),
    )!
    const built = buildAppearanceRecord(
      parsed.raw,
      {...parsed.appearance, colorMode: 'dark', font: undefined},
      ['colorMode', 'font'],
      NOW,
    )
    expect(built.colorMode).toBe('dark')
    expect('font' in built).toBe(false)
    expect(built.backdrop).toBe('pride.trans')
    // Not named: kept as read.
    const other = buildAppearanceRecord(
      parsed.raw,
      {...parsed.appearance, colorMode: 'dark'},
      ['backdrop'],
      NOW,
    )
    expect(other.colorMode).toBe('light')
  })

  it('a first write carries only the fields that are set', () => {
    const built = buildAppearanceRecord(
      null,
      {...DEFAULT_APPEARANCE, darkTheme: 'dark'},
      [],
      NOW,
    )
    expect(built.darkTheme).toBe('dark')
    expect('colorMode' in built).toBe(false)
    expect(appearanceRecord.safeValidate(built).success).toBe(true)
  })

  it('rebase lays a pending theme field over a fresh read', () => {
    const fresh: Appearance = {
      ...DEFAULT_APPEARANCE,
      backdrop: 'pride.bi',
      colorMode: 'light',
      font: 'theme',
    }
    const pending: Appearance = {...DEFAULT_APPEARANCE, colorMode: 'dark'}
    const out = rebase(fresh, pending, ['colorMode', 'font'])
    expect(out.colorMode).toBe('dark')
    expect('font' in out).toBe(false)
    expect(out.backdrop).toBe('pride.bi')
  })

  it('the device keeps them in copies and pending, not in its own value', () => {
    const json = serializeDeviceValue({
      ...defaultDeviceValue(),
      accounts: {
        'did:plc:a': {
          ...emptyAccountCopy(),
          record: {...DEFAULT_APPEARANCE, fontSize: 'smaller'},
          raw: {fontSize: 'smaller'},
          cid: 'c',
          syncedAt: 1,
          pending: {
            fields: ['colorMode'],
            appearance: {...DEFAULT_APPEARANCE, colorMode: 'dark'},
            seq: 1,
          },
          blocked: false,
        },
      },
    })
    const copy = parseDeviceValue(json).accounts['did:plc:a']
    expect(copy.record!.fontSize).toBe('smaller')
    expect(copy.pending!.fields).toEqual(['colorMode'])
    expect(copy.pending!.appearance.colorMode).toBe('dark')
  })
})
