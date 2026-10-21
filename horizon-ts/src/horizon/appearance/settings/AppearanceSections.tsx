/*
 * Horizon's Appearance sections (Phase 3 design, section 10), after Dark
 * theme and before Font (BD-11): the Backdrops group (the shown name, the
 * swatches in sections by collection (change list 2), the Custom chip and,
 * while Custom is selected, its card), the per-device opt-out ("Keep this
 * device's own appearance", which since change list 2 covers the theme
 * settings too), "Backdrop softness" (live fix batch 1), "Film grain" (web,
 * change list 2), then the "Phone frame" picker of 10.8 (while
 * `SHOW_FRAME_STYLE_PICKER`), whose Gutter style replaced the "Reading card
 * on small screens" toggle.
 */

import {useState} from 'react'
import {type NativeSyntheticEvent, Pressable, View} from 'react-native'
import Animated, {LinearTransition} from 'react-native-reanimated'
import {useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {AppearanceToggleButtonGroup} from '#/screens/Settings/AppearanceSettings'
import * as SettingsList from '#/screens/Settings/components/SettingsList'
import {atoms as a, native, useBreakpoints, useTheme, web} from '#/alf'
import * as Toggle from '#/components/forms/Toggle'
import {Moon_Stroke2_Corner0_Rounded as MoonIcon} from '#/components/icons/Moon'
import {PaintRoller_Stroke2_Corner2_Rounded as PaintRollerIcon} from '#/components/icons/PaintRoller'
import {Phone_Stroke2_Corner0_Rounded as PhoneIcon} from '#/components/icons/Phone'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {BackdropFill} from '#/horizon/appearance/settings/BackdropFill'
import {CustomEditor} from '#/horizon/appearance/settings/CustomEditor'
import {swatchKeyDown} from '#/horizon/appearance/settings/keys'
import {
  PICKER_SECTIONS,
  type PickerCollection,
} from '#/horizon/appearance/settings/picker'
import {SoftnessSlider} from '#/horizon/appearance/settings/SoftnessSlider'
import {
  effectiveAppearance,
  selectBackdrop,
  setBackdropSoftness,
  setFrameStyle,
  setGrain,
  setOptOut,
  useAppearanceState,
} from '#/horizon/appearance/store'
import {useCoarsePointer} from '#/horizon/backdrops/coarse-pointer'
import {
  FRAME_STYLES,
  type FrameStyle,
  offersFrameStylePicker,
  SHOW_FRAME_STYLE_PICKER,
} from '#/horizon/backdrops/frame-style'
import {
  BACKDROP_CUSTOM,
  BACKDROP_DEFS,
  BACKDROP_SKIES_AUTO,
  CUSTOM_NAME,
  customDef,
  registryDef,
  resolveBackdrop,
} from '#/horizon/backdrops/registry'
import {SWATCH_SIZE, swatchDef} from '#/horizon/backdrops/swatch'
import {type BackdropDef} from '#/horizon/backdrops/types'
import {BACKDROPS, COMPACT_FRAME_WINDOWS} from '#/horizon/switches'

const GAP = 10
const CHIP_DOT = 18

/** True for keyboard focus (`:focus-visible`) on web; never on native. */
function isKeyboardFocus(e: NativeSyntheticEvent<unknown>): boolean {
  if (!IS_WEB) return false
  const el = e.currentTarget as unknown as {
    matches?: (selector: string) => boolean
  } | null
  try {
    return el?.matches?.(':focus-visible') ?? false
  } catch {
    return true
  }
}

/** The ring outside a selected or keyboard-focused tile (10.2). */
function Ring({selected, focused}: {selected: boolean; focused: boolean}) {
  const t = useTheme()
  if (!selected && !focused) return null
  return (
    <View
      pointerEvents="none"
      style={[
        a.absolute,
        {
          top: -4,
          left: -4,
          right: -4,
          bottom: -4,
          borderRadius: 18,
          borderWidth: selected && focused ? 3 : 2,
          borderColor: focused ? t.palette.primary_500 : t.atoms.text.color,
        },
      ]}
    />
  )
}

function Swatch({
  def,
  name,
  selected,
  onSelect,
  onShowName,
}: {
  def: BackdropDef
  name: string
  selected: boolean
  onSelect: () => void
  onShowName: (name: string | null) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={name}
      accessibilityHint={selected ? '' : l`Sets the backdrop`}
      accessibilityState={{checked: selected}}
      onPress={onSelect}
      onHoverIn={() => onShowName(name)}
      onHoverOut={() => onShowName(null)}
      onFocus={e => {
        onShowName(name)
        setFocused(isKeyboardFocus(e))
      }}
      onBlur={() => {
        onShowName(null)
        setFocused(false)
      }}
      {...web({onKeyDown: swatchKeyDown(onSelect)})}
      style={[{width: SWATCH_SIZE, height: SWATCH_SIZE}]}>
      <View
        style={[
          a.overflow_hidden,
          t.atoms.border_contrast_low,
          {
            width: SWATCH_SIZE,
            height: SWATCH_SIZE,
            borderRadius: 14,
            borderWidth: 1,
          },
          def.stripes.length === 0 && t.atoms.bg,
        ]}>
        <BackdropFill
          def={swatchDef(def, t.name)}
          theme={t.name}
          size={SWATCH_SIZE}
        />
      </View>
      <Ring selected={selected} focused={focused} />
    </Pressable>
  )
}

function CustomChip({
  def,
  selected,
  onSelect,
  onShowName,
}: {
  def: BackdropDef
  selected: boolean
  onSelect: () => void
  onShowName: (name: string | null) => void
}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const [focused, setFocused] = useState(false)
  const name = i18n._(CUSTOM_NAME)
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={l({message: 'Custom', context: 'backdrop chip'})}
      accessibilityHint={
        selected ? '' : l`Sets your custom backdrop and opens its editor`
      }
      accessibilityState={{checked: selected}}
      onPress={onSelect}
      onHoverIn={() => onShowName(name)}
      onHoverOut={() => onShowName(null)}
      onFocus={e => {
        onShowName(name)
        setFocused(isKeyboardFocus(e))
      }}
      onBlur={() => {
        onShowName(null)
        setFocused(false)
      }}
      {...web({onKeyDown: swatchKeyDown(onSelect)})}
      style={[
        a.flex_row,
        a.align_center,
        {
          gap: 8,
          height: SWATCH_SIZE,
          minWidth: 108,
          paddingLeft: 12,
          paddingRight: 14,
          borderRadius: 14,
          borderWidth: 1,
        },
        selected
          ? [t.atoms.border_contrast_high, t.atoms.bg_contrast_25]
          : t.atoms.border_contrast_low,
      ]}>
      <View
        style={[
          a.overflow_hidden,
          {width: CHIP_DOT, height: CHIP_DOT, borderRadius: 7},
        ]}>
        <BackdropFill
          def={swatchDef(def, t.name)}
          theme={t.name}
          size={CHIP_DOT}
        />
      </View>
      <Text style={[a.text_xs, a.font_semi_bold]}>
        {l({message: 'Custom', context: 'backdrop chip'})}
      </Text>
      <Ring selected={selected} focused={focused} />
    </Pressable>
  )
}

