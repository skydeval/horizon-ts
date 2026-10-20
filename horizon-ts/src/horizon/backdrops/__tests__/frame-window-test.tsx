import {createContext as mockCreateContext, useRef as mockUseRef} from 'react'
import {StyleSheet} from 'react-native'
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {
  BackdropWindow,
  pinnedToViewport,
} from '#/horizon/backdrops/BackdropWindow.web'
import {
  bottomBarShape,
  horizonInnerHeaderSticky,
  shadeVar,
  windowActive,
} from '#/horizon/backdrops/frame'
import {
  createWindowTracker,
  type ListenerTarget,
  QUIET_FRAMES,
  SETTLE_CAP_MS,
  type TrackedWindow,
  windowOffset,
  type WindowRect,
} from '#/horizon/backdrops/frame-tracking'
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

type Listener = (event?: {target?: unknown}) => void

/** A DOM-style event target that records its listeners. */
function target(): ListenerTarget & {
  fire: (type: string, event?: {target?: unknown}) => void
  count: (type: string) => number
} {
  const listeners = new Map<string, Set<Listener>>()
  return {
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener)
    },
    fire: (type, event) =>
      listeners.get(type)?.forEach(listener => listener(event)),
    count: type => listeners.get(type)?.size ?? 0,
  }
}

/** A tracker on fake targets, a manual frame queue, clock and microtasks. */
function fakeTracker() {
  let clock = 0
  let next = 1
  const frames = new Map<number, () => void>()
  const micro: (() => void)[] = []
  const doc = target()
  const win = target()
  const vv = target()
  const tracker = createWindowTracker({
    document: doc,
    window: win,
    visualViewport: vv,
    requestFrame: callback => {
      const handle = next++
      frames.set(handle, callback)
      return handle
    },
    cancelFrame: handle => {
      frames.delete(handle)
    },
    now: () => clock,
    microtask: callback => {
      micro.push(callback)
    },
  })
  return {
    tracker,
    doc,
    win,
    vv,
    flush: () => micro.splice(0).forEach(callback => callback()),
    /** Runs the frames queued now, after `ms` of clock. */
    frame: (ms = 16) => {
      clock += ms
      const due = [...frames.values()]
      frames.clear()
      due.forEach(callback => callback())
    },
    pending: () => frames.size,
  }
}

