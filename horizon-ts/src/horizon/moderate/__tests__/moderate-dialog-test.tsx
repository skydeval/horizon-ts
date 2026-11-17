import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {fireEvent, render, waitFor} from '@testing-library/react-native'

/*
 * The Moderate dialog's body: each action shows only with its cairn
 * permission, system labels only for admins, and each sends the right event
 * to the right subject. The design system's parts are plain views; the
 * labeler is a fake.
 */

type Sent = {
  labeler: string
  event: {$type: string}
  subject: unknown
  audience?: string
  direct?: true
}
const mockSent: Sent[] = []
let mockDirectSubject: {
  labels: {val: string; cts: string; audience?: string}[]
  openReportCount: number
} = {labels: [], openReportCount: 0}
jest.mock('#/horizon/moderate/direct', () => ({
  emitDirectEvent: (
    _client: unknown,
    labeler: string,
    {
      event,
      subject,
      audience,
    }: {event: {$type: string}; subject: unknown; audience?: string},
  ) => {
    mockSent.push({
      labeler,
      event,
      subject,
      ...(audience ? {audience} : {}),
      direct: true,
    })
    return Promise.resolve({eventId: 1})
  },
  getDirectSubject: () => Promise.resolve(mockDirectSubject),
}))
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

const MEMBER_LABELER = 'did:web:cairn.example.test:labeler:abc'

function memberLabeler(
  permissions: string[],
  kind: TeamLabeler['kind'] = 'moderation',
): TeamLabeler {
  return {
    ...labeler(permissions),
    source: 'member',
    did: MEMBER_LABELER,
    name: 'Umbrae test',
    kind,
    reasonNames: {'tools.cairn.report.defs#reasonDogpiling': 'Harm: Dogpiling'},
    audiences: [{id: 'g1', name: 'Group One'}],
    flagTargets: [
      {
        did: LABELER,
        name: 'Cairn labeler',
        reasonTypes: ['tools.ozone.report.defs#reasonMisleadingSpam'],
        canEscalate: true,
      },
    ],
  }
}

function labeler(permissions: string[]): TeamLabeler {
  return {
    source: 'public',
    kind: 'moderation',
    reasonNames: {},
    audiences: [],
    flagTargets: [],
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
    reasonTypes: [
      'tools.ozone.report.defs#reasonMisleadingSpam',
      'tools.cairn.report.defs#reasonDogpiling',
    ],
  }
}

function mount(permissions: string[] | TeamLabeler) {
  const queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false}},
  })
  const chosen = Array.isArray(permissions) ? labeler(permissions) : permissions
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <Actions labeler={chosen} target={target} />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockSent.length = 0
  mockLabels = []
  mockStatus = undefined
  mockDirectSubject = {labels: [], openReportCount: 0}
  mockToast.mockReset()
})

describe('Moderate dialog, member labelers', () => {
  const all = [
    'labels.apply',
    'labels.system',
    'takedowns',
    'mutes',
    'cases.triage',
  ]

  it('labels through cairn directly, limited to the chosen audience', async () => {
    const view = mount(memberLabeler(all))
    await waitFor(() =>
      expect(view.getAllByText('No labels from this labeler.')).toHaveLength(2),
    )
    fireEvent.press(view.getByTestId('option:Label:spoiler'))
    fireEvent.press(view.getByTestId('option:Who sees it:g1'))
    fireEvent.press(view.getByTestId('moderateApplyLabel'))
    await waitFor(() => expect(mockSent).toHaveLength(1))
    expect(mockSent[0]).toMatchObject({
      labeler: MEMBER_LABELER,
      audience: 'g1',
      direct: true,
      event: {
        $type: 'tools.ozone.moderation.defs#modEventLabel',
        createLabelVals: ['spoiler'],
      },
    })
  })

  it('offers no takedown or mute, even with those permissions', async () => {
    const view = mount(memberLabeler(all))
    await waitFor(() => view.getByLabelText('Save note'))
    expect(view.queryByLabelText('Take down')).toBeNull()
    expect(view.queryByLabelText('Restore')).toBeNull()
    expect(view.queryByLabelText('Mute reports for 7 days')).toBeNull()
  })

  it('names reasons as the labeler does', () => {
    const view = mount(memberLabeler(all))
    expect(
      view.getByTestId(
        'option:Reason (optional):tools.cairn.report.defs#reasonDogpiling',
      ).props.accessibilityLabel,
    ).toBe('Harm: Dogpiling')
  })

  it('flags to a public labeler with one of its reasons, escalating if asked', async () => {
    const view = mount(memberLabeler(all))
    expect(view.getByLabelText('Flag').props.accessibilityState).toEqual(
      expect.objectContaining({disabled: true}),
    )
    fireEvent.press(
      view.getByTestId(
        'option:Flag reason:tools.ozone.report.defs#reasonMisleadingSpam',
      ),
    )
    fireEvent.press(view.getByTestId('moderateFlagEscalate'))
    fireEvent.press(view.getByLabelText('Flag'))
    await waitFor(() => expect(mockSent).toHaveLength(1))
    expect(mockSent[0].event).toEqual({
      $type: 'tools.cairn.moderation.defs#flagEvent',
      target: LABELER,
      reasonType: 'tools.ozone.report.defs#reasonMisleadingSpam',
      escalateTarget: true,
    })
  })

  it('removes an audience label within its audience', async () => {
    mockDirectSubject = {
      labels: [{val: 'spoiler', cts: 'x', audience: 'g1'}],
      openReportCount: 0,
    }
    const view = mount(memberLabeler(all))
    const remove = await waitFor(() =>
      view.getAllByLabelText('Remove Spoiler (Group One)'),
    )
    fireEvent.press(remove[0])
    await waitFor(() => expect(mockSent).toHaveLength(1))
    expect(mockSent[0]).toMatchObject({
      audience: 'g1',
      event: {negateLabelVals: ['spoiler'], createLabelVals: []},
    })
  })

  it('a labels-only labeler takes a label and nothing else', async () => {
    const view = mount(memberLabeler(all, 'labels_only'))
    await waitFor(() => view.getByTestId('moderateApplyLabel'))
    expect(view.queryByTestId('moderateNote')).toBeNull()
    expect(view.queryByLabelText('Save note')).toBeNull()
    expect(view.queryByLabelText('Flag')).toBeNull()
    expect(view.queryByTestId('option:Label:!hide')).toBeNull()
  })

  it('shows open reports from cairn’s count', async () => {
    mockDirectSubject = {labels: [], openReportCount: 2}
    const view = mount(memberLabeler(all))
    await waitFor(() => view.getByLabelText('Acknowledge'))
  })
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

  it('keeps an optional reason, named, with the note', async () => {
    const view = mount(['labels.apply'])
    expect(
      view.getByTestId(
        'option:Reason (optional):tools.cairn.report.defs#reasonDogpiling',
      ).props.accessibilityLabel,
    ).toBe('Dogpiling')
    fireEvent.press(view.getByTestId('option:Label:spoiler'))
    fireEvent.press(
      view.getByTestId(
        'option:Reason (optional):tools.ozone.report.defs#reasonMisleadingSpam',
      ),
    )
    fireEvent.changeText(view.getByTestId('moderateNote'), 'context')
    fireEvent.press(view.getByTestId('moderateApplyLabel'))
    await waitFor(() => expect(mockSent).toHaveLength(1))
    expect((mockSent[0].event as {comment?: string}).comment).toBe(
      'Reason: Misleading: Spam (tools.ozone.report.defs#reasonMisleadingSpam)\ncontext',
    )
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