function BackdropGroup() {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const state = useAppearanceState()
  const shown = effectiveAppearance(state, did)
  const committed = effectiveAppearance({...state, preview: null}, did)
  const [hoverName, setHoverName] = useState<string | null>(null)
  const sectionTitles: Record<PickerCollection, string> = {
    system: '',
    pride: l({message: 'Flags', context: 'backdrop group'}),
    materials: l({message: 'Materials', context: 'backdrop group'}),
    nature: l({message: 'Nature', context: 'backdrop group'}),
    skies: l({message: 'Skies', context: 'backdrop group'}),
    blobs: l({message: 'Color blobs', context: 'backdrop group'}),
  }

  const selectedId = committed.backdrop
  const isCustom = selectedId === BACKDROP_CUSTOM
  const known = registryDef(selectedId)
  const selectedName = isCustom
    ? i18n._(CUSTOM_NAME)
    : i18n._((known ?? BACKDROP_DEFS[0]).name)

  return (
    <SettingsList.Group iconInset={false}>
      <SettingsList.ItemIcon icon={PaintRollerIcon} />
      <SettingsList.ItemText>{l`Backdrops`}</SettingsList.ItemText>
      {hoverName !== null ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          {hoverName}
        </Text>
      ) : (
        <Text
          accessibilityLiveRegion="polite"
          style={[a.text_sm, t.atoms.text_contrast_medium]}>
          {selectedName}
        </Text>
      )}
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={l`Backdrop`}
        accessibilityHint=""
        style={[a.w_full, {gap: GAP, marginTop: GAP}]}>
        {PICKER_SECTIONS.map(section => (
          <View key={section.collection} style={[a.w_full, {gap: 6}]}>
            {section.collection !== 'system' && (
              <Text
                style={[
                  a.text_xs,
                  a.font_semi_bold,
                  t.atoms.text_contrast_medium,
                ]}>
                {sectionTitles[section.collection]}
              </Text>
            )}
            <View style={[a.w_full, a.flex_row, a.flex_wrap, {gap: GAP}]}>
              {section.defs.map(def => (
                <Swatch
                  key={def.id}
                  def={
                    def.id === BACKDROP_SKIES_AUTO
                      ? (resolveBackdrop({...shown, backdrop: def.id}) ?? def)
                      : def
                  }
                  name={i18n._(def.name)}
                  selected={def.id === selectedId}
                  onSelect={() => selectBackdrop(did, def.id)}
                  onShowName={setHoverName}
                />
              ))}
            </View>
          </View>
        ))}
        <View style={[a.w_full, a.flex_row, a.flex_wrap, {gap: GAP}]}>
          <CustomChip
            def={customDef(shown.custom)}
            selected={isCustom}
            onSelect={() => selectBackdrop(did, BACKDROP_CUSTOM)}
            onShowName={setHoverName}
          />
        </View>
      </View>
      {isCustom && (
        <CustomEditor
          key={`${committed.custom.mode}${committed.custom.a}${committed.custom.b}${committed.custom.pattern ?? ''}`}
          did={did}
          committed={committed.custom}
          presets={committed.presets}
        />
      )}
    </SettingsList.Group>
  )
}

