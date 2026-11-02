import {describe, expect, it} from '@jest/globals'

import {
  dropStarterEmoji,
  FREQUENT_KEY,
  restoreFrequentRow,
} from '#/horizon/emoji/frequent'

function storageWith(value?: string): Storage {
  const map = new Map<string, string>()
  if (value !== undefined) map.set(FREQUENT_KEY, value)
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, v: string) => void map.set(key, v),
  } as unknown as Storage
}

const SEEDED = {
  '+1': 9,
  grinning: 8,
  kissing_heart: 7,
  heart_eyes: 6,
  laughing: 5,
  stuck_out_tongue_winking_eye: 4,
  sweat_smile: 3,
  joy: 2,
  scream: 1,
}

describe('dropStarterEmoji', () => {
  it('starts a new row empty, so emoji-mart seeds nothing', () => {
    const storage = storageWith()
    dropStarterEmoji(storage)
    expect(storage.getItem(FREQUENT_KEY)).toBe('{}')
  })

  it('drops the starters never picked and keeps your picks', () => {
    const storage = storageWith(
      JSON.stringify({...SEEDED, '+1': 10, scream: 2, no_mouth: 1}),
    )
    dropStarterEmoji(storage)
    expect(JSON.parse(storage.getItem(FREQUENT_KEY)!)).toEqual({
      '+1': 10,
      scream: 2,
      no_mouth: 1,
    })
  })

  it('leaves a row with no starters as it is', () => {
    const raw = JSON.stringify({no_mouth: 3})
    const storage = storageWith(raw)
    dropStarterEmoji(storage)
    expect(storage.getItem(FREQUENT_KEY)).toBe(raw)
  })

  it('leaves a value it cannot read, and survives no storage', () => {
    const storage = storageWith('not json')
    dropStarterEmoji(storage)
    expect(storage.getItem(FREQUENT_KEY)).toBe('not json')
    expect(() => dropStarterEmoji(undefined)).not.toThrow()
  })
})

describe('restoreFrequentRow', () => {
  it('puts a removed row back first', () => {
    const data = {categories: [{id: 'people'}]}
    restoreFrequentRow(data)
    expect(data.categories.map(c => c.id)).toEqual(['frequent', 'people'])
  })

  it('never adds a second row, and ignores data not loaded yet', () => {
    const data = {categories: [{id: 'frequent'}, {id: 'people'}]}
    restoreFrequentRow(data)
    expect(data.categories).toHaveLength(2)
    expect(() => restoreFrequentRow({})).not.toThrow()
  })
})
