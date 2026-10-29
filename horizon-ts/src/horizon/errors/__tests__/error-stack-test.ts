import {describe, expect, it} from '@jest/globals'

import {describeCrash, trimLines} from '#/horizon/errors/crash-text'

describe('the crash stack shown in test builds', () => {
  it('keeps a short stack whole, without blank lines', () => {
    expect(trimLines('a\n\nb\n c')).toBe('a\nb\n c')
    expect(trimLines(undefined)).toBe('')
  })

  it('keeps the first 40 and last 20 frames of a long one', () => {
    const lines = Array.from({length: 1000}, (_, i) => `at f${i}`)
    const out = trimLines(lines.join('\n')).split('\n')
    expect(out).toHaveLength(61)
    expect(out[0]).toBe('at f0')
    expect(out[39]).toBe('at f39')
    expect(out[40]).toBe('… 940 more …')
    expect(out[60]).toBe('at f999')
  })

  it('names the error, then its stack, then the components', () => {
    const error = new RangeError('Maximum call stack size exceeded')
    error.stack = 'RangeError: Maximum call stack size exceeded\n    at loop'
    expect(describeCrash(error, '\n    in Feed\n    in App')).toBe(
      'RangeError: Maximum call stack size exceeded\n\n' +
        'RangeError: Maximum call stack size exceeded\n    at loop\n\n' +
        'Components:\n    in Feed\n    in App',
    )
  })
})
