/*
 * The web safe-area provider must report window insets, not insets clamped
 * to the provider view (`patches/react-native-safe-area-context@5.10.1.patch`).
 *
 * The app's `SafeAreaProvider` wraps the whole window-scrolled document, so
 * its `getBoundingClientRect().top` is `-scrollY`. Stock 5.10.1 reported
 * `top: max(0, envTop - rect.top)`, which is the scroll offset, whenever the
 * provider resized (a page loading more, the lightbox's scrollbar lock).
 * `Layout.Screen` pads its top by that inset, so the column dropped by the
 * scroll offset, leaving empty space above the content.
 *
 * Runs the provider's effect against a minimal fake DOM (no jsdom in the
 * React Native preset).
 */

import {act} from 'react'
import TestRenderer from 'react-test-renderer'

const SCROLL_Y = 1200

/** The provider's DOM node: a long document scrolled down by SCROLL_Y. */
const mockProviderElement = {
  getBoundingClientRect: () => ({
    top: -SCROLL_Y,
    bottom: 5000 - SCROLL_Y,
    left: 0,
    right: 1024,
    width: 1024,
    height: 5000,
  }),
}

jest.mock('react-native', () => {
  const {forwardRef, useImperativeHandle} =
    jest.requireActual<typeof import('react')>('react')
  return {
    View: forwardRef(function MockView(
      {children}: {children?: React.ReactNode},
      ref: React.Ref<unknown>,
    ) {
      'use no memo'
      useImperativeHandle(ref, () => mockProviderElement)
      return children ?? null
    }),
  }
})

type Insets = {top: number; bottom: number; left: number; right: number}
type Change = {nativeEvent: {insets: Insets}}

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let resizeCallbacks: (() => void)[] = []
let windowResize: (() => void) | undefined

beforeEach(() => {
  resizeCallbacks = []
  windowResize = undefined
  for (const key of [
    'document',
    'window',
    'ResizeObserver',
    'CSS',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    saved[key] = g[key]
  }
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.CSS = {supports: () => false}
  g.document = {
    documentElement: {offsetWidth: 1024, offsetHeight: 768},
    body: {appendChild: () => {}},
    createElement: () => ({
      style: {} as Record<string, string>,
      addEventListener: () => {},
      removeEventListener: () => {},
      remove: () => {},
    }),
  }
  g.window = {
    innerWidth: 1024,
    innerHeight: 768,
    // A desktop browser: every env(safe-area-inset-*) is 0.
    getComputedStyle: () => ({
      paddingTop: '0px',
      paddingBottom: '0px',
      paddingLeft: '0px',
      paddingRight: '0px',
    }),
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'resize') windowResize = listener
    },
    removeEventListener: () => {},
  }
  g.ResizeObserver = class {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback)
    }
    observe() {}
    disconnect() {}
  }
})

afterEach(() => {
  for (const key of Object.keys(saved)) g[key] = saved[key]
})

describe.each([
  ['src', 'react-native-safe-area-context/src/NativeSafeAreaProvider.web'],
  [
    'lib/module',
    'react-native-safe-area-context/lib/module/NativeSafeAreaProvider.web',
  ],
  [
    'lib/commonjs',
    'react-native-safe-area-context/lib/commonjs/NativeSafeAreaProvider.web',
  ],
])('NativeSafeAreaProvider.web (%s)', (_name, path) => {
  it('keeps the insets at the window insets while the page is scrolled', () => {
    const {NativeSafeAreaProvider} = jest.requireActual(path) as {
      NativeSafeAreaProvider: React.ComponentType<{
        onInsetsChange: (change: Change) => void
      }>
    }
    const changes: Insets[] = []
    let renderer: TestRenderer.ReactTestRenderer | undefined
    act(() => {
      renderer = TestRenderer.create(
        <NativeSafeAreaProvider
          onInsetsChange={change => changes.push(change.nativeEvent.insets)}
        />,
      )
    })
    // The page grows (the provider resizes) and the window resizes.
    act(() => {
      resizeCallbacks.forEach(callback => callback())
      windowResize?.()
    })

    expect(changes.length).toBeGreaterThan(1)
    for (const insets of changes) {
      expect(insets).toEqual({top: 0, bottom: 0, left: 0, right: 0})
    }
    act(() => renderer?.unmount())
  })
})