/** A window that logs its reads and writes into `log`. */
function logged(
  name: string,
  log: string[],
  rect: {current: WindowRect | null},
  extra: Partial<TrackedWindow> = {},
): TrackedWindow {
  return {
    read: () => {
      log.push(`read ${name}`)
      return rect.current
    },
    apply: r => log.push(`apply ${name} ${r.top}`),
    ...extra,
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

describe('the shared window tracker (7b)', () => {
  it('the offset is the frame origin inside the window', () => {
    expect(windowOffset({left: 0, top: 744})).toEqual({x: -0, y: -744})
  })

  it('reads every window first, then writes only those that moved', () => {
    const f = fakeTracker()
    const log: string[] = []
    const a = {current: {left: 0, top: 0}}
    const b = {current: {left: 0, top: 790}}
    f.tracker.register(logged('a', log, a))
    f.tracker.register(logged('b', log, b))
    // Aligned before paint, in one batch for both.
    f.flush()
    expect(log).toEqual(['read a', 'read b', 'apply a 0', 'apply b 790'])
    log.length = 0
    b.current = {left: 0, top: 800}
    f.doc.fire('scroll')
    f.frame()
    expect(log).toEqual(['read a', 'read b', 'apply b 800'])
  })

  it(`stops after ${QUIET_FRAMES} quiet frames`, () => {
    const f = fakeTracker()
    const log: string[] = []
    const rect = {current: {left: 0, top: 50}}
    f.tracker.register(logged('a', log, rect))
    f.flush()
    rect.current = {left: 0, top: 40}
    f.frame()
    expect(f.tracker.running()).toBe(true)
    f.frame()
    f.frame()
    expect(f.tracker.running()).toBe(false)
    expect(f.pending()).toBe(0)
    expect(log.filter(line => line.startsWith('apply'))).toEqual([
      'apply a 50',
      'apply a 40',
    ])
  })

  it('stops 1000 ms after the last trigger while a window moves', () => {
    const f = fakeTracker()
    let top = 0
    f.tracker.register({read: () => ({left: 0, top: top++}), apply: () => {}})
    f.flush()
    // 8 ms frames (a 120 Hz display): the cap is time, not frames.
    for (let k = 0; k < 200 && f.tracker.running(); k++) f.frame(8)
    expect(f.tracker.running()).toBe(false)
    expect(top).toBe(Math.ceil(SETTLE_CAP_MS / 8) + 1)
    // A trigger restarts the clock.
    f.tracker.kick()
    f.frame(900)
    f.tracker.kick()
    f.frame(900)
    expect(f.tracker.running()).toBe(true)
  })

  it('a hidden window is not read until it shows again', () => {
    const f = fakeTracker()
    const log: string[] = []
    const rect = {current: {left: 0, top: 0}}
    const w = logged('a', log, rect)
    f.tracker.register(w)
    f.flush()
    f.tracker.setVisible(w, false)
    log.length = 0
    f.doc.fire('scroll')
    f.frame()
    f.frame()
    expect(log).toEqual([])
    rect.current = {left: 0, top: 20}
    f.tracker.setVisible(w, true)
    f.frame()
    expect(log).toEqual(['read a', 'apply a 20'])
  })

  it('a gone window is skipped, and nothing is written for it', () => {
    const f = fakeTracker()
    const log: string[] = []
    f.tracker.register(logged('a', log, {current: null}))
    f.flush()
    expect(log).toEqual(['read a'])
  })

  it('static windows: not on page scroll; on resize, relayout and their own scroller', () => {
    const f = fakeTracker()
    const log: string[] = []
    const scroller = {}
    const card = {current: {left: 1100, top: 16}}
    f.tracker.register(
      logged('card', log, card, {
        isStatic: true,
        within: t => t === scroller,
      }),
    )
    f.flush()
    expect(log).toEqual(['read card', 'apply card 16'])
    // Settled.
    f.frame()
    f.frame()
    expect(f.pending()).toBe(0)
    log.length = 0
    // Page scroll: no tracking at all for a static window.
    f.doc.fire('scroll', {target: {}})
    expect(f.pending()).toBe(0)
    f.frame()
    expect(log).toEqual([])
    // Its own scroller.
    card.current = {left: 1100, top: 10}
    f.doc.fire('scroll', {target: scroller})
    f.frame()
    expect(log).toEqual(['read card', 'apply card 10'])
    log.length = 0
    f.win.fire('resize')
    f.frame()
    expect(log).toEqual(['read card'])
    log.length = 0
    f.tracker.relayout()
    f.frame()
    expect(log).toEqual(['read card'])
  })

  it('pinned windows: not on page scroll; on a slide, resize, the visual viewport and their own scroller (round 2)', () => {
    const f = fakeTracker()
    const log: string[] = []
    const scroller = {}
    const bar = {current: {left: 0, top: 790}}
    f.tracker.register(
      logged('bar', log, bar, {pinned: true, within: t => t === scroller}),
    )
    f.flush()
    f.frame()
    f.frame()
    expect(f.pending()).toBe(0)
    log.length = 0
    // Page scroll: a fixed piece cannot move, so nothing is read.
    f.doc.fire('scroll', {target: {}})
    expect(f.pending()).toBe(0)
    // A slide (minimal shell) reads it every frame until it settles.
    f.tracker.kick()
    bar.current = {left: 0, top: 800}
    f.frame()
    expect(log).toEqual(['read bar', 'apply bar 800'])
    f.frame()
    f.frame()
    expect(f.pending()).toBe(0)
    log.length = 0
    // A scroller around it.
    f.doc.fire('scroll', {target: scroller})
    f.frame()
    expect(log).toEqual(['read bar'])
    f.frame()
    f.frame()
    log.length = 0
    f.vv.fire('scroll')
    f.frame()
    expect(log).toEqual(['read bar'])
    f.frame()
    f.frame()
    log.length = 0
    f.win.fire('resize')
    f.frame()
    expect(log).toEqual(['read bar'])
  })

  it('a page scroll still reads a window that is not pinned, and a pinned one with it', () => {
    const f = fakeTracker()
    const log: string[] = []
    f.tracker.register(logged('sticky', log, {current: {left: 0, top: 0}}))
    f.tracker.register(
      logged('bar', log, {current: {left: 0, top: 790}}, {pinned: true}),
    )
    f.flush()
    f.frame()
    f.frame()
    expect(f.pending()).toBe(0)
    log.length = 0
    f.doc.fire('scroll', {target: {}})
    f.frame()
    expect(log).toEqual(['read sticky', 'read bar'])
  })

  it('one listener per trigger for any number of windows, all detached', () => {
    const f = fakeTracker()
    const off = [1, 2, 3, 4].map(i =>
      f.tracker.register({read: () => ({left: 0, top: i}), apply: () => {}}),
    )
    expect(f.doc.count('scroll')).toBe(1)
    expect(f.vv.count('scroll')).toBe(1)
    expect(f.win.count('resize')).toBe(1)
    // Animation ends are not listened to until a window follows them.
    expect(f.doc.count('transitionend')).toBe(0)
    expect(f.doc.count('animationend')).toBe(0)
    const offDrawer = f.tracker.register({
      read: () => ({left: 0, top: 0}),
      apply: () => {},
      followsAnimations: true,
    })
    expect(f.doc.count('transitionend')).toBe(1)
    expect(f.doc.count('animationend')).toBe(1)
    offDrawer()
    expect(f.doc.count('transitionend')).toBe(0)
    off.forEach(detach => detach())
    expect(f.doc.count('scroll')).toBe(0)
    expect(f.vv.count('scroll')).toBe(0)
    expect(f.win.count('resize')).toBe(0)
  })

  it('an animation end restarts only for a window inside the animated element', () => {
    const f = fakeTracker()
    const drawer = {}
    let reads = 0
    f.tracker.register({
      read: () => {
        reads++
        return {left: 0, top: 0}
      },
      apply: () => {},
      followsAnimations: true,
      within: t => t === drawer,
    })
    f.flush()
    f.frame()
    f.frame()
    expect(f.pending()).toBe(0)
    // A button's hover transition elsewhere: nothing.
    f.doc.fire('transitionend', {target: {}})
    expect(f.pending()).toBe(0)
    f.doc.fire('animationend', {target: drawer})
    expect(f.pending()).toBe(1)
    const before = reads
    f.frame()
    expect(reads).toBe(before + 1)
  })

  it('the navigation state event is shared and counted', () => {
    const f = fakeTracker()
    const listeners = new Set<() => void>()
    const nav = {
      addListener: (_type: 'state', listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    f.tracker.register({read: () => ({left: 0, top: 0}), apply: () => {}})
    const off1 = f.tracker.attachNavigation(nav)
    const off2 = f.tracker.attachNavigation(nav)
    expect(listeners.size).toBe(1)
    f.flush()
    f.frame()
    f.frame()
    expect(f.pending()).toBe(0)
    listeners.forEach(listener => listener())
    expect(f.pending()).toBe(1)
    off1()
    expect(listeners.size).toBe(1)
    off2()
    expect(listeners.size).toBe(0)
  })
})

describe('when windows are drawn (T15)', () => {
  const base = {
    def: trans,
    frameStyle: 'bars' as const,
    gtMobile: false,
    isWithinDialog: false,
  }

  it('windows: a backdrop, not in a dialog, headers below 800', () => {
    expect(windowActive({...base, kind: 'bottomBar'})).toBe(true)
    expect(windowActive({...base, kind: 'bottomBar', def: null})).toBe(false)
    expect(
      windowActive({...base, kind: 'bottomBar', frameStyle: 'headerBand'}),
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

type Json = {
  type: string
  props: {style?: Record<string, unknown>}
  children: (Json | string)[] | null
}

function divs(json: unknown): Json[] {
  const out: Json[] = []
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const n = node as Json
    if (n.type === 'div') out.push(n)
    n.children?.forEach(walk)
  }
  walk(json)
  return out
}

describe('FrameWindow on web (T15, T16, 7b)', () => {
  let rect = {left: 0, top: 0, width: 390, height: 50}
  const vars = new Map<string, string>()
  const attributes = new Set<string>()
  const piece = {
    style: {
      setProperty: (name: string, value: string) => vars.set(name, value),
      removeProperty: (name: string) => vars.delete(name),
    },
    setAttribute: (name: string) => attributes.add(name),
    removeAttribute: (name: string) => attributes.delete(name),
  }
  const outer = {
    isConnected: true,
    parentElement: piece,
    getBoundingClientRect: () => rect,
    style: {} as Record<string, string>,
  }
  const inner = {style: {} as Record<string, string>}
  const createNodeMock = (element: React.ReactElement) => {
    if (element.type !== 'div') return null
    const style = (element.props as {style?: Record<string, unknown>}).style
    if (style?.zIndex === -1) return outer
    if (style?.willChange === 'transform') return inner
    return {style: {}}
  }
  let queue: (() => void)[] = []
  const doc = target()

  beforeEach(() => {
    rect = {left: 0, top: 0, width: 390, height: 50}
    inner.style = {}
    outer.style = {}
    vars.clear()
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

  /** Renders, then lets the before-paint alignment run. */
  async function mount(element: React.ReactElement) {
    const view = render(element, {createNodeMock})
    await act(async () => {})
    return view
  }

  it('renders nothing without a backdrop, where the style draws none, or disabled', () => {
    expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    expect(
      render(<FrameWindow kind="header" enabled={false} />).toJSON(),
    ).toBeNull()
    act(() => store.setFrameStyle('gutter'))
    expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
    mockGtMobile = true
    expect(render(<FrameWindow kind="header" />).toJSON()).toBeNull()
  })

  it('Bars: the backdrop bare, in a frame-sized layer moved by a transform', async () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    rect = {left: 0, top: 790, width: 390, height: 54}
    const view = await mount(<FrameWindow kind="bottomBar" />)
    const [clip, backdrop, hairline, ...rest] = divs(view.toJSON())
    expect(rest).toEqual([])
    expect(clip.props.style?.top).toBeLessThan(0)
    expect(clip.props.style).toMatchObject({
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: -1,
      pointerEvents: 'none',
      overflow: 'hidden',
    })
    expect(clip.props.style?.backgroundImage).toBeUndefined()
    expect(backdrop.props.style).toMatchObject({
      position: 'absolute',
      top: 0,
      left: 0,
      width: 390,
      height: 844,
      willChange: 'transform',
      backgroundSize: '390px 844px',
      backgroundRepeat: 'no-repeat',
    })
    // No glass: the first layer is the backdrop's own gradient.
    expect(String(backdrop.props.style?.backgroundImage)).toMatch(
      /^linear-gradient\(\d/,
    )
    expect(hairline.props.style).toMatchObject({
      top: 0,
      height: StyleSheet.hairlineWidth,
    })
    // Aligned before paint: the frame's origin is 790px above the bar.
    expect(inner.style.transform).toBe('translate3d(0px, -790px, 0)')
    // The bare window hands its items their shade colours.
    expect(vars.get(shadeVar('tab'))).toMatch(/^rgba\(255, 255, 255, /)
    expect([...vars.keys()]).toHaveLength(15)
  })

  it('a footerMode change re-measures with no scroll', async () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    rect = {left: 0, top: 790, width: 390, height: 54}
    await mount(<FrameWindow kind="bottomBar" />)
    fireReactions()
    runFrames(4)
    expect(queue).toHaveLength(0)
    // The bar slides in on navigation: only footerMode changes.
    rect = {left: 0, top: 800, width: 390, height: 54}
    mockFooterMode = 0.5
    fireReactions()
    runFrames(1)
    expect(inner.style.transform).toBe('translate3d(0px, -800px, 0)')
    rect = {left: 0, top: 810, width: 390, height: 54}
    runFrames(1)
    expect(inner.style.transform).toBe('translate3d(0px, -810px, 0)')
  })

  it('a document scroll re-measures in the next frame, not in the handler', async () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    await mount(<FrameWindow kind="drawer" />)
    runFrames(4)
    rect = {left: 0, top: -20, width: 330, height: 844}
    doc.fire('scroll')
    // No read or write inside the scroll event.
    expect(inner.style.transform).toBe('translate3d(0px, 0px, 0)')
    runFrames(1)
    expect(inner.style.transform).toBe('translate3d(0px, 20px, 0)')
  })

  it('the drawer keeps its glass: a tint layer above the backdrop', async () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    const view = await mount(<FrameWindow kind="drawer" />)
    const [, , glass] = divs(view.toJSON())
    expect(glass.props.style?.backgroundImage).toBe(
      'linear-gradient(rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.55))',
    )
    expect([...vars.keys()]).toHaveLength(0)
  })

  it('the Home header follows headerMode too', async () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    await mount(<FrameWindow kind="homeHeader" />)
    fireReactions()
    expect(mockReactions).toHaveLength(2)
    runFrames(4)
    rect = {left: 0, top: -30, width: 390, height: 95}
    mockHeaderMode = 0.4
    fireReactions()
    runFrames(1)
    expect(inner.style.transform).toBe('translate3d(0px, 30px, 0)')
  })

  it('a static window paints on its clip and is aligned by background-position (round 2)', async () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    rect = {left: 1048, top: 21, width: 300, height: 299}
    const view = await mount(
      <BackdropWindow
        def={trans}
        overlays={['rgba(255, 255, 255, 0.55)']}
        shape={{top: 0, right: 0, bottom: 0, left: 0, borderRadius: 15}}
        isStatic
      />,
    )
    const [clip, ...rest] = divs(view.toJSON())
    // No frame-sized layer and no overlay layer: nothing to composite.
    expect(rest).toEqual([])
    expect(clip.props.style?.willChange).toBeUndefined()
    const layers = String(clip.props.style?.backgroundSize).split(', ')
    expect(layers[0]).toBe('100% 100%')
    expect(layers.slice(1).every(size => size === '390px 844px')).toBe(true)
    // Aligned before paint: the glass at the origin, the backdrop moved
    // by the card's place in the viewport.
    expect(outer.style.backgroundPosition).toBe(
      ['0px 0px', ...layers.slice(1).map(() => '-1048px -21px')].join(', '),
    )
    expect(inner.style.transform).toBeUndefined()
    // Page scroll: nothing is read again.
    rect = {left: 1048, top: 0, width: 300, height: 299}
    doc.fire('scroll', {target: {}})
    runFrames(2)
    expect(outer.style.backgroundPosition).toContain('-1048px -21px')
  })

  it('unmounting takes the shade colours off the piece', async () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    const view = await mount(<FrameWindow kind="homeHeader" />)
    expect(vars.size).toBe(15)
    // Marked bare, so the halo's recolouring applies only here.
    expect(attributes.has('data-horizon-bare')).toBe(true)
    view.unmount()
    expect(vars.size).toBe(0)
    expect(attributes.has('data-horizon-bare')).toBe(false)
  })

  it('Header: the Home header bare, handing its items their shade colours (round 2 list)', async () => {
    act(() => store.selectBackdrop(undefined, 'pride.trans'))
    act(() => store.setFrameStyle('headerBand'))
    rect = {left: 0, top: 0, width: 390, height: 95}
    const view = await mount(<FrameWindow kind="homeHeader" />)
    const [, backdrop, ...rest] = divs(view.toJSON())
    // No glass layer: the backdrop alone.
    expect(rest).toEqual([])
    expect(String(backdrop.props.style?.backgroundImage)).toMatch(
      /^linear-gradient\(\d/,
    )
    expect(vars.size).toBe(15)
    expect(render(<FrameWindow kind="bottomBar" />).toJSON()).toBeNull()
  })
})

describe('pinnedToViewport (round 2)', () => {
  class FakeElement {
    constructor(
      public position: string,
      public parentElement: FakeElement | null,
    ) {}
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = {Element: globals.Element, gcs: globals.getComputedStyle}

  beforeEach(() => {
    globals.Element = FakeElement
    globals.getComputedStyle = (el: FakeElement) => ({position: el.position})
  })

  afterEach(() => {
    globals.Element = saved.Element
    globals.getComputedStyle = saved.gcs
  })

  const chain = (...positions: string[]) =>
    positions.reduceRight<FakeElement | null>(
      (parent, position) => new FakeElement(position, parent),
      null,
    ) as unknown as Element

  it('a window under a fixed piece is pinned', () => {
    // The window, then its piece and the piece's ancestors.
    expect(
      pinnedToViewport(chain('absolute', 'relative', 'fixed', 'static')),
    ).toBe(true)
  })

  it('a sticky box on the way, or no fixed ancestor, is not', () => {
    expect(pinnedToViewport(chain('absolute', 'sticky', 'fixed'))).toBe(false)
    expect(pinnedToViewport(chain('absolute', 'relative', 'static'))).toBe(
      false,
    )
  })

  it('without a DOM, never', () => {
    globals.Element = undefined
    expect(pinnedToViewport(chain('absolute', 'fixed'))).toBe(false)
  })
})
