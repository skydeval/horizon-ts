import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

import {
  SETTLE_MS,
  useRowWindow,
  WINDOW_SCREENS,
} from '#/horizon/list-window/useRowWindow'

type Callback = (entries: Array<Partial<IntersectionObserverEntry>>) => void

/** A fake IntersectionObserver that the test drives by hand. */
class FakeObserver {
  static last: FakeObserver | undefined
  callback: Callback
  options: IntersectionObserverInit
  observed: Element[] = []
  disconnected = false
  constructor(callback: Callback, options: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
    FakeObserver.last = this
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  disconnect() {
    this.disconnected = true
  }
  fire(isIntersecting: boolean, height: number) {
    act(() => {
      this.callback([
        {
          isIntersecting,
          boundingClientRect: {height} as DOMRectReadOnly,
        },
      ])
    })
  }
}

type Globals = {IntersectionObserver: unknown; document: unknown}
const globals = globalThis as unknown as Globals
const originalObserver = globals.IntersectionObserver
const originalDocument = globals.document
let row: {contains: (el: unknown) => boolean}
let focusInside = false

beforeEach(() => {
  FakeObserver.last = undefined
  focusInside = false
  row = {contains: () => focusInside}
  globals.IntersectionObserver = FakeObserver
  globals.document = {activeElement: {}}
})

afterEach(() => {
  globals.IntersectionObserver = originalObserver
  globals.document = originalDocument
})

function setup() {
  const rowRef = {current: row as unknown as HTMLElement}
  const hook = renderHook(() => useRowWindow(rowRef, null))
  const observer = FakeObserver.last!
  return {hook, observer}
}

const OPEN = {held: false, height: undefined}

describe('useRowWindow', () => {
  it('watches the row with a margin of several screens', () => {
    const {hook, observer} = setup()
    expect(hook.result.current).toEqual(OPEN)
    expect(observer.observed).toEqual([row])
    const margin = `${WINDOW_SCREENS * 100}%`
    expect(observer.options.rootMargin).toBe(`${margin} 0px ${margin} 0px`)
  })

  it('holds a far row at its height, then renders it again with that height as a minimum while it settles', () => {
    jest.useFakeTimers()
    try {
      const {hook, observer} = setup()
      observer.fire(false, 412)
      expect(hook.result.current).toEqual({held: true, height: 412})
      observer.fire(true, 412)
      expect(hook.result.current).toEqual({held: false, height: 412})
      act(() => {
        jest.advanceTimersByTime(SETTLE_MS)
      })
      expect(hook.result.current).toEqual(OPEN)
    } finally {
      jest.useRealTimers()
    }
  })

  it('a row coming near that was never held stays as it is', () => {
    const {hook, observer} = setup()
    observer.fire(true, 412)
    expect(hook.result.current).toEqual(OPEN)
  })

  it('keeps a row in a hidden tab, which measures 0', () => {
    const {hook, observer} = setup()
    observer.fire(false, 0)
    expect(hook.result.current).toEqual(OPEN)
  })

  it('keeps a row that holds keyboard focus', () => {
    const {hook, observer} = setup()
    focusInside = true
    observer.fire(false, 300)
    expect(hook.result.current).toEqual(OPEN)
  })

  it('stops watching on unmount', () => {
    const {hook, observer} = setup()
    hook.unmount()
    expect(observer.disconnected).toBe(true)
  })
})
