import {createContext as mockCreateContext, useRef as mockUseRef} from 'react'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {cssBackgroundPosition} from '#/horizon/backdrops/css'
import {
  bottomBarShape,
  horizonInnerHeaderSticky,
  lensActive,
  windowActive,
} from '#/horizon/backdrops/frame'
import {
  attachWindowTriggers,
  createSettleLoop,
  type ListenerTarget,
  SETTLE_CAP_MS,
  windowOffset,
  type WindowRect,
} from '#/horizon/backdrops/frame-tracking'
import {FrameLens} from '#/horizon/backdrops/FrameLens'
import {FrameWindow} from '#/horizon/backdrops/FrameWindow'
import {registryDef} from '#/horizon/backdrops/registry'

let mockGtMobile = false
let mockWithinDialog = false
let mockHideBorder = false
let mockFooterMode = 0
let mockHeaderMode = 0
const mockFrame = {width: 390, height: 844}

type Reaction = {
  prev: number | null
  prepare: () => number
  react: (value: number, prev: number | null) => void
}
const mockReactions: Reaction[] = []

jest.mock('#/horizon/switches', () => ({
  BACKDROPS: true,
  COMPACT_FRAME_WINDOWS: true,
  APPEARANCE_SYNC: true,
}))
jest.mock('#/env', () => ({
  ...jest.requireActual<Record<string, unknown>>('#/env'),
  IS_WEB: true,
}))
jest.mock('#/alf', () => ({
  atoms: {rounded_sm: {borderRadius: 8}, overflow_hidden: {}},
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
  useBreakpoints: () => ({gtMobile: mockGtMobile}),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined, hasSession: false}),
}))
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => undefined,
  writeDeviceJson: () => {},
  subscribeDeviceJson: () => () => {},
}))
jest.mock('#/components/Dialog/context', () => ({
  useDialogContext: () => ({isWithinDialog: mockWithinDialog}),
}))
jest.mock('#/lib/hooks/useHideBottomBarBorder', () => ({
  useHideBottomBarBorder: () => mockHideBorder,
}))
jest.mock('#/state/shell/minimal-mode', () => ({
  useMinimalShellMode: () => ({footerMode: {get: () => mockFooterMode}}),
}))
jest.mock('#/view/com/util/MainScrollProvider', () => ({
  useHomeHeaderMode: () => ({get: () => mockHeaderMode}),
}))
jest.mock('react-native-reanimated', () => ({
  useAnimatedReaction: (
    prepare: () => number,
    react: (value: number, prev: number | null) => void,
  ) => {
    const ref = mockUseRef<Reaction | null>(null)
    if (!ref.current) {
      ref.current = {prev: null, prepare, react}
      mockReactions.push(ref.current)
    }
    ref.current.prepare = prepare
    ref.current.react = react
  },
}))
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: () => void) => fn(),
}))
jest.mock('@react-navigation/native', () => ({
  NavigationContainerRefContext: mockCreateContext(undefined),
}))
// The web painter and the web frame, as the web bundle resolves them.
jest.mock('#/horizon/backdrops/BackdropWindow', () =>
  jest.requireActual('#/horizon/backdrops/BackdropWindow.web'),
)
jest.mock('#/horizon/backdrops/viewport', () => ({
  useViewportFrame: () => mockFrame,
}))

/** Runs each reaction whose prepared value changed, as Reanimated does. */
function fireReactions() {
  for (const reaction of mockReactions) {
    const value = reaction.prepare()
    if (value !== reaction.prev) {
      reaction.react(value, reaction.prev)
      reaction.prev = value
    }
  }
}

/** A manual animation-frame queue and clock. */
function frames() {
  let clock = 0
  let next = 1
  const queue = new Map<number, () => void>()
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    requestFrame: (callback: () => void) => {
      const handle = next++
      queue.set(handle, callback)
      return handle
    },
    cancelFrame: (handle: number) => {
      queue.delete(handle)
    },
    /** Runs the frames queued now, after `ms` of clock. */
    run: (ms = 16) => {
      clock += ms
      const due = [...queue.values()]
      queue.clear()
      due.forEach(callback => callback())
    },
    pending: () => queue.size,
  }
}

