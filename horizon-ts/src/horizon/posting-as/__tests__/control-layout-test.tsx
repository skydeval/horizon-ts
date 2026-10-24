/* oxlint-disable import/no-nodejs-modules -- reads the composer source as text, in jest only */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {StyleSheet, View} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {render} from '@testing-library/react-native'

/*
 * PA-1's layout: the "Posting as" trigger takes the stock avatar's slot in
 * the composer's avatar + text input row, the avatar first, without
 * changing its footprint. The full composer is too large to render in
 * jest, so a row built as Composer.tsx builds it stands in, and the
 * composer's source is checked for that row.
 */
const mockState: Record<string, unknown> = {}
jest.mock('../compose-store', () => ({
  usePostingState: () => mockState,
  isPostingAsOther: () => false,
}))
jest.mock('../toasts', () => ({}))
jest.mock('../gates', () => ({
  choosePostingAccount: () => {},
  togglePostingMember: () => {},
}))
jest.mock('../temp-client', () => ({canActAs: () => true}))
jest.mock('../fronters', () => ({PUBLIC_FRONTERS_KEPT: false}))
const mockAccounts: {did: string; handle: string}[] = []
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: mockAccounts}),
}))
jest.mock('#/state/queries/profile', () => ({
  useProfileQuery: () => ({data: {avatar: undefined}}),
}))
jest.mock('#/horizon/switches', () => ({
  POSTING_AS: true,
  PLURAL_EDITING: false,
}))
jest.mock('#/view/com/util/UserAvatar', () => {
  const {View} = jest.requireActual<typeof import('react-native')>(
    'react-native',
  )
  return {
    UserAvatar: (props: {style?: unknown}) => (
      <View testID="postingAvatar" style={props.style as never} />
    ),
  }
})
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Button', () => {
  const {View} = jest.requireActual<typeof import('react-native')>(
    'react-native',
  )
  return {
    Button: (props: {
      testID?: string
      label?: string
      style?: unknown
      children?: React.ReactNode
    }) => (
      <View
        testID={props.testID}
        accessibilityLabel={props.label}
        accessibilityHint=""
        accessible
        style={props.style as never}>
        {props.children}
      </View>
    ),
  }
})
jest.mock('#/components/Menu', () => ({
  Root: (props: {children?: React.ReactNode}) => <>{props.children}</>,
  Trigger: (props: {
    children: (arg: unknown) => React.ReactNode
  }): React.ReactNode =>
    props.children({props: {}, state: {focused: false}}),
  Outer: () => null,
}))
jest.mock('#/components/Dialog', () => ({useDialogControl: () => ({})}))
jest.mock('#/components/icons/Chevron', () => ({
  TinyChevronBottom_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/Typography', () => ({Text: () => null}))
jest.mock('#/horizon/identity/edit/FrontSwitcherDialog', () => ({
  FrontSwitcherDialog: () => null,
}))
jest.mock('#/horizon/identity/format', () => ({
  formatMemberLabel: () => '',
  formatSets: () => '',
}))
jest.mock('#/horizon/identity/FronterName', () => ({MemberSwatch: () => null}))
jest.mock('#/horizon/identity/fronters', () => ({MAX_FRONTERS: 20}))
jest.mock('#/horizon/identity/hooks', () => ({usePluralProfile: () => ({})}))
jest.mock('#/horizon/identity/images', () => ({memberImageUrl: () => ''}))
jest.mock('#/horizon/private/composer/AudienceMenu', () => ({
  MenuCheck: () => null,
}))

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'

import {PostingAsControl} from '../PostingAsControl'

i18n.loadAndActivate({locale: 'en', messages: {}})

/** The composer's row (Composer.tsx, PA-1): avatar slot, then the input. */
function Row({isFirstPost = true}: {isFirstPost?: boolean}) {
  return (
    <I18nProvider i18n={i18n}>
      <View testID="row" style={{flexDirection: 'row'}}>
        <PostingAsControl isFirstPost={isFirstPost}>
          <View testID="stockAvatar" />
        </PostingAsControl>
        <View testID="textInput" style={{flex: 1}} />
      </View>
    </I18nProvider>
  )
}

type Node = {props: Record<string, unknown>; children: Node[] | null}

function rowChildren() {
  const json = screen().toJSON() as unknown as Node
  return (json.children ?? []).filter(child => typeof child === 'object')
}

let current: ReturnType<typeof render> | undefined
function screen() {
  if (!current) throw new Error('nothing rendered')
  return current
}

function styleOf(node: {props: Record<string, unknown>}) {
  return StyleSheet.flatten(node.props.style as never) as Record<
    string,
    unknown
  >
}

beforeEach(() => {
  current?.unmount()
  current = undefined
  mockAccounts.length = 0
  for (const key of Object.keys(mockState)) delete mockState[key]
  Object.assign(mockState, {
    active: true,
    did: 'did:plc:main',
    currentDid: 'did:plc:main',
    handle: 'main.test',
    members: [],
    hold: {kind: 'none'},
    resetPending: false,
    hasVideo: false,
  })
})

describe('the "Posting as" control keeps the stock avatar’s slot (PA-1)', () => {
  it('shares the row with the text input, avatar first, at the stock size', () => {
    mockAccounts.push(
      {did: 'did:plc:main', handle: 'main.test'},
      {did: 'did:plc:other', handle: 'other.test'},
    )
    current = render(<Row />)
    const children = rowChildren()
    expect(children.map(child => child.props.testID)).toEqual([
      'composerPostingAsSlot',
      'textInput',
    ])
    expect(styleOf(children[0])).toMatchObject({
      width: 42,
      height: 42,
      flexShrink: 0,
    })

    // The trigger and its chevron sit over the slot, not in the flow.
    const trigger = screen().getByTestId('composerPostingAsButton')
    expect(styleOf(trigger)).toMatchObject({
      position: 'absolute',
      width: 44,
      height: 44,
      top: -1,
      left: -1,
    })
    expect(
      styleOf(screen().getByTestId('composerPostingAsChevron')),
    ).toMatchObject({position: 'absolute'})
    // The handle is wrapped in direction isolates, as every shown handle is.
    expect(
      String(trigger.props.accessibilityLabel).replace(/[‪-‮⁦-⁩]/g, ''),
    ).toBe(
      'Posting as @main.test, change account or members',
    )
  })

  it('a later post in a thread shows the posting avatar alone in the same place', () => {
    mockAccounts.push(
      {did: 'did:plc:main', handle: 'main.test'},
      {did: 'did:plc:other', handle: 'other.test'},
    )
    current = render(<Row isFirstPost={false} />)
    expect(rowChildren().map(child => child.props.testID)).toEqual([
      'postingAvatar',
      'textInput',
    ])
    expect(screen().queryByTestId('composerPostingAsButton')).toBeNull()
  })

  it('with nothing to offer, the stock avatar renders unchanged', () => {
    mockAccounts.push({did: 'did:plc:main', handle: 'main.test'})
    current = render(<Row />)
    expect(rowChildren().map(child => child.props.testID)).toEqual([
      'stockAvatar',
      'textInput',
    ])
  })

  it('Composer.tsx puts the control and the text input in one row, the control first', () => {
    const source = readFileSync(
      join(__dirname, '../../../view/com/composer/Composer.tsx'),
      'utf8',
    )
    const row = source.indexOf(
      '<View style={[a.flex_row, IS_NATIVE && a.flex_1]}>',
    )
    const control = source.indexOf('<PostingAsControl', row)
    const closed = source.indexOf('</PostingAsControl>', control)
    const input = source.indexOf('<TextInput', closed)
    const rowEnd = source.indexOf('</View>', closed)
    expect(row).toBeGreaterThan(-1)
    expect(control).toBeGreaterThan(row)
    // Nothing else opens between the row and the control.
    expect(source.slice(row, control)).not.toMatch(/<View\b(?![^>]*flex_row)/)
    expect(input).toBeGreaterThan(closed)
    expect(input).toBeLessThan(rowEnd)
  })
})
