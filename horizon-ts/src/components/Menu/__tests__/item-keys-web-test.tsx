/* oxlint-disable typescript/no-require-imports -- the DOM must exist before react-dom loads */
import {act, useState} from 'react'
import {type GestureResponderEvent} from 'react-native'
import {type Root as ReactRoot} from 'react-dom/client'

/*
 * On web, a stock `Menu.Item` fires its `onPress` once per Enter, Space or
 * click. Radix's keydown clicks the item for Enter and Space, and
 * react-native-web's Pressable would press it again on Enter's keyup: a
 * toggle flipped back and an action ran twice. Rendered with the real web
 * `Menu` (Radix) in jsdom, as `RepostButtonMenu.web.test.tsx` does.
 */
installDom()

const {createRoot} =
  require('react-dom/client') as typeof import('react-dom/client')
const Menu =
  require('#/components/Menu/index.web') as typeof import('#/components/Menu/index.web')
// react-native is mocked to react-native-web below.
const {Pressable, Text} =
  require('react-native') as typeof import('react-native')

function installDom() {
  const {JSDOM} = require('jsdom') as {
    JSDOM: new (html: string) => {window: Record<string, unknown>}
  }
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
  )
  const win = dom.window
  const g = globalThis as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(win)) {
    // Node's own Event classes can't be dispatched on jsdom nodes
    const ownEventClass = /^(Custom)?Event(Target)?$/.test(key)
    if ((key in g && !ownEventClass) || key === 'window' || key === 'self') {
      continue
    }
    try {
      g[key] = win[key]
    } catch {}
  }
  for (const key of [
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
    'getComputedStyle',
    'getSelection',
  ]) {
    g[key] = (win[key] as (...args: unknown[]) => unknown).bind(win)
  }
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

jest.mock('react-native', () => require('react-native-web'))
jest.mock('#/state/a11y', () => ({
  useA11y: () => ({reduceMotionEnabled: true}),
}))
jest.mock('#/alf', () => {
  const empty = new Proxy({}, {get: () => ({})})
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : style && typeof style === 'object'
        ? (style as Record<string, unknown>)
        : {}
  return {
    atoms: empty,
    flatten,
    flattenToCSS: flatten,
    web: (style: unknown) => style,
    useTheme: () => ({
      name: 'light',
      atoms: empty,
      palette: new Proxy({}, {get: () => 'black'}),
    }),
  }
})
jest.mock('#/components/Portal', () => ({
  Portal: ({children}: React.PropsWithChildren) => children,
}))
jest.mock('#/components/Typography', () => {
  const {Text: RNText} = require('react-native-web')
  return {
    Text: ({children}: React.PropsWithChildren) => <RNText>{children}</RNText>,
  }
})
jest.mock('@lingui/react', () => ({
  useLingui: () => ({
    _: (message: {message?: string} | string) =>
      typeof message === 'string' ? message : message.message,
  }),
}))

/** Runs `fn` in act and lets floating-ui's async position update land too. */
async function actAndSettle(fn: () => void) {
  await act(async () => {
    fn()
    await Promise.resolve()
  })
}

const onAction = jest.fn()
const onToggle = jest.fn()

/** A menu with an action item (closes) and a toggle item (stays open). */
function TestMenu() {
  const [on, setOn] = useState(false)
  return (
    <Menu.Root>
      <Menu.Trigger label="Open">
        {({props}) => (
          <Pressable {...props} testID="trigger">
            <Text>Open</Text>
          </Pressable>
        )}
      </Menu.Trigger>
      <Menu.Outer>
        <Menu.Item testID="action" label="Action" onPress={() => onAction()}>
          <Menu.ItemText>Action</Menu.ItemText>
        </Menu.Item>
        <Menu.Item
          testID="toggle"
          label="Toggle"
          onPress={(e: GestureResponderEvent) => {
            e.preventDefault()
            onToggle()
            setOn(value => !value)
          }}>
          <Menu.ItemText>Toggle</Menu.ItemText>
          {on ? <Text testID="toggleOn">on</Text> : null}
        </Menu.Item>
      </Menu.Outer>
    </Menu.Root>
  )
}

let container: HTMLDivElement
let root: ReactRoot

beforeEach(() => {
  onAction.mockClear()
  onToggle.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function openMenu() {
  await actAndSettle(() => root.render(<TestMenu />))
  await actAndSettle(() => {
    byTestId('trigger').dispatchEvent(new MouseEvent('click', {bubbles: true}))
  })
  expect(menu()).not.toBeNull()
}

function menu() {
  return document.querySelector('[role="menu"]')
}

function byTestId(testID: string) {
  const node = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`)
  if (!node) throw new Error(`no ${testID}`)
  return node
}

function isOn() {
  return document.querySelector('[data-testid="toggleOn"]') !== null
}

async function key(node: HTMLElement, name: string) {
  await actAndSettle(() => {
    node.focus()
    node.dispatchEvent(new KeyboardEvent('keydown', {key: name, bubbles: true}))
  })
  // The keyup lands on whatever has focus now, as in a browser.
  await actAndSettle(() => {
    const target = (document.activeElement as HTMLElement | null) ?? node
    target.dispatchEvent(new KeyboardEvent('keyup', {key: name, bubbles: true}))
  })
}

describe('a stock Menu.Item on web fires once per activation', () => {
  it.each(['Enter', ' '])('the %j key runs an action item once', async name => {
    await openMenu()

    await key(byTestId('action'), name)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  it('a click runs an action item once', async () => {
    await openMenu()

    await actAndSettle(() => {
      byTestId('action').dispatchEvent(new MouseEvent('click', {bubbles: true}))
    })
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  it.each(['Enter', ' '])(
    'the %j key flips a toggle item once and keeps the menu open',
    async name => {
      await openMenu()

      await key(byTestId('toggle'), name)
      expect(onToggle).toHaveBeenCalledTimes(1)
      expect(isOn()).toBe(true)
      expect(menu()).not.toBeNull()

      await key(byTestId('toggle'), name)
      expect(onToggle).toHaveBeenCalledTimes(2)
      expect(isOn()).toBe(false)
    },
  )

  it('a click flips a toggle item once', async () => {
    await openMenu()

    await actAndSettle(() => {
      byTestId('toggle').dispatchEvent(new MouseEvent('click', {bubbles: true}))
    })
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(isOn()).toBe(true)
    expect(menu()).not.toBeNull()
  })
})