/** A DOM-style event target that records its listeners. */
function target(): ListenerTarget & {fire: (type: string) => void} {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener)
    },
    fire: type => listeners.get(type)?.forEach(listener => listener()),
  }
}

const trans = registryDef('pride.trans')!

beforeEach(() => {
  mockGtMobile = false
  mockWithinDialog = false
  mockHideBorder = false
  mockFooterMode = 0
  mockHeaderMode = 0
  mockReactions.length = 0
  store.resetAppearanceStoreForTests()
})

describe('window alignment (T15)', () => {
  it('the background position comes from the window rect', () => {
    expect(windowOffset({left: 0, top: 744})).toEqual({x: -0, y: -744})
    expect(cssBackgroundPosition(2, 1, windowOffset({left: 0, top: 744}))).toBe(
      '0px 0px, 0px 0px, 0px -744px',
    )
    expect(
      cssBackgroundPosition(1, 2, windowOffset({left: -12.5, top: 3.333})),
    ).toBe('0px 0px, 12.5px -3.33px, 12.5px -3.33px')
  })

  it('the settle loop stops after two equal reads', () => {
    const f = frames()
    const rects: WindowRect[] = [
      {left: 0, top: 50},
      {left: 0, top: 40},
      {left: 0, top: 30},
      {left: 0, top: 30},
    ]
    let i = 0
    const applied: WindowRect[] = []
    const loop = createSettleLoop({
      read: () => rects[Math.min(i++, rects.length - 1)],
      apply: rect => applied.push(rect),
      ...f,
    })
    loop.start()
    expect(applied).toEqual([{left: 0, top: 50}])
    f.run()
    f.run()
    expect(loop.running()).toBe(true)
    f.run()
    expect(applied.map(r => r.top)).toEqual([50, 40, 30])
    expect(loop.running()).toBe(false)
    expect(f.pending()).toBe(0)
  })

  it('the settle loop stops 1000 ms after its start while the rect moves', () => {
    const f = frames()
    let top = 0
    let reads = 0
    const loop = createSettleLoop({
      read: () => {
        reads++
        return {left: 0, top: top++}
      },
      apply: () => {},
      ...f,
    })
    loop.start()
    // 8 ms frames (a 120 Hz display): the cap is time, not frames.
    for (let k = 0; k < 200 && loop.running(); k++) f.run(8)
    expect(loop.running()).toBe(false)
    expect(f.now()).toBeGreaterThanOrEqual(SETTLE_CAP_MS)
    expect(f.now()).toBeLessThan(SETTLE_CAP_MS + 8)
    expect(reads).toBe(Math.ceil(SETTLE_CAP_MS / 8) + 1)
  })

  it('a restart resets the clock and always re-applies', () => {
    const f = frames()
    let top = 0
    const applied: number[] = []
    const loop = createSettleLoop({
      read: () => ({left: 0, top: top++}),
      apply: rect => applied.push(rect.top),
      ...f,
    })
    loop.start()
    f.run(900)
    loop.start()
    f.run(900)
    expect(loop.running()).toBe(true)
    f.run(200)
    expect(loop.running()).toBe(false)

    const still = createSettleLoop({
      read: () => ({left: 0, top: 7}),
      apply: rect => applied.push(rect.top),
      ...f,
    })
    applied.length = 0
    still.start()
    f.run()
    still.start()
    expect(applied).toEqual([7, 7])
  })

  it('a missing node stops the loop', () => {
    const f = frames()
    let gone = false
    const loop = createSettleLoop({
      read: () => (gone ? null : {left: 0, top: Math.random()}),
      apply: () => {},
      ...f,
    })
    loop.start()
    gone = true
    f.run()
    expect(loop.running()).toBe(false)
  })

  it('every DOM and navigation trigger calls back, and detaches', () => {
    const doc = target()
    const vv = target()
    let stateListener: (() => void) | null = null
    const nav = {
      addListener: (_type: 'state', listener: () => void) => {
        stateListener = listener
        return () => {
          stateListener = null
        }
      },
    }
    const onTrigger = jest.fn()
    const detach = attachWindowTriggers(
      {document: doc, visualViewport: vv, navigation: nav},
      onTrigger,
    )
    doc.fire('scroll')
    doc.fire('animationend')
    doc.fire('transitionend')
    vv.fire('scroll')
    stateListener!()
    expect(onTrigger).toHaveBeenCalledTimes(5)
    detach()
    doc.fire('scroll')
    doc.fire('animationend')
    doc.fire('transitionend')
    vv.fire('scroll')
    expect(stateListener).toBeNull()
    expect(onTrigger).toHaveBeenCalledTimes(5)
  })
})

