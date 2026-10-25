/* oxlint-disable typescript/no-require-imports -- the DOM must exist before react-dom loads */
import {act} from 'react'
import {type Root as ReactRoot} from 'react-dom/client'

/*
 * The web Menu's items with an array style (the left nav's account rows
 * pass `[a.gap_sm, {minWidth: 150}]`). Radix's `asChild` merges `style`
 * with an object spread, so an unflattened array became `{0: ..., 1: ...}`
 * and the browser threw "doesn't have an indexed property setter for '0'"
 * as the menu opened. Rendered with the real web `Menu` (Radix) in jsdom.
 */
installDom()

const {createRoot} =
  require('react-dom/client') as typeof import('react-dom/client')
const Menu = require('#/components/Menu/index.web') as typeof import(
  '#/components/Menu/index.web'
)
const {i18n} = require('@lingui/core') as typeof import('@lingui/core')
const {I18nProvider} =
  require('@lingui/react') as typeof import('@lingui/react')
i18n.loadAndActivate({locale: 'en', messages: {}})

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
  const {Text} = require('react-native-web')
  return {
    Text: ({children}: React.PropsWithChildren) => <Text>{children}</Text>,
  }
})

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

it('an item with an array style opens with that style applied, no "0" key', async () => {
  const {Pressable} = require('react-native-web')
  function Harness() {
    const control = Menu.useMenuControl()
    return (
      <Menu.Root control={control}>
        <Menu.Trigger label="Open">
          {({props}) => (
            // The menu's own trigger pressable wraps this one; jsdom warns
            // about the nesting, which the app's Button triggers also have.
            <Pressable {...props} testID="trigger" accessibilityHint="" />
          )}
        </Menu.Trigger>
        <Menu.Outer>
          <Menu.Group>
            <Menu.Item
              testID="arrayStyled"
              label="Switch to @lala.test"
              style={[{gap: 4}, {minWidth: 150}]}
              onPress={() => {}}>
              <Menu.ItemText>@lala.test</Menu.ItemText>
            </Menu.Item>
          </Menu.Group>
        </Menu.Outer>
      </Menu.Root>
    )
  }
  await act(async () => {
    root.render(
      <I18nProvider i18n={i18n}>
        <Harness />
      </I18nProvider>,
    )
    await Promise.resolve()
  })
  const trigger = document.querySelector('[data-testid="trigger"]')
  expect(trigger).not.toBeNull()
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('click', {bubbles: true}))
    await Promise.resolve()
  })
  const item = document.querySelector<HTMLElement>(
    '[data-testid="arrayStyled"]',
  )
  expect(item).not.toBeNull()
  // The caller's style reached the element as CSS.
  expect(item!.style.minWidth).toBe('150px')
  // Nothing tried to set an indexed property.
  expect(item!.getAttribute('style') ?? '').not.toMatch(/(^|;)\s*0\s*:/)
})
