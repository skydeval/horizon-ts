import {act} from 'react'
import {type Root as ReactRoot} from 'react-dom/client'

/*
 * The React Native jest preset redefines `window` as the global object, so the
 * jsdom environment can't load. Install a jsdom document on the global instead,
 * before react-dom and Radix are required, so they see a DOM.
 */
installDom()

const {createRoot} =
  require('react-dom/client') as typeof import('react-dom/client')
const Menu =
  require('#/components/Menu/index.web') as typeof import('#/components/Menu/index.web')
const {RepostButtonMenu} =
  require('./RepostButtonMenu') as typeof import('./RepostButtonMenu')

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
jest.mock('#/components/Menu', () => require('#/components/Menu/index.web'))
jest.mock('#/state/session', () => ({
  useRequireAuth: () => (callback: () => void) => callback(),
  useSession: () => ({hasSession: true}),
}))
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
  const {Text} = require('react-native-web')
  return {
    Text: ({children}: React.PropsWithChildren) => <Text>{children}</Text>,
  }
})
jest.mock('#/components/icons/Quote', () => ({
  CloseQuote_Stroke2_Corner1_Rounded: () => null,
}))
jest.mock('#/components/icons/Repost', () => ({
  Repost_Stroke2_Corner2_Rounded: () => null,
}))
jest.mock('#/components/PostControls/util', () => ({
  useFormatPostStatCount: () => String,
}))
jest.mock('#/view/com/util/EventStopper', () => ({
  EventStopper: ({children}: React.PropsWithChildren) => children,
}))
jest.mock('./PostControlButton', () => {
  const {Pressable, Text} = require('react-native-web')
  return {
    PostControlButton: ({
      children,
      label,
      onPress,
      testID,
      ref,
    }: React.PropsWithChildren<{
      label?: string
      onPress?: () => void
      testID?: string
      ref?: React.Ref<unknown>
    }>) => (
      <Pressable
        ref={ref}
        accessibilityHint=""
        accessibilityLabel={label}
        onPress={onPress}
        testID={testID}>
        {children}
      </Pressable>
    ),
    PostControlButtonIcon: () => null,
    PostControlButtonText: ({children}: React.PropsWithChildren) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('@lingui/react', () => ({
  useLingui: () => ({
    _: (message: {message?: string} | string) =>
      typeof message === 'string' ? message : message.message,
  }),
}))
jest.mock('@lingui/react/macro', () => ({
  useLingui: () => ({
    t: (
      strings: TemplateStringsArray | {message: string},
      ...values: unknown[]
    ) =>
      'raw' in strings
        ? String.raw({raw: strings}, ...values)
        : strings.message,
  }),
}))

/** The marks react-remove-scroll(-bar) leaves while it locks page scroll. */
function isScrollLocked() {
  const lockedStyle = Array.from(document.querySelectorAll('style')).some(
    style => /overflow:\s*hidden/.test(style.textContent ?? ''),
  )
  return (
    document.body.hasAttribute('data-scroll-locked') ||
    document.body.style.overflow === 'hidden' ||
    lockedStyle
  )
}

/** Runs `fn` in act and lets floating-ui's async position update land too. */
async function actAndSettle(fn: () => void) {
  await act(async () => {
    fn()
    await Promise.resolve()
  })
}

let container: HTMLDivElement
let root: ReactRoot

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function openRepostMenu() {
  await actAndSettle(() =>
    root.render(
      <RepostButtonMenu
        isReposted={false}
        onRepost={jest.fn()}
        onQuote={jest.fn()}
        embeddingDisabled={false}
      />,
    ),
  )
  const trigger = document.querySelector('[data-testid="repostBtn"]')
  expect(trigger).not.toBeNull()
  await actAndSettle(() => {
    trigger!.dispatchEvent(new MouseEvent('click', {bubbles: true}))
  })
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
}

describe('RepostButtonMenu on web', () => {
  it('leaves the page scrollable while the menu is open', async () => {
    await openRepostMenu()

    expect(isScrollLocked()).toBe(false)
  })

  it('closes when the window scrolls', async () => {
    await openRepostMenu()

    await actAndSettle(() => {
      window.dispatchEvent(new Event('scroll'))
    })

    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('closes on a click outside the menu', async () => {
    await openRepostMenu()

    const backdrop = document.querySelector(
      '[aria-label="Context menu backdrop, click to close the menu."]',
    )
    expect(backdrop).not.toBeNull()
    await actAndSettle(() => {
      backdrop!.dispatchEvent(new MouseEvent('click', {bubbles: true}))
    })

    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('closes on Escape', async () => {
    await openRepostMenu()

    await actAndSettle(() => {
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(
          new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}),
        )
    })

    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('Menu.Root on web', () => {
  function OpenMenu({modal}: {modal?: boolean}) {
    const control = Menu.useMenuControl()
    return (
      <Menu.Root control={{...control, isOpen: true}} modal={modal}>
        <Menu.Outer>
          <Menu.Item label="Item" onPress={() => {}}>
            <Menu.ItemText>Item</Menu.ItemText>
          </Menu.Item>
        </Menu.Outer>
      </Menu.Root>
    )
  }

  it('still locks page scroll by default (modal)', async () => {
    await actAndSettle(() => root.render(<OpenMenu />))

    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(isScrollLocked()).toBe(true)
  })

  it('does not lock page scroll with modal={false}', async () => {
    await actAndSettle(() => root.render(<OpenMenu modal={false} />))

    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(isScrollLocked()).toBe(false)
  })
})
