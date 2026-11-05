import type * as ReactNative from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {act, fireEvent, render} from '@testing-library/react-native'

/*
 * Aster on a blocked quote card: the plain card for everyone; with the grant
 * and a post URI, the action; its outcome drawn in the card's place, undone
 * client-side. Synthetic fixtures; prism is a fake.
 */

const ME = 'did:plc:aqreader00000000000000001'
const AUTHOR = 'did:plc:aqauthor00000000000000001'
const URI = `at://${AUTHOR}/app.bsky.feed.post/3kaqpost22222`
const LABELS = {action: 'Act', undo: 'Back', marker: 'Mark'}

let mockLabels: typeof LABELS | undefined = LABELS
const mockGetPost = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: ME}}),
}))
jest.mock('#/horizon/routing/aster', () => ({
  useAsterLabels: () => mockLabels,
}))
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentClients: () => ({did: ME, prismClient: {}}),
}))
jest.mock('#/horizon/thread-lens/api', () => ({
  getAsterPost: (...args: unknown[]) => mockGetPost(...args),
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({atoms: new Proxy({}, {get: () => ({})})}),
}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<typeof ReactNative>('react-native')
  return {Text}
})
jest.mock('#/components/Loader', () => ({Loader: () => null}))
jest.mock('#/components/Button', () => {
  const {Pressable, Text} =
    jest.requireActual<typeof ReactNative>('react-native')
  // Lower case, so the React Compiler leaves the mock factory alone
  const button = ({
    label,
    onPress,
    disabled,
    children,
  }: {
    label: string
    onPress: () => void
    disabled?: boolean
    children?: React.ReactNode
  }) => (
    <Pressable
      accessibilityLabel={label}
      accessibilityHint=""
      onPress={disabled ? undefined : onPress}>
      {children}
    </Pressable>
  )
  const buttonText = ({children}: {children?: React.ReactNode}) => (
    <Text>{children}</Text>
  )
  return {Button: button, ButtonText: buttonText, ButtonIcon: () => null}
})

import {Text} from 'react-native'

import {isAsterView} from '#/horizon/thread-lens/aster'
import {AsterQuote} from '#/horizon/thread-lens/AsterQuote'

i18n.loadAndActivate({locale: 'en', messages: {}})

function postView() {
  return {
    uri: URI,
    cid: 'bafyreiffffffffffffffffffffffffffffffffffffffffffffffffffff',
    author: {did: AUTHOR, handle: 'author.example.test', viewer: {}},
    record: {
      $type: 'app.bsky.feed.post',
      text: 'quoted text',
      createdAt: '2026-11-05T10:00:00.000Z',
    },
    indexedAt: '2026-11-05T10:00:00.000Z',
    viewer: {},
  }
}

function mount(uri = URI) {
  const rendered: unknown[] = []
  const view = render(
    <I18nProvider i18n={i18n}>
      <AsterQuote
        uri={uri}
        placeholder={<Text>Blocked</Text>}
        render={embed => {
          rendered.push(embed.view)
          return <Text>{`quote of ${embed.view.uri}`}</Text>
        }}
      />
    </I18nProvider>,
  )
  return {view, rendered}
}

beforeEach(() => {
  mockLabels = LABELS
  mockGetPost.mockReset()
  mockGetPost.mockResolvedValue({uri: URI, post: postView()})
})

describe('AsterQuote', () => {
  it('is the plain card without the grant', () => {
    mockLabels = undefined
    const {view} = mount()
    expect(view.getByText('Blocked')).toBeTruthy()
    expect(view.queryByLabelText('Act')).toBeNull()
  })

  it('never offers on a blocked feed or list card', () => {
    const {view} = mount(`at://${AUTHOR}/app.bsky.feed.generator/feedname`)
    expect(view.getByText('Blocked')).toBeTruthy()
    expect(view.queryByLabelText('Act')).toBeNull()
  })

  it('draws the quoted post in place, stamped, and undo restores the card', async () => {
    const {view, rendered} = mount()
    await act(async () => {
      fireEvent.press(view.getByLabelText('Act'))
      await Promise.resolve()
    })
    expect(mockGetPost.mock.calls[0]?.[2]).toBe(URI)
    expect(view.getByText(`quote of ${URI}`)).toBeTruthy()
    expect(view.getByText('Mark')).toBeTruthy()
    expect(view.queryByText('Blocked')).toBeNull()
    expect(isAsterView(rendered[0])).toBe(true)
    await act(async () => {
      fireEvent.press(view.getByLabelText('Back'))
      await Promise.resolve()
    })
    expect(view.getByText('Blocked')).toBeTruthy()
    expect(view.queryByText(`quote of ${URI}`)).toBeNull()
    // Undo makes no call
    expect(mockGetPost).toHaveBeenCalledTimes(1)
  })

  it('shows a gap answer’s text in place of the action’s result', async () => {
    mockGetPost.mockResolvedValue({uri: URI, gap: 'deleted'})
    const {view} = mount()
    await act(async () => {
      fireEvent.press(view.getByLabelText('Act'))
      await Promise.resolve()
    })
    expect(view.getByText('Deleted post')).toBeTruthy()
    expect(view.getByText('Blocked')).toBeTruthy()
  })
})
