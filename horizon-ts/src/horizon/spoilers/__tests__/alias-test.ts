import {describe, expect, it} from '@jest/globals'

import {convertAltSpoilers} from '../alias'

describe('convertAltSpoilers', () => {
  it('converts an inline pair', () => {
    expect(convertAltSpoilers('the killer is >!the butler!< lol')).toBe(
      'the killer is ||the butler|| lol',
    )
  })

  it('converts a pair spanning lines', () => {
    expect(
      convertAltSpoilers(
        'so i had fun today (cw blood)\n>!i fell off\nmy bike!<',
      ),
    ).toBe('so i had fun today (cw blood)\n||i fell off\nmy bike||')
  })

  it('converts several pairs, each to the first closer after it', () => {
    expect(convertAltSpoilers('>!a!< and >!b!<')).toBe('||a|| and ||b||')
  })

  it('keeps the length the same', () => {
    const text = 'x >!hidden words!< y'
    expect(convertAltSpoilers(text)).toHaveLength(text.length)
  })

  it('leaves text without a matched pair as typed', () => {
    expect(convertAltSpoilers('hi!<3')).toBe('hi!<3')
    expect(convertAltSpoilers('>!no closer')).toBe('>!no closer')
    expect(convertAltSpoilers('!< before >!')).toBe('!< before >!')
    expect(convertAltSpoilers('plain text')).toBe('plain text')
  })

  it('leaves an empty or whitespace-only pair as typed', () => {
    expect(convertAltSpoilers('>!!<')).toBe('>!!<')
    expect(convertAltSpoilers('>!   !<')).toBe('>!   !<')
  })

  it('leaves a pair holding || as typed', () => {
    expect(convertAltSpoilers('>!a || b!<')).toBe('>!a || b!<')
  })

  it('works beside the || syntax', () => {
    expect(convertAltSpoilers('||one|| and >!two!<')).toBe(
      '||one|| and ||two||',
    )
  })

  it('after a skipped opener, a later pair still converts', () => {
    expect(convertAltSpoilers('>! !< then >!real!<')).toBe(
      '>! !< then ||real||',
    )
  })
})
