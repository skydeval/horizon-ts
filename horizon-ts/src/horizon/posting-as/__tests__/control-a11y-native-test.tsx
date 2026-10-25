import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, fireEvent, render, within} from '@testing-library/react-native'

/*
 * SAR2-L5 on native: in the "Posting as" bottom sheet, accounts are radios
 * in a labelled radio group, one checked; members are checkboxes that
 * toggle without closing the sheet; "Edit front..." stays a plain item.
 * Rendered with the real native `Menu`, its sheet stubbed.
 */
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
const mockClose = jest.fn()
const mockAccounts = [
  {did: 'did:plc:main', handle: 'main.test'},
  {did: 'did:plc:lala', handle: 'lala.test'},
  {did: 'did:plc:wren', handle: 'wren.test'},
]
const mockMembers = [
  {rkey: 'm1', value: {name: 'Ash'}},
  {rkey: 'm2', value: {name: 'Birch'}},
]

jest.mock('#/env', () => ({
  __esModule: true,
  IS_IOS: true,
  IS_ANDROID: false,
  IS_NATIVE: true,
  IS_IPAD: false,
  IS_LIQUID_GLASS: false,
}))
jest.mock('../compose-store', () => {
  const {useSyncExternalStore} =
    jest.requireActual<typeof import('react')>('react')
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
}))
jest.mock('../temp-client', () => ({canActAs: () => true}))
jest.mock('../fronters', () => ({PUBLIC_FRONTERS_KEPT: true}))
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: mockAccounts}),
}))
jest.mock('#/state/queries/profile', () => ({
  useProfileQuery: () => ({data: {avatar: undefined}}),
}))
jest.mock('#/horizon/switches', () => ({
  POSTING_AS: true,
  PLURAL_EDITING: true,
}))
jest.mock('#/view/com/util/UserAvatar', () => ({UserAvatar: () => null}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Button', () => {
  const {View} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    Button: (props: {testID?: string; children?: React.ReactNode}) => (
      <View testID={props.testID}>{props.children}</View>
    ),
    ButtonText: () => null,
  }
})
jest.mock('#/components/Dialog', () => {
  const {View} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    // The sheet is always shown, so its items can be read.
    Outer: ({children}: React.PropsWithChildren) => <View>{children}</View>,
    Handle: () => null,
    ScrollableInner: ({children}: React.PropsWithChildren) => (
      <View>{children}</View>
    ),
    useDialogControl: () => ({open: () => {}, close: mockClose}),
  }
})
jest.mock('#/components/Typography', () => {
  const {Text} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    Text: ({children}: React.PropsWithChildren) => <Text>{children}</Text>,
  }
})
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
  const {View} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    MenuCheck: ({selected}: {selected: boolean}) =>
      selected ? <View testID="menuCheckMark" /> : null,
  }
})

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'

import {PostingAsControl} from '../PostingAsControl'

i18n.loadAndActivate({locale: 'en', messages: {}})

const isolates = /[‪-‮⁦-⁩]/g

let screen: ReturnType<typeof render>

beforeEach(() => {
  screen?.unmount()
  mockChooseAccount.mockClear()
  mockToggleMember.mockClear()
  mockClose.mockClear()
  mockStore.state = {
    active: true,
    did: 'did:plc:main',
    currentDid: 'did:plc:main',
    handle: 'main.test',
    members: [],
    hold: {kind: 'none'},
    resetPending: false,
    hasVideo: false,
    data: {isSystem: true, members: mockMembers},
  }
  screen = render(
    <I18nProvider i18n={i18n}>
      <PostingAsControl isFirstPost>{null}</PostingAsControl>
    </I18nProvider>,
  )
})

function account(handle: string) {
  return screen.getByTestId(`composerPostingAs-${handle}`)
}

function member(rkey: string) {
  return screen.getByTestId(`composerPostingAsMember-${rkey}`)
}

type Instance = ReturnType<typeof screen.getByTestId>

