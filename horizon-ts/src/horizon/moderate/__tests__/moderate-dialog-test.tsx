import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {fireEvent, render, waitFor} from '@testing-library/react-native'

/*
 * The Moderate dialog's body: each action shows only with its cairn
 * permission, system labels only for admins, and each sends the right event
 * to the right subject. The design system's parts are plain views; the
 * labeler is a fake.
 */

type Sent = {labeler: string; event: {$type: string}; subject: unknown}
const mockSent: Sent[] = []
let mockLabels: {src: string; uri: string; val: string; cts: string}[] = []
let mockStatus: Record<string, unknown> | undefined
jest.mock('#/horizon/moderate/api', () => {
  const actual = jest.requireActual<typeof import('#/horizon/moderate/api')>(
    '#/horizon/moderate/api',
  )
  return {
    ...actual,
    emitEvent: (
      _client: unknown,
      labeler: string,
      {event, subject}: {event: {$type: string}; subject: unknown},
    ) => {
      mockSent.push({labeler, event, subject})
      return Promise.resolve({id: 1})
    },
    getCurrentLabels: (
      _client: unknown,
      _labeler: string,
      subject: {uri?: string; did?: string},
    ) =>
      Promise.resolve(
        mockLabels.filter(label => label.uri === (subject.uri ?? subject.did)),
      ),
    getSubjectStatus: () => Promise.resolve(mockStatus),
  }
})
jest.mock('#/state/session', () => ({
  usePdsClient: () => ({}),
  useSession: () => ({currentAccount: {did: 'did:plc:moderator'}}),
}))
jest.mock('#/horizon/moderate/team', () => ({
  useTeamLabelersQuery: () => ({data: [], isLoading: false}),
}))
const mockToast = jest.fn()
jest.mock('#/components/Toast', () => ({
  show: (...args: unknown[]) => mockToast(...args),
}))
jest.mock('#/logger', () => ({logger: {warn: () => {}}}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => ''}),
  }),
  web: () => ({}),
}))
jest.mock('#/components/Dialog', () => {
  const {TextInput} = require('react-native') as typeof import('react-native')
  return {
    Input: ({
      testID,
      label,
      value,
      onChangeText,
    }: {
      testID?: string
      label: string
      value: string
      onChangeText: (value: string) => void
    }) => (
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint=""
        value={value}
        onChangeText={onChangeText}
      />
    ),
    useDialogControl: () => ({open: () => {}, close: () => {}}),
  }
})
jest.mock('#/components/forms/TextField', () => {
  const {Text, View} = require('react-native') as typeof import('react-native')
  return {
    Root: ({children}: {children: React.ReactNode}) => <View>{children}</View>,
    LabelText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/components/Select', () => {
  const React = require('react') as typeof import('react')
  const {Pressable, Text, View} =
    require('react-native') as typeof import('react-native')
  const noop: (picked: string) => void = () => {}
  const Context = React.createContext(noop)
  return {
    Root: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode
      onValueChange: (value: string) => void
    }) => (
      <Context.Provider value={onValueChange}>
        <View>{children}</View>
      </Context.Provider>
    ),
    Trigger: () => null,
    ValueText: () => null,
    Icon: () => null,
    Content: ({
      label,
      items,
    }: {
      label: string
      items: {label: string; value: string}[]
    }) => (
      <Context.Consumer>
        {onChange => (
          <View>
            {items.map(item => (
              <Pressable
                key={item.value}
                testID={`option:${label}:${item.value}`}
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
                accessibilityHint=""
                onPress={() => onChange(item.value)}>
                <Text>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </Context.Consumer>
    ),
  }
})
jest.mock('#/components/forms/Toggle', () => {
  const {Pressable, View} =
    require('react-native') as typeof import('react-native')
  return {
    Item: ({
      testID,
      label,
      value,
      onChange,
      children,
    }: {
      testID?: string
      label: string
      value: boolean
      onChange: (value: boolean) => void
      children: React.ReactNode
    }) => (
      <Pressable
        testID={testID}
        accessibilityRole="checkbox"
        accessibilityLabel={label}
        accessibilityHint=""
        accessibilityState={{checked: value}}
        onPress={() => onChange(!value)}>
        <View>{children}</View>
      </Pressable>
    ),
    Checkbox: () => null,
    LabelText: () => null,
  }
})
jest.mock('#/components/Prompt', () => {
  const {Pressable, Text} =
    require('react-native') as typeof import('react-native')
  return {
    usePromptControl: () => ({open: () => {}}),
    Basic: ({
      confirmButtonCta,
      onConfirm,
    }: {
      confirmButtonCta: string
      onConfirm: () => void
    }) => (
      <Pressable
        testID="promptConfirm"
        accessibilityRole="button"
        accessibilityLabel={confirmButtonCta}
        accessibilityHint=""
        onPress={onConfirm}>
        <Text>{confirmButtonCta}</Text>
      </Pressable>
    ),
  }
})
jest.mock('#/components/Button', () => {
  const {Pressable, View} =
    require('react-native') as typeof import('react-native')
  return {
    Button: ({
      testID,
      label,
      onPress,
      disabled,
      children,
    }: {
      testID?: string
      label: string
      onPress?: () => void
      disabled?: boolean
      children?: React.ReactNode
    }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint=""
        accessibilityState={{disabled: !!disabled}}
        testID={testID}
        onPress={onPress}
        disabled={disabled}>
        <View>{children}</View>
      </Pressable>
    ),
    ButtonIcon: () => null,
    ButtonText: ({children}: {children: React.ReactNode}) => <>{children}</>,
  }
})
jest.mock('#/components/Admonition', () => {
  const {Text} = require('react-native') as typeof import('react-native')
  return {
    Admonition: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/components/Loader', () => ({Loader: () => null}))
jest.mock('#/components/Typography', () => {
  const {Text} = require('react-native') as typeof import('react-native')
  return {Text}
})

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {Actions} from '#/horizon/moderate/ModerateDialog'
import {type TeamLabeler} from '#/horizon/moderate/permissions'

i18n.loadAndActivate({locale: 'en', messages: {}})

const LABELER = 'did:plc:cairnlabeler'
const POST = 'at://did:plc:author/app.bsky.feed.post/3mabcabcabc22'
const target = {
  type: 'post' as const,
  uri: POST,
  cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authorDid: 'did:plc:author',
}

function labeler(permissions: string[]): TeamLabeler {
  return {
    did: LABELER,
    name: 'Cairn labeler',
    permissions: new Set(permissions),
    defs: [
      {
        identifier: 'spoiler',
        configurable: true,
        defaultSetting: 'warn',
        flags: [],
        severity: 'inform',
        blurs: 'content',
        behaviors: {account: {}, profile: {}, content: {}},
        locales: [{lang: 'en', name: 'Spoiler', description: 'Spoilers'}],
        definedBy: LABELER,
      },
    ] as unknown as TeamLabeler['defs'],
  }
}

function mount(permissions: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false}},
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <Actions labeler={labeler(permissions)} target={target} />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockSent.length = 0
  mockLabels = []
  mockStatus = undefined
  mockToast.mockReset()
})

describe('Moderate dialog', () => {
  it('shows each action only with its permission', async () => {
    const view = mount(['labels.apply'])
    await waitFor(() =>
      expect(view.getAllByText('No labels from this labeler.')).toHaveLength(2),
    )
    expect(view.queryByTestId('moderateApplyLabel')).not.toBeNull()
    // Only the (mocked, always rendered) confirm prompt says Take down.
    expect(view.queryAllByLabelText('Take down')).toHaveLength(1)
    expect(view.queryByLabelText('Mute reports for 7 days')).toBeNull()
    expect(view.queryByLabelText('Save note')).toBeNull()
    // No system labels without labels.system.
    expect(view.queryByTestId('option:Label:!hide')).toBeNull()
    expect(view.queryByTestId('option:Label:spoiler')).not.toBeNull()
  })

  it('offers !hide and !warn to admins', async () => {
    const view = mount(['labels.apply', 'labels.system'])
    await waitFor(() => view.getByTestId('option:Label:!hide'))
    expect(view.queryByTestId('option:Label:!warn')).not.toBeNull()
  })

  it('applies a label to the post, or to the account instead, with expiry and note', async () => {
    const view = mount(['labels.apply'])
    fireEvent.press(view.getByTestId('option:Label:spoiler'))
    fireEvent.press(view.getByTestId('option:Expiry:24'))
    fireEvent.changeText(view.getByTestId('moderateNote'), 'context')
    fireEvent.press(view.getByTestId('moderateApplyLabel'))
    await waitFor(() => expect(mockSent).toHaveLength(1))
    expect(mockSent[0]).toEqual({
      labeler: LABELER,
      event: {
        $type: 'tools.ozone.moderation.defs#modEventLabel',
        createLabelVals: ['spoiler'],
        negateLabelVals: [],
        comment: 'context',
        durationInHours: 24,
      },
      subject: {
        $type: 'com.atproto.repo.strongRef',
        uri: POST,
        cid: target.cid,
      },
    })
    fireEvent.press(view.getByTestId('moderateOnAccount'))
    await waitFor(() =>
      expect(
        view.getByTestId('moderateApplyLabel').props.accessibilityState,
      ).toEqual(expect.objectContaining({disabled: false})),
    )
    fireEvent.press(view.getByTestId('moderateApplyLabel'))
    await waitFor(() => expect(mockSent).toHaveLength(2))
    expect(mockSent[1].subject).toEqual({
      $type: 'com.atproto.admin.defs#repoRef',
      did: 'did:plc:author',
    })
  })

  it('removes a current label by negating it', async () => {
    mockLabels = [{src: LABELER, uri: POST, val: 'spoiler', cts: 'x'}]
    const view = mount(['labels.apply'])
    const remove = await waitFor(() => view.getByLabelText('Remove Spoiler'))
    fireEvent.press(remove)
    await waitFor(() => expect(mockSent).toHaveLength(1))
    expect(mockSent[0].event).toEqual({
      $type: 'tools.ozone.moderation.defs#modEventLabel',
      createLabelVals: [],
      negateLabelVals: ['spoiler'],
    })
  })

  it('takes down after confirming, and offers Restore once taken down', async () => {
    const view = mount(['takedowns'])
    await waitFor(() =>
      expect(view.getAllByLabelText('Take down')).toHaveLength(2),
    )
    fireEvent.press(view.getByTestId('promptConfirm'))
    await waitFor(() => expect(mockSent).toHaveLength(1))
    expect(mockSent[0].event.$type).toBe(
      'tools.ozone.moderation.defs#modEventTakedown',
    )
    mockStatus = {takendown: true}
    const again = mount(['takedowns'])
    await waitFor(() => again.getByLabelText('Restore'))
  })

  it('shows Acknowledge and Escalate only when there are open reports', async () => {
    const quiet = mount(['cases.triage'])
    await waitFor(() => quiet.getByLabelText('Save note'))
    expect(quiet.queryByLabelText('Acknowledge')).toBeNull()
    mockStatus = {reviewState: 'tools.ozone.moderation.defs#reviewOpen'}
    const reported = mount(['cases.triage'])
    const acknowledge = await waitFor(() =>
      reported.getByLabelText('Acknowledge'),
    )
    fireEvent.press(acknowledge)
    await waitFor(() => expect(mockSent).toHaveLength(1))
    expect(mockSent[0].event.$type).toBe(
      'tools.ozone.moderation.defs#modEventAcknowledge',
    )
  })
})