describe('when windows and lenses are drawn (T15)', () => {
  const base = {
    def: trans,
    frameStyle: 'bars' as const,
    gtMobile: false,
    isWithinDialog: false,
  }

  it('windows: bars only, a backdrop, not in a dialog, headers below 800', () => {
    expect(windowActive({...base, kind: 'bottomBar'})).toBe(true)
    expect(windowActive({...base, kind: 'bottomBar', def: null})).toBe(false)
    expect(
      windowActive({...base, kind: 'bottomBar', frameStyle: 'buttons'}),
    ).toBe(false)
    expect(windowActive({...base, kind: 'header', isWithinDialog: true})).toBe(
      false,
    )
    expect(windowActive({...base, kind: 'header', enabled: false})).toBe(false)
    expect(windowActive({...base, kind: 'header', gtMobile: true})).toBe(false)
    expect(windowActive({...base, kind: 'header', web: false})).toBe(false)
    expect(windowActive({...base, kind: 'drawer', gtMobile: true})).toBe(true)
    expect(windowActive({...base, kind: 'homeHeader'})).toBe(true)
  })

  it('lenses: buttons only, a backdrop, not in a dialog, header buttons below 800', () => {
    const lens = {...base, frameStyle: 'buttons' as const}
    expect(lensActive({...lens, kind: 'tab'})).toBe(true)
    expect(lensActive({...lens, kind: 'fab'})).toBe(true)
    expect(lensActive({...lens, kind: 'fab', isWithinDialog: true})).toBe(false)
    expect(lensActive({...lens, kind: 'tab', frameStyle: 'bars'})).toBe(false)
    expect(lensActive({...lens, kind: 'tab', def: null})).toBe(false)
    expect(lensActive({...lens, kind: 'headerButton', gtMobile: true})).toBe(
      false,
    )
    expect(lensActive({...lens, kind: 'headerButton'})).toBe(true)
  })

  it('the inner Home header row is not sticky while the frame is on', () => {
    expect(horizonInnerHeaderSticky()).toBe(false)
  })

  it('the bottom bar window covers the border and draws its own hairline', () => {
    expect(
      bottomBarShape({hairline: 1, hideBorder: false, borderColor: '#ccc'}),
    ).toEqual({
      top: -1,
      right: 0,
      bottom: 0,
      left: 0,
      topBorder: {width: 1, color: '#ccc'},
    })
    expect(
      bottomBarShape({hairline: 1, hideBorder: true, borderColor: '#ccc'}),
    ).toEqual({top: -1, right: 0, bottom: 0, left: 0})
  })
})

