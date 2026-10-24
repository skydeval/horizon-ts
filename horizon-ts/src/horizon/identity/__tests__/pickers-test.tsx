import {Text} from 'react-native'
import {afterAll, beforeAll, describe, expect, it, jest} from '@jest/globals'
import {act, fireEvent, render} from '@testing-library/react-native'

/*
 * The member editor's emoji and colour pickers (Phase 5 design 7.2, 6.5):
 * a pick sets the field, the emoji limit holds, closing a picker leaves the
 * Edit Profile dialog open, and the accessibility names, roles, states and
 * keyboard steps are in place. The design system's components are plain
 * views here; the native emoji picker and the web emoji-mart picker are
 * replaced by stubs that pick on a press, so the fields' logic is what is
 * tested. Jest runs the iOS preset, so the web and Android files are
 * imported by path.
 */

/** Lingui with the message's values filled in, so text can be asserted. */
function mockFill(message: string, values?: Record<string, unknown>) {
  return message.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values?.[key]
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : ''
  })
}
jest.mock('@lingui/react', () => ({
  useLingui: () => ({
    _: (d: {message?: string; values?: Record<string, unknown>}) =>
      mockFill(d.message ?? '', d.values),
    i18n: {
      _: (d: {message?: string; values?: Record<string, unknown>}) =>
        mockFill(d.message ?? '', d.values),
    },
  }),
  Trans: ({
    message,
    values,
  }: {
    message?: string
    values?: Record<string, unknown>
  }) => {
    const {Text} = require('react-native') as typeof import('react-native')
    return <Text>{mockFill(message ?? '', values)}</Text>
  },
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000000'}),
  }),
  web: (style: unknown) => style,
}))
const mockDialogClose = jest.fn()
jest.mock('#/components/Dialog', () => {
  const {TextInput} = require('react-native') as typeof import('react-native')
  return {
    Input: TextInput,
    useDialogContext: () => ({
      close: mockDialogClose,
      disableDrag: false,
      setDisableDrag: () => {},
    }),
  }
})
jest.mock('#/components/forms/TextField', () => {
  const {View, Text} = require('react-native') as typeof import('react-native')
  return {
    LabelText: ({children}: {children: React.ReactNode}) => (
      <Text>{children}</Text>
    ),
    Root: ({children}: {children: React.ReactNode}) => <View>{children}</View>,
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
      accessibilityState,
      children,
    }: {
      testID?: string
      label: string
      onPress?: () => void
      disabled?: boolean
      accessibilityState?: object
      children?: React.ReactNode
    }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint=""
        accessibilityState={accessibilityState}
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
jest.mock('#/components/Typography', () => {
  const {Text} = require('react-native') as typeof import('react-native')
  return {Text}
})
jest.mock('#/components/icons/Emoji', () => ({
  EmojiArc_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Check', () => ({
  Check_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Times', () => ({
  TimesLarge_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Plus', () => ({
  PlusLarge_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/view/com/composer/char-progress/CharProgress', () => ({
  CharProgress: () => null,
}))
/** Whether the code under test sees web; the radio keys are web only. */
let mockIsWeb = false
jest.mock('#/env', () => {
  // Kept an ES module with a live getter (an object spread would copy it).
  const env: object = {...jest.requireActual<object>('#/env')}
  Object.defineProperty(env, '__esModule', {value: true})
  Object.defineProperty(env, 'IS_WEB', {get: () => mockIsWeb})
  return env
})
jest.mock('#/state/a11y', () => ({
  useA11y: () => ({reduceMotionEnabled: true}),
}))
jest.mock('react-native-safe-area-context', () => {
  const {View} = require('react-native') as typeof import('react-native')
  return {SafeAreaView: View}
})
/** Each press on the stub picks the next emoji in this list. */
const mockPicks: string[] = []
jest.mock('@bsky.app/expo-emoji-picker', () => {
  const {Pressable, View} =
    require('react-native') as typeof import('react-native')
  return {
    EmojiPicker: ({
      children,
      onEmojiSelected,
    }: {
      children?: React.ReactNode
      onEmojiSelected: (emoji: string) => void
    }) => (
      <View>
        {children}
        <Pressable
          testID="stubNativePick"
          accessibilityRole="button"
          accessibilityLabel="pick"
          accessibilityHint=""
          onPress={() => onEmojiSelected(mockPicks.shift() ?? '🌿')}
        />
      </View>
    ),
  }
})
/*
 * The web picker: Root holds the select callback, Trigger renders its child
 * with the trigger props, Picker is a press that picks, and Escape is a
 * press that closes the menu (as Radix closes only the top layer).
 */
jest.mock('#/components/EmojiPicker', () => {
  const React = require('react') as typeof import('react')
  const {Pressable, View} =
    require('react-native') as typeof import('react-native')
  const Ctx = React.createContext<{
    onEmojiSelect?: (e: {native: string; name: string}) => void
    open: boolean
    setOpen: (open: boolean) => void
  }>({open: false, setOpen: () => {}})
  return {
    Root: ({
      children,
      onEmojiSelect,
    }: {
      children: React.ReactNode
      onEmojiSelect?: (e: {native: string; name: string}) => void
    }) => {
      const [open, setOpen] = React.useState(false)
      return (
        <Ctx.Provider value={{onEmojiSelect, open, setOpen}}>
          <View>{children}</View>
        </Ctx.Provider>
      )
    },
    Trigger: ({
      label,
      hint,
      children,
    }: {
      label: string
      hint?: string
      children: (p: {
        props: Record<string, unknown>
        state: {focused: boolean}
      }) => React.ReactNode
    }) => {
      const ctx = React.useContext(Ctx)
      return children({
        props: {
          accessibilityLabel: label,
          accessibilityHint: hint,
          onPress: () => ctx.setOpen(true),
        },
        state: {focused: false},
      })
    },
    Picker: () => {
      const ctx = React.useContext(Ctx)
      if (!ctx.open) return null
      return (
        <View testID="stubWebPicker">
          <Pressable
            testID="stubWebPick"
            accessibilityRole="button"
            accessibilityLabel="pick"
            accessibilityHint=""
            onPress={() => {
              ctx.onEmojiSelect?.({native: '🦊', name: 'Fox Face'})
              ctx.setOpen(false)
            }}
          />
          <Pressable
            testID="stubWebEscape"
            accessibilityRole="button"
            accessibilityLabel="escape"
            accessibilityHint=""
            onPress={() => ctx.setOpen(false)}
          />
        </View>
      )
    },
  }
})

import {useState} from 'react'
import {i18n} from '@lingui/core'

import {radioGroupKey} from '#/horizon/identity/edit/a11y'
import {ChannelSlider as WebChannelSlider} from '#/horizon/identity/edit/ChannelSlider/index.web'
import {colorName, hexToHsl, hslToHex} from '#/horizon/identity/edit/color-math'
import {ColorField, colorValid} from '#/horizon/identity/edit/ColorField'
import {CustomColorSwatch as WebSwatch} from '#/horizon/identity/edit/CustomColorSwatch/index.web'
import {insertEmoji} from '#/horizon/identity/edit/emoji-insert'
import {EmojiField} from '#/horizon/identity/edit/EmojiField'
import {EmojiPickerButton as AndroidButton} from '#/horizon/identity/edit/EmojiPickerButton/index.android'
import {EmojiPickerButton as WebButton} from '#/horizon/identity/edit/EmojiPickerButton/index.web'

i18n.loadAndActivate({locale: 'en', messages: {}})

/** A controlled field with its value exposed. */
function mountEmoji(initial = '') {
  const ref = {value: initial}
  function Harness() {
    const [value, setValue] = useState(initial)
    ref.value = value
    return (
      <EmojiField
        value={value}
        onChange={(next: string) => {
          ref.value = next
          setValue(next)
        }}
      />
    )
  }
  return {view: render(<Harness />), ref}
}

function mountColor(initial = '') {
  const ref = {value: initial}
  function Harness() {
    const [value, setValue] = useState(initial)
    ref.value = value
    return (
      <ColorField
        value={value}
        onChange={(next: string) => {
          ref.value = next
          setValue(next)
        }}
      />
    )
  }
  return {view: render(<Harness />), ref}
}

/** The handlers a host input is given, as the tests call them. */
type InputHandlers = {
  onChange: (e: {currentTarget: {value: string}}) => void
  onKeyDown: (e: {key: string; preventDefault: () => void}) => void
}

/** The props of the first host `input` element of a given type. */
function hostInput(view: ReturnType<typeof render>, type: string) {
  const found = view.UNSAFE_root.findAll(
    node => node.type === 'input' && node.props.type === type,
  )
  return found[0]
}

describe('insertEmoji', () => {
  it('appends without a cursor, and goes at the cursor with one', () => {
    expect(insertEmoji('🌿', '🦊', undefined, 4)).toEqual({
      ok: true,
      value: '🌿🦊',
      cursor: 4,
    })
    expect(insertEmoji('🌿🌙', '🦊', {start: 2, end: 2}, 4)).toEqual({
      ok: true,
      value: '🌿🦊🌙',
      cursor: 4,
    })
  })

  it('replaces a selection, so a full field can be swapped', () => {
    expect(insertEmoji('🌿🌙⭐🔥', '🦊', {start: 0, end: 8}, 4)).toMatchObject({
      ok: true,
      value: '🦊',
    })
  })

  it('refuses a pick past the grapheme limit', () => {
    expect(insertEmoji('🌿🌙⭐🔥', '🦊', undefined, 4)).toEqual({
      ok: false,
      reason: 'full',
    })
  })

  it('counts a ZWJ family as one and never splits it', () => {
    const family = '👨‍👩‍👧'
    expect(insertEmoji(family, '🦊', undefined, 2)).toMatchObject({ok: true})
    // A cursor inside the sequence moves to its end.
    expect(insertEmoji(family, '🦊', {start: 3, end: 3}, 4)).toMatchObject({
      value: `${family}🦊`,
    })
  })
})

describe('the emoji field (native picker)', () => {
  it('labels the button and sets the field from a pick, announcing it', () => {
    const {view, ref} = mountEmoji()
    const button = view.getByTestId('memberEmojiPickerButton')
    expect(button.props.accessibilityRole).toBe('button')
    expect(button.props.accessibilityLabel).toBe('Choose an emoji')
    mockPicks.push('🦊')
    fireEvent.press(view.getByTestId('stubNativePick'))
    expect(ref.value).toBe('🦊')
    const note = view.getByTestId('memberEmojiNote')
    expect(note.props.accessibilityLiveRegion).toBe('polite')
    expect(note.props.children).toBe('Added 🦊')
  })

  it('puts a pick at the cursor', () => {
    const {view, ref} = mountEmoji('🌿🌙')
    fireEvent(view.getByTestId('memberEmojiInput'), 'selectionChange', {
      nativeEvent: {selection: {start: 2, end: 2}},
    })
    mockPicks.push('🦊')
    fireEvent.press(view.getByTestId('stubNativePick'))
    expect(ref.value).toBe('🌿🦊🌙')
  })

  it('holds the 4-grapheme limit, refusing with a note', () => {
    const {view, ref} = mountEmoji('🌿🌙⭐🔥')
    mockPicks.push('🦊')
    fireEvent.press(view.getByTestId('stubNativePick'))
    expect(ref.value).toBe('🌿🌙⭐🔥')
    expect(view.getByTestId('memberEmojiNote').props.children).toBe(
      'The emoji field is full. Remove one to add another.',
    )
  })
})

describe('the emoji picker on web', () => {
  it('opens from a labelled button, sets the emoji by name, and closing leaves the dialog open', () => {
    const picked: Array<{native: string; name?: string}> = []
    const view = render(<WebButton onPick={e => picked.push(e)} />)
    const button = view.getByTestId('memberEmojiPickerButton')
    expect(button.props.accessibilityLabel).toBe('Choose an emoji')
    expect(view.queryByTestId('stubWebPicker')).toBeNull()
    fireEvent.press(button)
    fireEvent.press(view.getByTestId('stubWebPick'))
    expect(picked).toEqual([{native: '🦊', name: 'Fox Face'}])
    expect(view.queryByTestId('stubWebPicker')).toBeNull()

    fireEvent.press(button)
    fireEvent.press(view.getByTestId('stubWebEscape'))
    expect(view.queryByTestId('stubWebPicker')).toBeNull()
    expect(mockDialogClose).not.toHaveBeenCalled()
  })
})

describe('the emoji picker on Android', () => {
  it('opens a modal; a pick or back closes only the modal', () => {
    jest.useFakeTimers()
    const picked: string[] = []
    const view = render(
      <>
        <Text testID="dialogBody">dialog</Text>
        <AndroidButton onPick={e => picked.push(e.native)} />
      </>,
    )
    const modal = () =>
      view.UNSAFE_getByProps({testID: 'memberEmojiPickerButton-modal'})
    expect(modal().props.visible).toBe(false)
    fireEvent.press(view.getByTestId('memberEmojiPickerButton'))
    expect(modal().props.visible).toBe(true)
    expect(modal().props.animationType).toBe('none')
    act(() => (modal().props as {onRequestClose: () => void}).onRequestClose())
    expect(modal().props.visible).toBe(false)
    expect(view.getByTestId('dialogBody')).toBeTruthy()
    expect(mockDialogClose).not.toHaveBeenCalled()

    fireEvent.press(view.getByTestId('memberEmojiPickerButton'))
    mockPicks.push('🌙')
    fireEvent.press(view.getByTestId('stubNativePick'))
    expect(picked).toEqual(['🌙'])
    expect(modal().props.visible).toBe(false)
    act(() => {
      jest.runAllTimers()
    })
    jest.useRealTimers()
  })
})

describe('colour maths', () => {
  it('round-trips hex through HSL and names colours', () => {
    expect(hexToHsl('#FF0000')).toEqual({h: 0, s: 100, l: 50})
    expect(hslToHex({h: 0, s: 100, l: 50})).toBe('#FF0000')
    // Whole-number HSL lands within 2 of each RGB channel.
    const channels = (hex: string) =>
      [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    for (const hex of ['#30A46C', '#0090FF', '#8E4EC6', '#FFC53D']) {
      const back = channels(hslToHex(hexToHsl(hex)!))
      channels(hex).forEach((c, i) =>
        expect(Math.abs(c - back[i])).toBeLessThanOrEqual(2),
      )
    }
    expect(hexToHsl('#12345')).toBeNull()
    expect(colorName('#0090FF')).toEqual({hue: 'blue'})
    expect(colorName('#0A1F44')).toEqual({hue: 'blue', shade: 'dark'})
    expect(colorName('#FFFFFF')).toEqual({hue: 'white'})
    expect(colorName('#8B8D98')).toMatchObject({hue: 'grey'})
  })
})

describe('the colour field', () => {
  it('is a radio group of presets named by colour, the chosen one checked and marked', () => {
    const {view, ref} = mountColor('#30A46C')
    const group = view.getByTestId('memberColorPresets')
    expect(group.props.accessibilityRole).toBe('radiogroup')
    expect(group.props.accessibilityLabel).toBe('Preset colours')
    const green = view.getByTestId('memberColorPreset-#30A46C')
    expect(green.props.accessibilityRole).toBe('radio')
    expect(green.props.accessibilityLabel).toBe('Green, #30A46C')
    expect(green.props.accessibilityState).toMatchObject({checked: true})
    expect(view.getByTestId('memberColorPresetCheck-#30A46C')).toBeTruthy()
    expect(view.queryByTestId('memberColorPresetCheck-#E5484D')).toBeNull()

    fireEvent.press(view.getByTestId('memberColorPreset-#E5484D'))
    expect(ref.value).toBe('#E5484D')
    expect(
      view.getByTestId('memberColorPreset-#E5484D').props.accessibilityState,
    ).toMatchObject({checked: true})
    expect(
      view.getByTestId('memberColorPreset-#30A46C').props.accessibilityState,
    ).toMatchObject({checked: false})
  })

  it('gives the colour in words and refuses an invalid hex through a live region', () => {
    const {view} = mountColor('#0090FF')
    expect(view.getByTestId('memberColorSwatch').props.accessibilityLabel).toBe(
      'Custom colour: blue, #0090FF',
    )
    fireEvent.changeText(view.getByTestId('memberColorInput'), '#12')
    expect(colorValid('#12')).toBe(false)
    const error = view.getByTestId('memberColorError')
    expect(error.props.accessibilityLiveRegion).toBe('polite')
    expect(view.getByText('Use a hex code like #30A46C.')).toBeTruthy()
    expect(view.getByTestId('memberColorSwatch').props.accessibilityLabel).toBe(
      'Custom colour: none chosen',
    )
  })

  it('opens adjustable sliders whose steps update the hex field and the swatch', () => {
    const {view, ref} = mountColor('#FF0000')
    const toggle = view.getByTestId('memberColorSlidersToggle')
    expect(toggle.props.accessibilityState).toMatchObject({expanded: false})
    fireEvent.press(toggle)
    expect(
      view.getByTestId('memberColorSlidersToggle').props.accessibilityState,
    ).toMatchObject({expanded: true})

    const hue = view.getByTestId('memberColorHue')
    expect(hue.props.accessibilityRole).toBe('adjustable')
    expect(hue.props.accessibilityLabel).toBe('Hue')
    expect(hue.props.accessibilityValue).toEqual({text: '0 degrees'})
    expect(
      view.getByTestId('memberColorLightness').props.accessibilityValue,
    ).toEqual({text: '50 percent'})

    fireEvent(hue, 'accessibilityAction', {
      nativeEvent: {actionName: 'increment'},
    })
    expect(ref.value).toBe(hslToHex({h: 1, s: 100, l: 50}))
    expect(view.getByTestId('memberColorInput').props.value).toBe(ref.value)
    expect(view.getByTestId('memberColorHue').props.accessibilityValue).toEqual(
      {text: '1 degrees'},
    )

    fireEvent(view.getByTestId('memberColorLightness'), 'accessibilityAction', {
      nativeEvent: {actionName: 'decrement'},
    })
    expect(hexToHsl(ref.value)?.l).toBe(49)

    // Typing a valid hex moves the sliders to it.
    fireEvent.changeText(view.getByTestId('memberColorInput'), '#0090FF')
    expect(
      (
        view.getByTestId('memberColorHue').props as {
          accessibilityValue: {text: string}
        }
      ).accessibilityValue.text,
    ).toBe(`${hexToHsl('#0090FF')!.h} degrees`)
  })

  it('on native, the swatch toggles the sliders and reports it', () => {
    const {view} = mountColor('#0090FF')
    const swatch = view.getByTestId('memberColorSwatch')
    expect(swatch.props.accessibilityRole).toBe('button')
    expect(swatch.props.accessibilityState).toMatchObject({expanded: false})
    fireEvent.press(swatch)
    expect(view.getByTestId('memberColorSliders')).toBeTruthy()
  })
})

describe('the preset radio group keys', () => {
  it('maps arrows with wrap-around, Home, End and Space', () => {
    expect(radioGroupKey('ArrowRight', 0, 9)).toBe(1)
    expect(radioGroupKey('ArrowDown', 8, 9)).toBe(0)
    expect(radioGroupKey('ArrowLeft', 0, 9)).toBe(8)
    expect(radioGroupKey('ArrowUp', 4, 9)).toBe(3)
    expect(radioGroupKey('Home', 5, 9)).toBe(0)
    expect(radioGroupKey('End', 2, 9)).toBe(8)
    expect(radioGroupKey(' ', 2, 9)).toBe('select')
    expect(radioGroupKey('Tab', 2, 9)).toBeNull()
    expect(radioGroupKey('a', 2, 9)).toBeNull()
  })

  describe('on web', () => {
    beforeAll(() => {
      mockIsWeb = true
    })
    afterAll(() => {
      mockIsWeb = false
    })

    const presets = [
      '#E5484D',
      '#F76B15',
      '#FFC53D',
      '#30A46C',
      '#12A594',
      '#0090FF',
      '#8E4EC6',
      '#D6409F',
      '#8B8D98',
    ]
    type KeyProps = {
      tabIndex?: number
      onKeyDown: (e: {key: string; preventDefault: () => void}) => void
    }
    function radio(view: ReturnType<typeof render>, hex: string) {
      return view.getByTestId('memberColorPreset-' + hex).props as KeyProps
    }
    function tabStops(view: ReturnType<typeof render>) {
      return presets.filter(hex => radio(view, hex).tabIndex === 0)
    }
    function press(view: ReturnType<typeof render>, hex: string, key: string) {
      const preventDefault = jest.fn()
      act(() => radio(view, hex).onKeyDown({key, preventDefault}))
      return preventDefault
    }

    it('is a labelled radiogroup with one Tab stop: the first when none is checked', () => {
      const {view} = mountColor('')
      const group = view.getByTestId('memberColorPresets')
      expect(group.props.role).toBe('radiogroup')
      expect(group.props['aria-label']).toBe('Preset colours')
      expect(tabStops(view)).toEqual(['#E5484D'])
    })

    it('puts the Tab stop on the checked radio, also for a typed hex', () => {
      const {view} = mountColor('#0090ff')
      expect(tabStops(view)).toEqual(['#0090FF'])
    })

    it('arrows move selection and the Tab stop, wrapping both ways', () => {
      const {view, ref} = mountColor('#E5484D')
      expect(press(view, '#E5484D', 'ArrowLeft')).toHaveBeenCalled()
      expect(ref.value).toBe('#8B8D98')
      expect(tabStops(view)).toEqual(['#8B8D98'])
      press(view, '#8B8D98', 'ArrowRight')
      expect(ref.value).toBe('#E5484D')
      press(view, '#E5484D', 'ArrowDown')
      expect(ref.value).toBe('#F76B15')
      press(view, '#F76B15', 'ArrowUp')
      expect(ref.value).toBe('#E5484D')
      expect(tabStops(view)).toEqual(['#E5484D'])
    })

    it('Home and End go to the first and last', () => {
      const {view, ref} = mountColor('#30A46C')
      press(view, '#30A46C', 'End')
      expect(ref.value).toBe('#8B8D98')
      press(view, '#8B8D98', 'Home')
      expect(ref.value).toBe('#E5484D')
      expect(tabStops(view)).toEqual(['#E5484D'])
    })

    it('Space checks the focused radio; other keys pass through', () => {
      const {view, ref} = mountColor('')
      expect(press(view, '#E5484D', ' ')).toHaveBeenCalled()
      expect(ref.value).toBe('#E5484D')
      expect(
        view.getByTestId('memberColorPreset-#E5484D').props.accessibilityState,
      ).toMatchObject({checked: true})
      expect(press(view, '#E5484D', 'Tab')).not.toHaveBeenCalled()
      expect(ref.value).toBe('#E5484D')
    })
  })
})

describe('the colour pickers on web', () => {
  it('the swatch is a labelled button over a hidden colour input, synced both ways', () => {
    const changes: string[] = []
    function Harness({color}: {color: string}) {
      return (
        <WebSwatch
          color={color}
          label="Custom colour: blue, #0090FF"
          onChange={hex => changes.push(hex)}
          expanded={false}
          onToggleSliders={() => {}}
        />
      )
    }
    const view = render(<Harness color="#0090FF" />)
    const swatch = view.getByTestId('memberColorSwatch')
    expect(swatch.props.accessibilityRole).toBe('button')
    expect(swatch.props.accessibilityLabel).toBe('Custom colour: blue, #0090FF')
    const input = hostInput(view, 'color')
    expect(input.props.tabIndex).toBe(-1)
    expect(input.props['aria-hidden']).toBe(true)
    expect(input.props.value).toBe('#0090ff')
    ;(input.props as InputHandlers).onChange({
      currentTarget: {value: '#12a594'},
    })
    expect(changes).toEqual(['#12A594'])
    view.rerender(<Harness color="#12A594" />)
    expect(hostInput(view, 'color').props.value).toBe('#12a594')
  })

  it('the slider is a labelled range with value text and Page Up/Down steps', () => {
    const values: number[] = []
    const view = render(
      <WebChannelSlider
        testID="hue"
        label="Hue"
        value={200}
        min={0}
        max={359}
        pageStep={30}
        valueText="200 degrees"
        onChange={v => values.push(v)}
        track={['#FF0000', '#0000FF']}
      />,
    )
    const range = hostInput(view, 'range')
    expect(range.props['aria-label']).toBe('Hue')
    expect(range.props['aria-valuetext']).toBe('200 degrees')
    expect(range.props.min).toBe(0)
    expect(range.props.max).toBe(359)
    const keyDown = (key: string) =>
      (range.props as InputHandlers).onKeyDown({
        key,
        preventDefault: () => {},
      })
    keyDown('PageUp')
    keyDown('PageDown')
    ;(range.props as InputHandlers).onChange({currentTarget: {value: '359'}})
    expect(values).toEqual([230, 170, 359])
  })
})
