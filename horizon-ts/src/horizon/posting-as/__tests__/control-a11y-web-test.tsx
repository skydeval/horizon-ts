/* oxlint-disable typescript/no-require-imports -- the DOM must exist before react-dom loads */
import {act} from 'react'
import {type Root as ReactRoot} from 'react-dom/client'

/*
 * SAR2-L5 on web: the "Posting as" menu exposes its choices. Accounts are
 * one radio group (`menuitemradio`, one `aria-checked="true"`), members are
 * checkboxes (`menuitemcheckbox`) that toggle without closing the menu, and
 * "Edit front..." stays a plain `menuitem`. Rendered with the real web
 * `Menu` (Radix) in jsdom, as `RepostButtonMenu.web.test.tsx` does.
 */
installDom()

const {createRoot} =
  require('react-dom/client') as typeof import('react-dom/client')
const {i18n} = require('@lingui/core') as typeof import('@lingui/core')
const {I18nProvider} =
  require('@lingui/react') as typeof import('@lingui/react')
const {PostingAsControl} =
  require('../PostingAsControl') as typeof import('../PostingAsControl')

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

/** The posting state, as a tiny store the gate mocks change. */
const mockStore = {
  state: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  get: () => mockStore.state,
  set(patch: Record<string, unknown>) {
    mockStore.state = {...mockStore.state, ...patch}
    mockStore.listeners.forEach(listener => listener())
  },
  subscribe(listener: () => void) {
    mockStore.listeners.add(listener)
    return () => mockStore.listeners.delete(listener)
  },
}
const mockChooseAccount = jest.fn((did: string) => mockStore.set({did}))
const mockToggleMember = jest.fn((rkey: string) => {
  const members = mockStore.state.members as string[]
  mockStore.set({
    members: members.includes(rkey)
      ? members.filter(member => member !== rkey)
      : [...members, rkey],
  })
})
const mockAccounts = [
  {did: 'did:plc:main', handle: 'main.test'},
  {did: 'did:plc:other', handle: 'other.test'},
]
/*
 * System accounts (system accounts design 8.1, 8.2): the current account's
 * listed accounts, two ready and one that needs a sign-in here. The
 * switcher's other account is never offered.
 */
const mockRows = [
  {did: 'did:plc:lala', handle: 'lala.test', addedAt: '', state: 'ready'},
  {did: 'did:plc:wren', handle: 'wren.test', addedAt: '', state: 'ready'},
  {did: 'did:plc:pip', handle: 'pip.test', addedAt: '', state: 'signInAgain'},
]
const mockReverifyListeners = new Set<(did: string) => boolean>()
const mockMembers = [
  {rkey: 'm1', value: {name: 'Ash'}},
  {rkey: 'm2', value: {name: 'Birch'}},
]

jest.mock('react-native', () => require('react-native-web'))
jest.mock('#/components/Menu', () => require('#/components/Menu/index.web'))
jest.mock('../compose-store', () => {
  const {useSyncExternalStore} = require('react') as typeof import('react')
  return {
    usePostingState: () =>
      useSyncExternalStore(mockStore.subscribe, mockStore.get),
    isPostingAsOther: () => false,
  }
})
jest.mock('../toasts', () => ({}))
jest.mock('../gates', () => ({
  choosePostingAccount: (did: string) => mockChooseAccount(did),
  togglePostingMember: (rkey: string) => mockToggleMember(rkey),
  onPostingReverifyRequested: (listener: (did: string) => boolean) => {
    mockReverifyListeners.add(listener)
    return () => mockReverifyListeners.delete(listener)
  },
}))
jest.mock('../temp-client', () => ({canActAs: () => true}))
jest.mock('../fronters', () => ({PUBLIC_FRONTERS_KEPT: true}))
jest.mock('#/horizon/system-accounts/hooks', () => ({
  useSystemAccountRows: () => mockRows,
}))
jest.mock('#/horizon/system-accounts/AddSystemAccountDialog', () => ({
  AddSystemAccountDialog: () => null,
}))
jest.mock('#/horizon/system-accounts/SystemAccountsSection', () => ({
  requestSystemAccountsFocus: () => {},
}))
jest.mock('#/horizon/system-accounts/announce', () => ({
  holdAnnouncements: () => () => {},
}))
jest.mock('#/horizon/system-accounts/sync', () => ({
  readList: () => Promise.resolve(true),
}))
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentClients: () => undefined,
}))
jest.mock('#/screens/Profile/Header/EditProfileDialog', () => ({
  EditProfileDialog: () => null,
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: mockAccounts}),
}))
jest.mock('#/state/queries/profile', () => ({
  useProfileQuery: () => ({data: {avatar: undefined}}),
}))
jest.mock('#/state/a11y', () => ({
  useA11y: () => ({reduceMotionEnabled: true}),
}))
jest.mock('#/horizon/switches', () => ({
  POSTING_AS: true,
  PLURAL_EDITING: true,
  SYSTEM_ACCOUNTS: true,
}))
jest.mock('#/view/com/util/UserAvatar', () => ({UserAvatar: () => null}))
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
  }
})
jest.mock('#/components/Dialog', () => ({
  useDialogControl: () => ({open: () => {}}),
}))
jest.mock('#/components/icons/Chevron', () => ({
  TinyChevronBottom_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/horizon/identity/edit/FrontSwitcherDialog', () => ({
  FrontSwitcherDialog: () => null,
}))
jest.mock('#/horizon/identity/format', () => ({
  formatMemberLabel: (value: {name: string}) => value.name,
  formatSets: () => '',
}))
jest.mock('#/horizon/identity/FronterName', () => ({MemberSwatch: () => null}))
jest.mock('#/horizon/identity/fronters', () => ({MAX_FRONTERS: 20}))
jest.mock('#/horizon/identity/hooks', () => ({usePluralProfile: () => ({})}))
jest.mock('#/horizon/identity/images', () => ({memberImageUrl: () => ''}))
jest.mock('#/horizon/private/composer/AudienceMenu', () => {
  const {View} = require('react-native-web')
  return {
    MenuCheck: ({selected}: {selected: boolean}) =>
      selected ? <View testID="menuCheckMark" /> : null,
  }
})