/** The nearest host view above `node` with these props. */
function enclosing(node: Instance, props: Record<string, string>) {
  let at: Instance | null = node.parent
  while (at) {
    const candidate = at
    if (
      typeof candidate.type === 'string' &&
      Object.entries(props).every(([k, v]) => candidate.props[k] === v)
    ) {
      return candidate
    }
    at = candidate.parent
  }
  throw new Error(`no enclosing ${JSON.stringify(props)}`)
}

function checkedOf(node: Instance) {
  const state = node.props.accessibilityState as {checked?: boolean} | undefined
  return state?.checked
}

function checkedAccounts() {
  return ['main.test', 'lala.test', 'wren.test'].filter(
    handle => checkedOf(account(handle)) === true,
  )
}

describe('the "Posting as" menu on native exposes its choices (SAR2-L5)', () => {
  it('accounts are radios in a labelled radio group, the posting one checked', () => {
    const group = enclosing(account('main.test'), {
      accessibilityRole: 'radiogroup',
    })
    expect(group.props.accessibilityLabel).toBe('Post from')
    for (const handle of ['main.test', 'lala.test', 'wren.test']) {
      expect(account(handle).props.accessibilityRole).toBe('radio')
      expect(
        enclosing(account(handle), {accessibilityRole: 'radiogroup'}),
      ).toBe(group)
    }
    expect(account('main.test').props.accessibilityState).toMatchObject({
      checked: true,
    })
    expect(account('lala.test').props.accessibilityState).toMatchObject({
      checked: false,
    })
    expect(checkedAccounts()).toEqual(['main.test'])
  })

  it('members are checkboxes in a labelled group, unchecked by default', () => {
    const group = enclosing(member('m1'), {role: 'group'})
    expect(String(group.props.accessibilityLabel).replace(isolates, '')).toBe(
      'Members of @main.test',
    )
    for (const rkey of ['m1', 'm2']) {
      expect(member(rkey).props.accessibilityRole).toBe('checkbox')
      expect(member(rkey).props.accessibilityState).toMatchObject({
        checked: false,
      })
      expect(enclosing(member(rkey), {role: 'group'})).toBe(group)
    }
    expect(member('m1').props.accessibilityLabel).toBe('Post as Ash')
  })

  it('"Edit front..." stays a plain item, outside the choice groups', () => {
    const editFront = screen.getByTestId('composerPostingAsEditFront')
    expect(editFront.props.accessibilityRole).toBeUndefined()
    expect(checkedOf(editFront)).toBeUndefined()
  })

  it('pressing a member toggles its checked state and mark, and keeps the sheet open', () => {
    act(() => fireEvent.press(member('m1')))
    expect(mockToggleMember).toHaveBeenCalledTimes(1)
    expect(mockClose).not.toHaveBeenCalled()
    expect(member('m1').props.accessibilityState).toMatchObject({checked: true})
    expect(member('m2').props.accessibilityState).toMatchObject({
      checked: false,
    })
    expect(within(member('m1')).queryByTestId('menuCheckMark')).not.toBeNull()
    expect(within(member('m2')).queryByTestId('menuCheckMark')).toBeNull()

    act(() => fireEvent.press(member('m2')))
    expect(member('m1').props.accessibilityState).toMatchObject({checked: true})
    expect(member('m2').props.accessibilityState).toMatchObject({checked: true})

    act(() => fireEvent.press(member('m1')))
    expect(member('m1').props.accessibilityState).toMatchObject({
      checked: false,
    })
    expect(mockClose).not.toHaveBeenCalled()
  })

  it('choosing another account closes the sheet, and only it is checked', () => {
    act(() => fireEvent.press(account('lala.test')))
    // iOS closes the sheet, then runs the choice once it has closed.
    expect(mockClose).toHaveBeenCalledTimes(1)
    const afterClose = mockClose.mock.calls[0][0] as () => void
    act(() => afterClose())
    expect(mockChooseAccount).toHaveBeenCalledWith('did:plc:lala')
    expect(checkedAccounts()).toEqual(['lala.test'])
  })
})