function DeviceOptOutGroup() {
  const t = useTheme()
  const {t: l} = useLingui()
  const {device} = useAppearanceState()
  const label = l`Keep this device’s own appearance`
  return (
    <SettingsList.Item style={[a.flex_col, a.align_start, a.gap_xs]}>
      <Toggle.Item
        name="horizon_backdrop_device_only"
        label={label}
        value={device.optOut}
        onChange={setOptOut}
        style={[a.w_full]}>
        <Toggle.LabelText style={[a.flex_1]}>{label}</Toggle.LabelText>
        <Toggle.Platform />
      </Toggle.Item>
      <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
        {l`The backdrop, color mode, dark theme, font and font size set here stay on this device and are not saved to your account.`}
      </Text>
    </SettingsList.Item>
  )
}

/*
 * Film grain (change list 2, item 6): a static noise tile over the
 * backdrop, this device only, off by default. Web only: native draws no
 * grain.
 */
function GrainGroup() {
  const t = useTheme()
  const {t: l} = useLingui()
  const {device} = useAppearanceState()
  const label = l`Film grain`
  return (
    <SettingsList.Item style={[a.flex_col, a.align_start, a.gap_xs]}>
      <Toggle.Item
        name="horizon_backdrop_grain"
        label={label}
        value={device.grain}
        onChange={setGrain}
        style={[a.w_full]}>
        <Toggle.LabelText style={[a.flex_1]}>{label}</Toggle.LabelText>
        <Toggle.Platform />
      </Toggle.Item>
      <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
        {l`A fine grain over the backdrop that softens its gradients.`}
      </Text>
    </SettingsList.Item>
  )
}