i18n.loadAndActivate({locale: 'en', messages: {}})

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
  mockChooseAccount.mockClear()
  mockToggleMember.mockClear()
  mockStore.state = {
    active: true,
    did: 'did:plc:main',
    currentDid: 'did:plc:main',
    currentHandle: 'main.test',
    handle: 'main.test',
    members: [],
    hold: {kind: 'none'},
    resetPending: false,
    hasVideo: false,
    data: {isSystem: true, members: mockMembers},
  }
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
        <PostingAsControl isFirstPost>{null}</PostingAsControl>
      </I18nProvider>,
    ),
  )
  const trigger = document.querySelector(
    '[data-testid="composerPostingAsButton"]',
  )
  expect(trigger).not.toBeNull()
  await actAndSettle(() => {
    trigger!.dispatchEvent(new MouseEvent('click', {bubbles: true}))
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

/** A label without the direction isolates every shown handle is wrapped in. */
function plain(label: string | null) {
  return label?.replace(/[‪-‮⁦-⁩]/g, '')
}

function account(handle: string) {
  return byTestId(`composerPostingAs-${handle}`)
}

function member(rkey: string) {
  return byTestId(`composerPostingAsMember-${rkey}`)
}

function checkedRadios() {
  return Array.from(
    document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]'),
  ).map(node => node.getAttribute('data-testid'))
}

async function key(node: HTMLElement, name: string) {
  await actAndSettle(() => {
    node.focus()
    node.dispatchEvent(new KeyboardEvent('keydown', {key: name, bubbles: true}))
    node.dispatchEvent(new KeyboardEvent('keyup', {key: name, bubbles: true}))
  })
}

describe('the "Posting as" menu on web exposes its choices (SAR2-L5)', () => {
  it('accounts are menuitemradios in a labelled group, the posting one checked', async () => {
    await openMenu()

    const group = document.querySelector(
      '[role="group"][aria-label="Post from"]',
    )
    expect(group).not.toBeNull()
    for (const handle of ['main.test', 'lala.test', 'wren.test']) {
      const item = account(handle)
      expect(item.getAttribute('role')).toBe('menuitemradio')
      expect(group!.contains(item)).toBe(true)
    }
    expect(account('main.test').getAttribute('aria-checked')).toBe('true')
    expect(account('lala.test').getAttribute('aria-checked')).toBe('false')
    expect(account('wren.test').getAttribute('aria-checked')).toBe('false')
    expect(checkedRadios()).toEqual(['composerPostingAs-main.test'])
    // Each item is labelled "@x"; the group says "Post from" (SA-H11).
    expect(plain(account('lala.test').getAttribute('aria-label'))).toBe(
      '@lala.test',
    )
  })

  it('offers the current account and its system accounts only, never another switcher account (S-1)', async () => {
    await openMenu()
    expect(
      document.querySelector('[data-testid="composerPostingAs-other.test"]'),
    ).toBeNull()
  })

  it('a listed account that needs a sign-in is a plain menuitem after the radio group, and opens the sign-in (8.2)', async () => {
    await openMenu()
    const item = byTestId('composerPostingAsSignIn-did:plc:pip')
    expect(item.getAttribute('role')).toBe('menuitem')
    expect(plain(item.getAttribute('aria-label'))).toBe(
      'Sign in again as @pip.test',
    )
    const group = document.querySelector(
      '[role="group"][aria-label="Post from"]',
    )
    expect(group!.contains(item)).toBe(false)
    expect(
      document.querySelector('[data-testid="composerPostingAs-pip.test"]'),
    ).toBeNull()
    expect(byTestId('composerPostingAsManage').getAttribute('role')).toBe(
      'menuitem',
    )
  })

  it('members are menuitemcheckboxes in a labelled group, unchecked by default', async () => {
    await openMenu()

    const group = member('m1').closest('[role="group"]')
    // The handle is wrapped in direction isolates, as every shown handle is.
    expect(group?.getAttribute('aria-label')?.replace(/[‪-‮⁦-⁩]/g, '')).toBe(
      'Members of @main.test',
    )
    for (const rkey of ['m1', 'm2']) {
      expect(member(rkey).getAttribute('role')).toBe('menuitemcheckbox')
      expect(member(rkey).getAttribute('aria-checked')).toBe('false')
      expect(group!.contains(member(rkey))).toBe(true)
    }
    // The label names the member; the state is aria-checked, not the label.
    expect(member('m1').getAttribute('aria-label')).toBe('Post as Ash')
  })

  it('"Edit front..." stays a plain menuitem', async () => {
    await openMenu()

    expect(byTestId('composerPostingAsEditFront').getAttribute('role')).toBe(
      'menuitem',
    )
  })

  it('clicking a member toggles aria-checked and its mark, and keeps the menu open', async () => {
    await openMenu()

    await actAndSettle(() => {
      member('m1').dispatchEvent(new MouseEvent('click', {bubbles: true}))
    })
    expect(mockToggleMember).toHaveBeenCalledTimes(1)
    expect(menu()).not.toBeNull()
    expect(member('m1').getAttribute('aria-checked')).toBe('true')
    expect(member('m2').getAttribute('aria-checked')).toBe('false')
    // Never colour alone: a checked member shows a mark.
    expect(
      member('m1').querySelector('[data-testid="menuCheckMark"]'),
    ).not.toBeNull()
    expect(
      member('m2').querySelector('[data-testid="menuCheckMark"]'),
    ).toBeNull()

    // Several members can be checked at once.
    await actAndSettle(() => {
      member('m2').dispatchEvent(new MouseEvent('click', {bubbles: true}))
    })
    expect(member('m1').getAttribute('aria-checked')).toBe('true')
    expect(member('m2').getAttribute('aria-checked')).toBe('true')

    await actAndSettle(() => {
      member('m1').dispatchEvent(new MouseEvent('click', {bubbles: true}))
    })
    expect(member('m1').getAttribute('aria-checked')).toBe('false')
    expect(menu()).not.toBeNull()
  })

  it.each(['Enter', ' '])(
    'the %j key toggles a member once and keeps the menu open',
    async name => {
      await openMenu()

      await key(member('m2'), name)
      expect(mockToggleMember).toHaveBeenCalledTimes(1)
      expect(member('m2').getAttribute('aria-checked')).toBe('true')
      expect(menu()).not.toBeNull()
    },
  )

  it('choosing another account checks it alone and closes the menu', async () => {
    await openMenu()

    await actAndSettle(() => {
      account('lala.test').dispatchEvent(
        new MouseEvent('click', {bubbles: true}),
      )
    })
    expect(mockChooseAccount).toHaveBeenCalledWith('did:plc:lala')
    expect(menu()).toBeNull()

    // Reopened, exactly one account is checked: the chosen one.
    await openMenu()
    expect(checkedRadios()).toEqual(['composerPostingAs-lala.test'])
  })

  it('Enter on an account chooses it once', async () => {
    await openMenu()

    await key(account('wren.test'), 'Enter')
    expect(mockChooseAccount).toHaveBeenCalledTimes(1)
    expect(mockChooseAccount).toHaveBeenCalledWith('did:plc:wren')
  })

  it('arrow keys move between the choices', async () => {
    await openMenu()

    await actAndSettle(() => {
      account('main.test').focus()
      account('main.test').dispatchEvent(
        new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}),
      )
    })
    expect(document.activeElement).toBe(account('lala.test'))
  })
})
