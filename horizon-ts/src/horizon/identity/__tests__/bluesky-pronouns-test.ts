import {describe, expect, it} from '@jest/globals'

import {BLUESKY_PRONOUNS_MAX, blueskyPronouns} from '#/horizon/identity/format'

/*
 * Horizon's pronoun sets written to Bluesky's profile field in its own form:
 * one set as typed, several combined by their first forms, at most 20
 * graphemes. Horizon's own record is never changed by this.
 */

describe('blueskyPronouns', () => {
  it('writes one set as typed', () => {
    expect(blueskyPronouns([['she', 'her']])).toBe('she/her')
    expect(blueskyPronouns([['xe', 'xem', 'xyr']])).toBe('xe/xem/xyr')
  })

  it('combines several sets by their first forms, as Bluesky does', () => {
    expect(
      blueskyPronouns([
        ['she', 'her'],
        ['they', 'them'],
      ]),
    ).toBe('she/they')
    expect(
      blueskyPronouns([
        ['he', 'him'],
        ['it', 'its'],
        ['they', 'them'],
      ]),
    ).toBe('he/it/they')
  })

  it('writes only the first set when that is how they show', () => {
    expect(
      blueskyPronouns(
        [
          ['she', 'her'],
          ['they', 'them'],
        ],
        'firstOnly',
      ),
    ).toBe('she/her')
  })

  it('drops sets, then forms, until it fits', () => {
    const long = [
      ['fae', 'faer'],
      ['star', 'stars'],
      ['moon', 'moons'],
      ['sun', 'suns'],
      ['cloud', 'clouds'],
    ]
    const text = blueskyPronouns(long)!
    expect(text).toBe('fae/star/moon/sun')
    expect(text.length).toBeLessThanOrEqual(BLUESKY_PRONOUNS_MAX)
    expect(blueskyPronouns([['abcdefghijkl', 'mnopqrstuvwxyz']])).toBe(
      'abcdefghijkl',
    )
  })

  it('counts emoji as one each, trims forms, and gives nothing for no sets', () => {
    expect(blueskyPronouns([['🌸', '🌸s']])).toBe('🌸/🌸s')
    expect(blueskyPronouns([[' she ', ' her ']])).toBe('she/her')
    expect(blueskyPronouns([])).toBeUndefined()
    expect(blueskyPronouns([['', ' ']])).toBeUndefined()
  })
})
