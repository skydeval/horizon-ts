/*
 * A member's colour (Phase 5 design 7.2, 6.5): preset swatches, a custom
 * swatch, a hex text field and hue, saturation and lightness sliders, so
 * colour is never the only way to choose or read it. The value is
 * `#RRGGBB` or empty (no colour).
 *
 * The presets are a radio group named by colour; the chosen one shows a
 * ring and a check mark, not colour alone. The custom swatch opens the
 * browser's colour picker on web and the sliders on native. The current
 * colour is also given in words (a rough name, see `colorName`). The colour
 * only ever shows as a dot, so no contrast rule applies to the colour
 * itself; every swatch has a border so very light or dark colours stay
 * visible in every theme.
 */

import {useRef, useState} from 'react'
import {Pressable, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import {Check_Stroke2_Corner0_Rounded as CheckIcon} from '#/components/icons/Check'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {
  focusRing,
  MIN_TARGET,
  radioGroupKey,
} from '#/horizon/identity/edit/a11y'
import {ChannelSlider} from '#/horizon/identity/edit/ChannelSlider'
import {
  type ColorHue,
  colorName,
  hexToHsl,
  type Hsl,
  hslToHex,
} from '#/horizon/identity/edit/color-math'
import {CustomColorSwatch} from '#/horizon/identity/edit/CustomColorSwatch'
import {COLOR_PRESETS} from '#/horizon/identity/edit/suggestions'

const COLOR = /^#[0-9A-Fa-f]{6}$/

/** Whether a colour field value can be written (empty is no colour). */
export function colorValid(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || COLOR.test(trimmed)
}

/** Where the sliders start when the field has no colour. */
const START_HSL: Hsl = {h: 210, s: 70, l: 50}

/** The current colour in words, e.g. "dark blue", or empty. */
function useColorWords() {
  const {t: l} = useLingui()
  const hues: Record<ColorHue, string> = {
    red: l({message: 'red', comment: 'A colour name, read with its hex'}),
    orange: l({message: 'orange', comment: 'A colour name, read with its hex'}),
    yellow: l({message: 'yellow', comment: 'A colour name, read with its hex'}),
    green: l({message: 'green', comment: 'A colour name, read with its hex'}),
    teal: l({message: 'teal', comment: 'A colour name, read with its hex'}),
    blue: l({message: 'blue', comment: 'A colour name, read with its hex'}),
    purple: l({message: 'purple', comment: 'A colour name, read with its hex'}),
    pink: l({message: 'pink', comment: 'A colour name, read with its hex'}),
    brown: l({message: 'brown', comment: 'A colour name, read with its hex'}),
    grey: l({message: 'grey', comment: 'A colour name, read with its hex'}),
    white: l({message: 'white', comment: 'A colour name, read with its hex'}),
    black: l({message: 'black', comment: 'A colour name, read with its hex'}),
  }
  return (hex: string): string => {
    const name = colorName(hex)
    if (!name) return ''
    const hue = hues[name.hue]
    if (name.shade === 'light') {
      return l({
        message: `light ${hue}`,
        comment: 'A light shade of a colour, e.g. "light blue"',
      })
    }
    if (name.shade === 'dark') {
      return l({
        message: `dark ${hue}`,
        comment: 'A dark shade of a colour, e.g. "dark blue"',
      })
    }
    return hue
  }
}

export function ColorField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const words = useColorWords()
  const valid = colorValid(value)
  const current = value.trim().toUpperCase()
  const shown = valid && current ? current : ''
  const [slidersOpen, setSlidersOpen] = useState(false)

  /*
   * The presets are one Tab stop (roving tabindex): the checked radio, or
   * the first when none is. Arrows move selection and focus together,
   * wrapping; Home and End go to the ends; Space checks the focused one.
   */
  const checkedIndex = COLOR_PRESETS.findIndex(
    preset => current === preset.value.toUpperCase(),
  )
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0
  const presetRefs = useRef<Array<Focusable | null>>([])
  const onPresetKey = (index: number, key: string): boolean => {
    const target = radioGroupKey(key, index, COLOR_PRESETS.length)
    if (target === null) return false
    if (target === 'select') {
      onChange(COLOR_PRESETS[index].value)
      return true
    }
    onChange(COLOR_PRESETS[target].value)
    const el = presetRefs.current[target]
    if (el && typeof el.focus === 'function') el.focus()
    return true
  }

  /*
   * The sliders keep their own HSL so a hue survives grey and black, and
   * follow the field when it changes from elsewhere (a preset, typing).
   */
  const [hsl, setHsl] = useState<Hsl>(() => hexToHsl(shown) ?? START_HSL)
  const [syncedTo, setSyncedTo] = useState(shown)
  if (shown !== syncedTo) {
    setSyncedTo(shown)
    const parsed = hexToHsl(shown)
    if (parsed && hslToHex(hsl) !== shown) setHsl(parsed)
  }
  const setChannel = (next: Hsl) => {
    setHsl(next)
    onChange(hslToHex(next))
  }

  const inWords = shown ? words(shown) : ''
  const swatchLabel = shown
    ? l`Custom colour: ${inWords}, ${shown}`
    : l`Custom colour: none chosen`

  const hueTrack = Array.from({length: 13}, (_, i) =>
    hslToHex({h: i * 30, s: hsl.s, l: hsl.l}),
  )
  const satTrack = Array.from({length: 6}, (_, i) =>
    hslToHex({h: hsl.h, s: i * 20, l: hsl.l}),
  )
  const lightTrack = Array.from({length: 11}, (_, i) =>
    hslToHex({h: hsl.h, s: hsl.s, l: i * 10}),
  )

  return (
    <View style={[a.gap_sm]}>
      <TextField.LabelText>
        <Trans>Colour</Trans>
      </TextField.LabelText>
      <View
        testID="memberColorPresets"
        role="radiogroup"
        aria-label={l`Preset colours`}
        accessibilityRole="radiogroup"
        accessibilityLabel={l`Preset colours`}
        accessibilityHint=""
        style={[a.flex_row, a.flex_wrap, a.gap_sm]}>
        {COLOR_PRESETS.map((preset, index) => (
          <PresetSwatch
            key={preset.value}
            value={preset.value}
            name={i18n._(preset.label)}
            selected={index === checkedIndex}
            tabStop={index === tabStop}
            focusRef={el => {
              presetRefs.current[index] = el
            }}
            onPress={() => onChange(preset.value)}
            onKey={key => onPresetKey(index, key)}
          />
        ))}
      </View>
      <View style={[a.flex_row, a.align_center, a.gap_sm]}>
        <CustomColorSwatch
          color={shown}
          label={swatchLabel}
          onChange={onChange}
          expanded={slidersOpen}
          onToggleSliders={() => setSlidersOpen(open => !open)}
        />
        <View style={[a.flex_1]}>
          <TextField.Root isInvalid={!valid}>
            <Dialog.Input
              testID="memberColorInput"
              label={l`Colour as a hex code`}
              accessibilityHint={
                inWords
                  ? l`Currently ${inWords}. Use a hex code like #30A46C.`
                  : l`Use a hex code like #30A46C.`
              }
              value={value}
              onChangeText={onChange}
              placeholder="#RRGGBB"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </TextField.Root>
        </View>
        {value ? (
          <Button
            label={l`No colour`}
            onPress={() => onChange('')}
            size="small"
            color="secondary"
            style={{minHeight: MIN_TARGET, minWidth: MIN_TARGET}}>
            <ButtonText>
              <Trans>None</Trans>
            </ButtonText>
          </Button>
        ) : null}
      </View>
      {inWords ? (
        <Text
          testID="memberColorWords"
          style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>
            Looks like {inWords} ({shown})
          </Trans>
        </Text>
      ) : null}
      <Text
        testID="memberColorError"
        accessibilityLiveRegion="polite"
        style={[a.text_sm, {color: t.palette.negative_400}]}>
        {!valid ? <Trans>Use a hex code like #30A46C.</Trans> : ''}
      </Text>
      <View style={[a.flex_row]}>
        <Button
          testID="memberColorSlidersToggle"
          label={slidersOpen ? l`Hide colour sliders` : l`Show colour sliders`}
          accessibilityState={{expanded: slidersOpen}}
          aria-expanded={slidersOpen}
          onPress={() => setSlidersOpen(open => !open)}
          size="small"
          color="secondary"
          style={{minHeight: MIN_TARGET}}>
          <ButtonText>
            {slidersOpen ? (
              <Trans>Hide sliders</Trans>
            ) : (
              <Trans>Adjust with sliders</Trans>
            )}
          </ButtonText>
        </Button>
      </View>
      {slidersOpen ? (
        <View testID="memberColorSliders" style={[a.gap_xs]}>
          <SliderRow label={l`Hue`}>
            <ChannelSlider
              testID="memberColorHue"
              label={l`Hue`}
              value={hsl.h}
              min={0}
              max={359}
              pageStep={30}
              valueText={l`${hsl.h} degrees`}
              onChange={h => setChannel({...hsl, h})}
              track={hueTrack}
            />
          </SliderRow>
          <SliderRow label={l`Saturation`}>
            <ChannelSlider
              testID="memberColorSaturation"
              label={l`Saturation`}
              value={hsl.s}
              min={0}
              max={100}
              valueText={l`${hsl.s} percent`}
              onChange={s => setChannel({...hsl, s})}
              track={satTrack}
            />
          </SliderRow>
          <SliderRow label={l`Lightness`}>
            <ChannelSlider
              testID="memberColorLightness"
              label={l`Lightness`}
              value={hsl.l}
              min={0}
              max={100}
              valueText={l`${hsl.l} percent`}
              onChange={next => setChannel({...hsl, l: next})}
              track={lightTrack}
            />
          </SliderRow>
        </View>
      ) : null}
    </View>
  )
}

/** A visible caption over a slider; the slider carries its own name. */
function SliderRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  const t = useTheme()
  return (
    <View>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[a.text_xs, a.font_medium, t.atoms.text_contrast_medium]}>
        {label}
      </Text>
      {children}
    </View>
  )
}