describe('FrameWindow and FrameLens on web (T15, T16)', () => {
  let rect: WindowRect = {left: 0, top: 0}
  const node = {
    isConnected: true,
    style: {} as Record<string, string>,
    getBoundingClientRect: () => rect,
  }
  const doc = target()
  const createNodeMock = (element: React.ReactElement) =>
    element.type === 'div' ? node : null
  let queue: (() => void)[] = []

  beforeEach(() => {
    rect = {left: 0, top: 0}
    node.style = {}
    queue = []
    Object.assign(globalThis, {document: doc})
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        queue.push(() => callback(0))
        return queue.length
      })
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  function runFrames(count: number) {
    for (let k = 0; k < count; k++) {
      const due = queue
      queue = []
      due.forEach(callback => callback())
    }
  }

  function divStyle(json: unknown): Record<string, unknown> {
    const tree = Array.isArray(json) ? json : [json]
    const div = tree.find(
      (n): n is {type: string; props: {style: Record<string, unknown>}} =>
        !!n && typeof n === 'object' && (n as {type?: string}).type === 'div',
    )
    if (!div) throw new Error('no div')
    return div.props.style
  }

  it('renders nothing without a backdrop, with buttons, or disabled', () => {
    expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(
      render(<FrameWindow kind="header" enabled={false} />).toJSON(),
    ).toBeNull()
    expect(render(<FrameLens kind="tab" />).toJSON()).toBeNull()
    act(() => store.setFrameStyle('buttons'))
    expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
    mockGtMobile = true
    expect(render(<FrameWindow kind="header" />).toJSON()).toBeNull()
    expect(render(<FrameLens kind="headerButton" />).toJSON()).toBeNull()
  })

  it('paints the backdrop with the glass and aligns to its rect', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    rect = {left: 0, top: 790}
    const view = render(<FrameWindow kind="bottomBar" />, {createNodeMock})
    const style = divStyle(view.toJSON())
    expect(style.top).toBeLessThan(0)
    expect(style).toMatchObject({
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      pointerEvents: 'none',
      backgroundOrigin: 'border-box',
      backgroundSize: '100% 100%, 390px 844px',
      backgroundRepeat: 'no-repeat',
    })
    expect(String(style.backgroundImage)).toMatch(
      /^linear-gradient\(rgba\(255, 255, 255, 0\.55\), rgba\(255, 255, 255, 0\.55\)\), linear-gradient\(/,
    )
    expect(String(style.borderTop)).toContain('solid')
    // Measured before paint: the frame's origin is 790px above the bar.
    expect(node.style.backgroundPosition).toBe('0px 0px, 0px -790px')
  })

  it('a footerMode change re-measures with no scroll', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    rect = {left: 0, top: 790}
    render(<FrameWindow kind="bottomBar" />, {createNodeMock})
    fireReactions()
    runFrames(3)
    expect(queue).toHaveLength(0)
    // The bar slides in on navigation: only footerMode changes.
    rect = {left: 0, top: 800}
    mockFooterMode = 0.5
    fireReactions()
    expect(node.style.backgroundPosition).toBe('0px 0px, 0px -800px')
    rect = {left: 0, top: 810}
    runFrames(1)
    expect(node.style.backgroundPosition).toBe('0px 0px, 0px -810px')
  })

  it('a document scroll and the drawer slide end re-measure', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    rect = {left: -330, top: 0}
    render(<FrameWindow kind="drawer" />, {createNodeMock})
    expect(node.style.backgroundPosition).toBe('0px 0px, 330px 0px')
    runFrames(3)
    rect = {left: 0, top: 0}
    doc.fire('animationend')
    expect(node.style.backgroundPosition).toBe('0px 0px, 0px 0px')
    rect = {left: 0, top: -20}
    doc.fire('scroll')
    expect(node.style.backgroundPosition).toBe('0px 0px, 0px 20px')
  })

  it('the Home header follows headerMode too', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    render(<FrameWindow kind="homeHeader" />, {createNodeMock})
    fireReactions()
    expect(mockReactions).toHaveLength(2)
    runFrames(3)
    rect = {left: 0, top: -30}
    mockHeaderMode = 0.4
    fireReactions()
    expect(node.style.backgroundPosition).toBe('0px 0px, 0px 30px')
  })

  it('lenses: the tab pill, and the compose button in black', () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    act(() => store.setFrameStyle('buttons'))
    const tab = divStyle(
      render(<FrameLens kind="tab" />, {createNodeMock}).toJSON(),
    )
    expect(tab).toMatchObject({
      top: 9,
      left: '50%',
      marginLeft: -28,
      width: 56,
      height: 34,
      borderRadius: 17,
    })
    const fab = divStyle(
      render(<FrameLens kind="fab" />, {createNodeMock}).toJSON(),
    )
    expect(String(fab.backgroundImage)).toMatch(
      /^linear-gradient\(rgba\(0, 0, 0, /,
    )
    const square = divStyle(
      render(<FrameLens kind="headerButton" shape="square" />, {
        createNodeMock,
      }).toJSON(),
    )
    expect(square.borderRadius).toBe(8)
    mockWithinDialog = true
    expect(render(<FrameLens kind="fab" />).toJSON()).toBeNull()
  })
})
