/* oxlint-disable typescript/no-require-imports -- the DOM must exist before react-dom loads */
import {act, useState} from 'react'
import {type Root as ReactRoot} from 'react-dom/client'

import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {type app} from '#/lexicons'

/*
 * The audience menu's toggle rows on web flip exactly once per Enter or
 * Space. They keep the menu open (their press is default-prevented), so
 * react-native-web's keyup press used to land on them after Radix's keydown
 * click and flip them straight back. Rendered with the real web `Menu`
 * (Radix) in jsdom, as `control-a11y-web-test.tsx` does.
 */
installDom()

const {createRoot} =
  require('react-dom/client') as typeof import('react-dom/client')
const {i18n} = require('@lingui/core') as typeof import('@lingui/core')
const {I18nProvider} =
  require('@lingui/react') as typeof import('@lingui/react')
const {AudienceMenu} =
  require('../AudienceMenu') as typeof import('../AudienceMenu')

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
jest.mock('#/components/Button', () => {
  const {Pressable} = require('react-native-web')
  return {
    Button: ({
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
    ButtonIcon: () => null,
    ButtonText: ({children}: React.PropsWithChildren) => children,
  }
})
jest.mock('#/components/Dialog', () => ({
  useDialogControl: () => ({open: () => {}}),
}))
jest.mock('#/components/Tooltip', () => ({}))
jest.mock('#/components/icons/Check', () => ({
  Check_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Chevron', () => ({
  TinyChevronBottom_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Globe', () => ({
  Earth_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Group', () => ({
  Group3_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/List', () => ({
  ListPlus_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Person', () => ({
  Person_Stroke2_Corner0_Rounded: () => null,
  PersonGroup_Stroke2_Corner2_Rounded: () => null,
}))
jest.mock('#/components/icons/Quote', () => ({
  CloseQuote_Stroke2_Corner1_Rounded: () => null,
}))
jest.mock('#/view/com/util/UserAvatar', () => ({UserAvatar: () => null}))
jest.mock('#/analytics', () => ({
  useAnalytics: () => ({metric: () => {}}),
}))
jest.mock('#/horizon/posting-as/account', () => ({
  usePostingCurateLists: () => ({data: [], isPending: false, isError: false}),
}))
jest.mock('#/horizon/posting-as/gates', () => ({retryPostingReads: () => {}}))
jest.mock('#/horizon/private/api/audiences', () => ({
  audienceLabel: () => '',
}))
jest.mock('#/horizon/private/audiences/AudienceEditorDialog', () => ({
  AudienceEditorDialog: () => null,
}))
jest.mock('#/horizon/private/audiences/useAudiencesQuery', () => ({
  useAudiencesQuery: () => ({data: []}),
}))
jest.mock('#/storage/hooks/threadgate-nudged', () => ({
  useThreadgateNudged: () => [true, () => {}],
}))

i18n.loadAndActivate({locale: 'en', messages: {}})

/** Runs `fn` in act and lets floating-ui's async position update land too. */
async function actAndSettle(fn: () => void) {
  await act(async () => {
    fn()
    await Promise.resolve()
  })
}

const onThreadgate = jest.fn()
const onPostgate = jest.fn()

/** The menu with its settings held in state, as the composer holds them. */
function Harness() {
  const [threadgate, setThreadgate] = useState<ThreadgateAllowUISetting[]>([
    {type: 'everybody'},
  ])
  const [postgate, setPostgate] = useState<app.bsky.feed.postgate.Main>({
    $type: 'app.bsky.feed.postgate',
    createdAt: new Date(0).toISOString(),
    post: 'at://did:plc:main/app.bsky.feed.post/1',
    embeddingRules: [],
  } as app.bsky.feed.postgate.Main)
  return (
    <AudienceMenu
      visibility="public"
      threadgate={threadgate}
      onThreadgate={next => {
        onThreadgate(next)
        setThreadgate(next)
      }}
      postgate={postgate}
      onPostgate={next => {
        onPostgate(next)
        setPostgate(next)
      }}
    />
  )
}

let container: HTMLDivElement
let root: ReactRoot

beforeEach(() => {
  onThreadgate.mockClear()
  onPostgate.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function openMenu() {
  await actAndSettle(() =>
    root.render(
      <I18nProvider i18n={i18n}>
        <Harness />
      </I18nProvider>,
    ),
  )
  await actAndSettle(() => {
    byTestId('composerAudienceButton').dispatchEvent(
      new MouseEvent('click', {bubbles: true}),
    )
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

function byLabel(label: string) {
  const node = document.querySelector<HTMLElement>(
    `[role="menuitem"][aria-label="${label}"]`,
  )
  if (!node) throw new Error(`no ${label}`)
  return node
}

/** Whether the quotes row reads as allowed: its label offers to disable. */
function quotesAllowedShown() {
  return (
    byTestId('composerAllowQuotes').getAttribute('aria-label') ===
    'Disable quote posts of this post'
  )
}

async function key(node: HTMLElement, name: string) {
  await actAndSettle(() => {
    node.focus()
    node.dispatchEvent(new KeyboardEvent('keydown', {key: name, bubbles: true}))
  })
  await actAndSettle(() => {
    const target = (document.activeElement as HTMLElement | null) ?? node
    target.dispatchEvent(new KeyboardEvent('keyup', {key: name, bubbles: true}))
  })
}

describe('the audience menu on web flips a toggle once per key press', () => {
  it.each(['Enter', ' '])(
    'the %j key flips "Allow quote posts" once and keeps the menu open',
    async name => {
      await openMenu()
      expect(quotesAllowedShown()).toBe(true)

      await key(byTestId('composerAllowQuotes'), name)
      expect(onPostgate).toHaveBeenCalledTimes(1)
      expect(quotesAllowedShown()).toBe(false)
      expect(menu()).not.toBeNull()

      await key(byTestId('composerAllowQuotes'), name)
      expect(onPostgate).toHaveBeenCalledTimes(2)
      expect(quotesAllowedShown()).toBe(true)
    },
  )

  it.each(['Enter', ' '])(
    'the %j key checks "Your followers" once',
    async name => {
      await openMenu()

      await key(byLabel('Allow your followers to reply'), name)
      expect(onThreadgate).toHaveBeenCalledTimes(1)
      expect(onThreadgate).toHaveBeenLastCalledWith([{type: 'followers'}])
      expect(menu()).not.toBeNull()
    },
  )

  it('a click flips "Allow quote posts" once', async () => {
    await openMenu()

    await actAndSettle(() => {
      byTestId('composerAllowQuotes').dispatchEvent(
        new MouseEvent('click', {bubbles: true}),
      )
    })
    expect(onPostgate).toHaveBeenCalledTimes(1)
    expect(quotesAllowedShown()).toBe(false)
    expect(menu()).not.toBeNull()
  })
})