/*
 * Backdrop softness (live fix batch 1): how much dim and dark calm the
 * backdrop, 0 (full colour) to 100, this device only. Applied as the slider
 * moves.
 */
function SoftnessGroup() {
  const t = useTheme()
  const {t: l} = useLingui()
  const {device} = useAppearanceState()
  return (
    <SettingsList.Group contentContainerStyle={[a.gap_sm]} iconInset={false}>
      <SettingsList.ItemIcon icon={MoonIcon} />
      <SettingsList.ItemText>{l`Backdrop softness`}</SettingsList.ItemText>
      <Text
        style={[
          a.w_full,
          a.text_sm,
          a.leading_snug,
          t.atoms.text_contrast_medium,
        ]}>
        {l`In dim and dark, calms the backdrop’s colors without darkening them. 0 shows them in full.`}
      </Text>
      <SoftnessSlider
        label={l({message: 'Dim', context: 'theme name'})}
        value={device.softness.dim}
        onChange={value => setBackdropSoftness('dim', value)}
      />
      <SoftnessSlider
        label={l({message: 'Dark', context: 'theme name'})}
        value={device.softness.dark}
        onChange={value => setBackdropSoftness('dark', value)}
      />
    </SettingsList.Group>
  )
}

/*
 * The phone frame picker (10.8, 9.3, 9.6, 9.7; live fix batch 1), this
 * device only, with one line under the title describing the selected
 * style, offered only below 800px or on a touch-first device (change list
 * item 3, `offersFrameStylePicker`), following resizes live; hiding it
 * keeps the saved style. `AppearanceToggleButtonGroup` comes from the stock
 * screen, which
 * imports this file: a circular import, safe because each side uses the
 * other only at render.
 */
function FrameStyleGroup() {
  const {gtMobile} = useBreakpoints()
  const coarsePointer = useCoarsePointer()
  if (!offersFrameStylePicker({gtMobile, coarsePointer})) return null
  return <FrameStylePicker />
}

function FrameStylePicker() {
  const {t: l} = useLingui()
  const {device} = useAppearanceState()
  const labels: Record<FrameStyle, string> = {
    bars: l({message: 'Bars', context: 'phone frame style'}),
    edges: l({message: 'Edges', context: 'phone frame style'}),
    gutter: l({message: 'Gutter', context: 'phone frame style'}),
    headerBand: l({message: 'Header', context: 'phone frame style'}),
  }
  const descriptions: Record<FrameStyle, string> = {
    bars: l`The top bar and the tab bar show the backdrop.`,
    edges: l`Plain bars with a thin strip of backdrop along their edges.`,
    gutter: l`Plain bars; the backdrop shows in a margin beside the posts.`,
    headerBand: l`The top bar shows the backdrop; the tab bar stays plain.`,
  }
  return (
    <AppearanceToggleButtonGroup
      title={l`Phone frame`}
      description={descriptions[device.frameStyle]}
      icon={PhoneIcon}
      items={FRAME_STYLES.map(name => ({label: labels[name], name}))}
      value={device.frameStyle}
      onChange={setFrameStyle}
    />
  )
}

/** The Appearance screen's Horizon sections. Nothing with `BACKDROPS` off. */
export function HorizonAppearanceSections() {
  const {hasSession} = useSession()
  if (!BACKDROPS) return null
  return (
    <Animated.View layout={native(LinearTransition)}>
      <SettingsList.Divider />
      <BackdropGroup />
      {hasSession && <DeviceOptOutGroup />}
      <SoftnessGroup />
      {IS_WEB && <GrainGroup />}
      {SHOW_FRAME_STYLE_PICKER && COMPACT_FRAME_WINDOWS && <FrameStyleGroup />}
    </Animated.View>
  )
}
