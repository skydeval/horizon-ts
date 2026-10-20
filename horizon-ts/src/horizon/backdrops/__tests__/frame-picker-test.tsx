import {afterEach, describe, expect, it} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

import {useCoarsePointer as useNativeCoarsePointer} from '../coarse-pointer'
import {useCoarsePointer} from '../coarse-pointer.web'
import {offersFrameStylePicker} from '../frame-style'

describe('the Phone frame picker (change list item 3)', () => {
  it('shows below 800px or on a touch-first device, never on a wide desktop window', () => {
    expect(
      offersFrameStylePicker({gtMobile: false, coarsePointer: false}),
    ).toBe(true)
    expect(offersFrameStylePicker({gtMobile: true, coarsePointer: true})).toBe(
      true,
    )
    expect(offersFrameStylePicker({gtMobile: false, coarsePointer: true})).toBe(
      true,
    )
    expect(offersFrameStylePicker({gtMobile: true, coarsePointer: false})).toBe(
      false,
    )
  })

  it('native devices are touch-first', () => {
    expect(renderHook(() => useNativeCoarsePointer()).result.current).toBe(true)
  })
})

describe('useCoarsePointer on web', () => {
  const original = (globalThis as {matchMedia?: unknown}).matchMedia

  afterEach(() => {
    ;(globalThis as {matchMedia?: unknown}).matchMedia = original
  })

  it('follows (pointer: coarse) live', () => {
    let matches = false
    const listeners = new Set<() => void>()
    const queries: string[] = []
    ;(globalThis as {matchMedia?: unknown}).matchMedia = (query: string) => {
      queries.push(query)
      return {
        get matches() {
          return matches
        },
        addEventListener: (_: string, listener: () => void) =>
          listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) =>
          listeners.delete(listener),
      }
    }
    const {result, unmount} = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(false)
    expect(queries).toContain('(pointer: coarse)')
    act(() => {
      matches = true
      listeners.forEach(listener => listener())
    })
    expect(result.current).toBe(true)
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('reads as not touch-first without matchMedia', () => {
    ;(globalThis as {matchMedia?: unknown}).matchMedia = undefined
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false)
  })
})
