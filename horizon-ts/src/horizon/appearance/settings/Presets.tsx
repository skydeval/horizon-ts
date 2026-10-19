/*
 * The ten preset slots and their "Hold to clear" chips (Phase 3 design,
 * 10.5): tap to load, long-press to save the editor's colours, hold to clear.
 * Web keys are taken in `onKeyDownCapture` (`keys.ts`) so RN-web's press
 * responder never starts a press or a long press from the keyboard.
 */

import {useEffect, useState} from 'react'
import {Pressable, View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {useHaptics} from '#/lib/haptics'
import {atoms as a, useTheme, web} from '#/alf'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {
  type CustomConfig,
  type Preset,
  type PresetSlots,
} from '#/horizon/appearance/model'
import {BackdropFill} from '#/horizon/appearance/settings/BackdropFill'
import {
  CLEAR_ARM_MS,
  clearKeyDownCapture,
  presetKeyDownCapture,
} from '#/horizon/appearance/settings/keys'
import {clearPreset, loadPreset, savePreset} from '#/horizon/appearance/store'
import {customDef} from '#/horizon/backdrops/registry'
import {swatchDef} from '#/horizon/backdrops/swatch'

const DOT = 16

function PresetChip({
  did,
  slot,
  preset,
  current,
  canSave,
}: {
  did: string | undefined
  slot: number
  preset: Preset | null
  current: CustomConfig
  canSave: boolean
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const haptics = useHaptics()
  const filled = preset !== null

  const load = () => {
    if (!filled) return
    loadPreset(did, slot)
    haptics.tap()
  }
  const save = () => {
    if (!canSave) return
    savePreset(did, slot, current)
    haptics.longPress()
    Toast.show(l`Saved to preset ${slot}`, {type: 'success'})
  }

  const text = preset?.name ?? (filled ? l`Preset ${slot}` : l`Empty ${slot}`)

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        filled ? l`Preset ${slot}, saved` : l`Preset ${slot}, empty`
      }
      accessibilityHint={l`Tap to load. Long-press to save the current color.`}
      accessibilityActions={[
        {name: 'activate'},
        {name: 'longpress', label: l`Save the current color here`},
      ]}
      onAccessibilityAction={e => {
        if (e.nativeEvent.actionName === 'longpress') save()
        else load()
      }}
      onPress={load}
      onLongPress={save}
      delayLongPress={500}
      {...web({onKeyDownCapture: presetKeyDownCapture({load, save})})}
      style={[
        a.flex_row,
        a.align_center,
        t.atoms.bg_contrast_25,
        {
          gap: 8,
          paddingVertical: 8,
          paddingHorizontal: 10,
          borderRadius: 12,
          borderWidth: 1,
          minWidth: 120,
        },
        filled ? t.atoms.border_contrast_high : t.atoms.border_contrast_low,
      ]}>
      <View
        style={[
          a.overflow_hidden,
          t.atoms.border_contrast_low,
          {width: DOT, height: DOT, borderRadius: 6, borderWidth: 1},
          !filled && t.atoms.bg_contrast_50,
        ]}>
        {preset && (
          <BackdropFill
            def={swatchDef(customDef(preset.custom), t.name)}
            theme={t.name}
            size={DOT}
          />
        )}
      </View>
      <Text emoji style={[a.text_xs, filled ? a.font_bold : a.font_semi_bold]}>
        {text}
      </Text>
    </Pressable>
  )
}

function ClearChip({did, slot}: {did: string | undefined; slot: number}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const haptics = useHaptics()
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), CLEAR_ARM_MS)
    return () => clearTimeout(timer)
  }, [armed])

  const clear = () => {
    setArmed(false)
    clearPreset(did, slot)
    haptics.longPress()
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={l`Clear preset ${slot}`}
      accessibilityHint={l`Press and hold to clear`}
      accessibilityActions={[{name: 'longpress', label: l`Clear`}]}
      onAccessibilityAction={e => {
        if (e.nativeEvent.actionName === 'longpress') clear()
      }}
      onLongPress={clear}
      delayLongPress={520}
      {...web({
        onKeyDownCapture: clearKeyDownCapture({
          armed,
          arm: () => setArmed(true),
          clear,
        }),
      })}
      style={[
        t.atoms.border_contrast_low,
        {
          paddingVertical: 6,
          paddingHorizontal: 10,
          borderRadius: 999,
          borderWidth: 1,
        },
      ]}>
      <Text style={[a.text_2xs, t.atoms.text_contrast_medium]}>
        {armed
          ? l`Press Enter again to clear ${slot}`
          : l`Hold to clear ${slot}`}
      </Text>
    </Pressable>
  )
}

/** The presets block of the Custom card. */
export function Presets({
  did,
  presets,
  current,
  canSave,
}: {
  did: string | undefined
  presets: PresetSlots
  /** The editor's colours, saved by a long press even if not applied. */
  current: CustomConfig
  /** False while a hex field is invalid. */
  canSave: boolean
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const filledSlots = presets
    .map((preset, i) => (preset ? i + 1 : 0))
    .filter(slot => slot > 0)
  return (
    <View style={[a.gap_sm]}>
      <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>
        {l`Presets (tap to load, long-press to save)`}
      </Text>
      <View style={[a.flex_row, a.flex_wrap, {gap: 8}]}>
        {presets.map((preset, i) => (
          <PresetChip
            key={i}
            did={did}
            slot={i + 1}
            preset={preset}
            current={current}
            canSave={canSave}
          />
        ))}
      </View>
      {filledSlots.length > 0 && (
        <View style={[a.flex_row, a.flex_wrap, {gap: 8}]}>
          {filledSlots.map(slot => (
            <ClearChip key={slot} did={did} slot={slot} />
          ))}
        </View>
      )}
    </View>
  )
}
