import {Text} from 'react-native'
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, fireEvent, render} from '@testing-library/react-native'

import {
  HINT_DELAY_MS,
  ToolbarHint,
} from '#/horizon/composer-hints/ToolbarHint.web'

/*
 * The stock tooltip, reduced to what the hint drives: whether it is open,
 * whether it may take focus, and its bubble's text.
 */
const mockOuterProps: {takesFocus?: boolean}[] = []
jest.mock('#/components/Tooltip', () => {
  const {createContext: create, useContext: use} =
    jest.requireActual<typeof import('react')>('react')
  const {Text: RNText} =
    jest.requireActual<typeof import('react-native')>('react-native')
  const Visible = create(false)
  return {
    Outer: ({
      children,
      visible,
      takesFocus,
    }: {
      children: React.ReactNode
      visible: boolean
      takesFocus?: boolean
    }) => {
      mockOuterProps.push({takesFocus})
      return <Visible.Provider value={visible}>{children}</Visible.Provider>
    },
    Target: ({children}: {children: React.ReactNode}) => <>{children}</>,
    BubbleText: ({children}: {children: React.ReactNode}) =>
      use(Visible) ? <RNText testID="hintBubble">{children}</RNText> : null,
  }
})

function mouse(type: string) {
  return {nativeEvent: {pointerType: type}}
}

function setup() {
  return render(
    <ToolbarHint label="Add a GIF">
      <Text>GIF</Text>
    </ToolbarHint>,
  )
}

beforeEach(() => {
  jest.useFakeTimers()
  mockOuterProps.length = 0
})

afterEach(() => {
  jest.useRealTimers()
})

describe('ToolbarHint (change list 2, item 1)', () => {
  it('shows the label after the pointer rests, hides it on leave', () => {
    const {getByTestId, queryByTestId, getByText} = setup()
    expect(getByText('GIF')).toBeTruthy()
    const target = getByTestId('composerToolbarHintTarget')
    fireEvent(target, 'pointerEnter', mouse('mouse'))
    act(() => {
      jest.advanceTimersByTime(HINT_DELAY_MS - 1)
    })
    expect(queryByTestId('hintBubble')).toBeNull()
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(getByTestId('hintBubble').props.children).toBe('Add a GIF')
    fireEvent(target, 'pointerLeave', mouse('mouse'))
    expect(queryByTestId('hintBubble')).toBeNull()
  })

  it('a press hides it, and a leave before the delay cancels it', () => {
    const {getByTestId, queryByTestId} = setup()
    const target = getByTestId('composerToolbarHintTarget')
    fireEvent(target, 'pointerEnter', mouse('mouse'))
    act(() => {
      jest.advanceTimersByTime(HINT_DELAY_MS)
    })
    fireEvent(target, 'pointerDown', mouse('mouse'))
    expect(queryByTestId('hintBubble')).toBeNull()
    fireEvent(target, 'pointerEnter', mouse('mouse'))
    fireEvent(target, 'pointerLeave', mouse('mouse'))
    act(() => {
      jest.advanceTimersByTime(HINT_DELAY_MS * 2)
    })
    expect(queryByTestId('hintBubble')).toBeNull()
  })

  it('never for touch or pen, and never takes focus', () => {
    const {getByTestId, queryByTestId} = setup()
    const target = getByTestId('composerToolbarHintTarget')
    for (const type of ['touch', 'pen']) {
      fireEvent(target, 'pointerEnter', mouse(type))
      act(() => {
        jest.advanceTimersByTime(HINT_DELAY_MS * 2)
      })
      expect(queryByTestId('hintBubble')).toBeNull()
    }
    expect(mockOuterProps.every(p => p.takesFocus === false)).toBe(true)
  })

  it('native renders the button alone', () => {
    const {ToolbarHint: NativeHint} = jest.requireActual<{
      ToolbarHint: typeof ToolbarHint
    }>('#/horizon/composer-hints/ToolbarHint')
    const {toJSON} = render(
      <NativeHint label="Add a GIF">
        <Text>GIF</Text>
      </NativeHint>,
    )
    expect(toJSON()).toMatchObject({type: 'Text', children: ['GIF']})
  })
})
