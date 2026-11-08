import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, fireEvent, render} from '@testing-library/react-native'

/*
 * The feedback form: Send waits for some text, sends the kind, text and the
 * details choice, thanks the sender and closes; a rate limit says so and
 * keeps the text. The design system's parts are plain views, and the send
 * itself is a fake.
 */

const mockSend =
  jest.fn<
    (input: {kind: string; text: string; includeDetails: boolean}) => Promise<void>
  >()
jest.mock('#/horizon/feedback/api', () => {
  const actual = jest.requireActual<typeof import('#/horizon/feedback/api')>(
    '#/horizon/feedback/api',
  )
  return {...actual, sendFeedback: (input: never) => mockSend(input)}
})
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentPdsClient: () => null,
}))
const mockToast = jest.fn()
jest.mock('#/components/Toast', () => ({
  show: (...args: unknown[]) => mockToast(...args),
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => ''}),
  }),
  web: () => ({}),
}))
jest.mock('#/components/Dialog', () => ({}))
jest.mock('#/horizon/identity/edit/fields', () => {
  const {TextInput} = require('react-native') as typeof import('react-native')
  return {
    LimitedField: ({
      testID,
      label,
      value,
      onChange,
    }: {
      testID?: string
      label: string
      value: string
      onChange: (value: string) => void
    }) => (
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint=""
        value={value}
        onChangeText={onChange}
      />
    ),
  }
})
jest.mock('#/components/forms/SegmentedControl', () => {
  const {View, Pressable, Text} =
    require('react-native') as typeof import('react-native')
  const noop: (picked: string) => void = () => {}
  const Context = (require('react') as typeof import('react')).createContext(
    noop,
  )
  return {
    Root: ({
      children,
      onChange,
    }: {
      children: React.ReactNode
      onChange: (value: string) => void
    }) => (
      <Context.Provider value={onChange}>
        <View>{children}</View>
      </Context.Provider>
    ),
    Item: ({
      testID,
      value,
      children,
    }: {
      testID?: string
      value: string
      children: React.ReactNode
    }) => (
      <Context.Consumer>
        {onChange => (
          <Pressable
            accessibilityRole="radio"
            testID={testID}
            onPress={() => onChange(value)}>
            {children}
          </Pressable>
        )}
      </Context.Consumer>
    ),
    ItemText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
  }
})
jest.mock('#/components/forms/Toggle', () => {
  const {Pressable, View, Text} =
    require('react-native') as typeof import('react-native')
  return {
    Item: ({
      label,
      value,
      onChange,
      children,
    }: {
      label: string
      value: boolean
      onChange: (value: boolean) => void
      children: React.ReactNode
    }) => (
      <Pressable
        testID="feedbackDetailsToggle"
        accessibilityRole="checkbox"
        accessibilityLabel={label}
        accessibilityHint=""
        accessibilityState={{checked: value}}
        onPress={() => onChange(!value)}>
        <View>{children}</View>
      </Pressable>
    ),
    Checkbox: () => null,
    LabelText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
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

import {FeedbackError} from '#/horizon/feedback/api'
import {FeedbackForm} from '#/horizon/feedback/FeedbackDialog'

i18n.loadAndActivate({locale: 'en', messages: {}})

function mount(onSent = jest.fn()) {
  const view = render(
    <I18nProvider i18n={i18n}>
      <FeedbackForm onSent={onSent} />
    </I18nProvider>,
  )
  return {...view, onSent}
}

beforeEach(() => {
  mockSend.mockReset()
  mockToast.mockReset()
})

describe('FeedbackForm', () => {
  it('waits for some text before Send works', () => {
    const {getByTestId} = mount()
    expect(getByTestId('feedbackSend').props.accessibilityState).toEqual(
      expect.objectContaining({disabled: true}),
    )
    fireEvent.changeText(getByTestId('feedbackText'), '   ')
    expect(getByTestId('feedbackSend').props.accessibilityState).toEqual(
      expect.objectContaining({disabled: true}),
    )
  })

  it('sends the kind, text and details choice, then thanks and closes', async () => {
    mockSend.mockResolvedValue()
    const {getByTestId, onSent} = mount()
    fireEvent.press(getByTestId('feedbackKindIdea'))
    fireEvent.changeText(getByTestId('feedbackText'), 'more themes')
    fireEvent.press(getByTestId('feedbackDetailsToggle'))
    await act(async () => {
      fireEvent.press(getByTestId('feedbackSend'))
      await Promise.resolve()
    })
    expect(mockSend).toHaveBeenCalledWith({
      kind: 'idea',
      text: 'more themes',
      includeDetails: false,
    })
    expect(mockToast).toHaveBeenCalled()
    expect(onSent).toHaveBeenCalled()
  })

  it('says when the daily limit is reached and keeps the text', async () => {
    mockSend.mockRejectedValue(new FeedbackError('rate-limited'))
    const {getByTestId, getByText, onSent} = mount()
    fireEvent.changeText(getByTestId('feedbackText'), 'one more')
    await act(async () => {
      fireEvent.press(getByTestId('feedbackSend'))
      await Promise.resolve()
    })
    expect(getByText(/a lot of feedback today/)).toBeTruthy()
    expect(getByTestId('feedbackText').props.value).toBe('one more')
    expect(onSent).not.toHaveBeenCalled()
  })
})