type Focusable = {focus: () => void}

/** One preset: a radio, named by colour and hex, checked with a mark. */
function PresetSwatch({
  value,
  name,
  selected,
  tabStop,
  focusRef,
  onPress,
  onKey,
}: {
  value: string
  name: string
  selected: boolean
  /** Whether this radio is the group's one Tab stop. */
  tabStop: boolean
  focusRef: (el: Focusable | null) => void
  onPress: () => void
  /** A key pressed on this radio; true when the group handled it. */
  onKey: (key: string) => boolean
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const [focused, setFocused] = useState(false)
  // react-native-web forwards onKeyDown on Pressable; native has no use for it.
  const keyProps = IS_WEB
    ? {
        onKeyDown: (e: {key: string; preventDefault: () => void}) => {
          if (onKey(e.key)) e.preventDefault()
        },
      }
    : {}
  return (
    <Pressable
      ref={focusRef}
      testID={`memberColorPreset-${value}`}
      tabIndex={IS_WEB ? (tabStop ? 0 : -1) : undefined}
      {...(keyProps as {})}
      role="radio"
      accessibilityRole="radio"
      accessibilityLabel={l`${name}, ${value}`}
      accessibilityHint=""
      accessibilityState={{checked: selected, selected}}
      aria-checked={selected}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        a.align_center,
        a.justify_center,
        a.rounded_full,
        {
          width: MIN_TARGET,
          height: MIN_TARGET,
          borderWidth: 2,
          borderColor: selected ? t.atoms.text.color : 'transparent',
        },
        focusRing(t.palette.primary_500, focused),
      ]}>
      <View
        style={[
          a.rounded_full,
          a.border,
          t.atoms.border_contrast_high,
          {width: 32, height: 32, backgroundColor: value},
        ]}
      />
      {selected ? (
        <View
          testID={`memberColorPresetCheck-${value}`}
          style={[
            a.absolute,
            a.rounded_full,
            a.align_center,
            a.justify_center,
            a.border,
            t.atoms.bg,
            t.atoms.border_contrast_high,
            {right: -2, bottom: -2, width: 18, height: 18},
          ]}>
          <CheckIcon size="xs" fill={t.atoms.text.color} />
        </View>
      ) : null}
    </Pressable>
  )
}
