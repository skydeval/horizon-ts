import {describe, expect, it} from '@jest/globals'

/*
 * jest's preset is jest-expo/ios, so `../index` resolves to the native file,
 * as the app's native build does (2K design T-28, D-0.13).
 */
import {
  encoderAvailable,
  loadEncoder,
  prewarmEncoder,
  PrivateEncoderUnavailableError,
} from '../index'

describe('the native encoder module', () => {
  it('is never available, and loadEncoder rejects', async () => {
    expect(encoderAvailable()).toBe(false)
    await expect(loadEncoder()).rejects.toBeInstanceOf(
      PrivateEncoderUnavailableError,
    )
  })

  it('prewarm does nothing and does not throw', () => {
    expect(() => prewarmEncoder()).not.toThrow()
  })
})
