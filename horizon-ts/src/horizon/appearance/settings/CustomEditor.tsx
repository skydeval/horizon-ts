/*
 * The Custom Backdrop Color card (Phase 3 design, 10.4): Solid, Two-tone
 * or Stripes (change list 3), each colour with a hex field, a swatch and R,
 * G and B sliders, a quiet pattern for Solid (change list 2), Apply, and
 * the presets. Stripes shows its 2 to 8 colours as a row of chips, top
 * first; the chosen one is edited below, moved up or down, or removed, and
 * "Add stripe" adds one at the bottom. The editor is keyed by its parent on
 * the committed colours, so a preset load or a fresh record resets it. The backdrop follows the
 * editor through the store's preview, 150 ms after the last change; the
 * preview is cleared on Apply and when the editor unmounts.
 */

import {useEffect, useState} from 'react'
import {Pressable, View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {useHaptics} from '#/lib/haptics'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import * as TextField from '#/components/forms/TextField'
import {Text} from '#/components/Typography'
import {
  type CustomConfig,
  type CustomMode,
  PATTERN_NAMES,
  type PresetSlots,
} from '#/horizon/appearance/model'
import {
  addStripe,
  canAddStripe,
  canRemoveStripe,
  type Channel,
  type ColorDraft,
  editorConfig,
  type EditorState,
  initEditor,
  isDraftValid,
  isEditorValid,
  moveStripe,
  onHexBlur,
  onHexChange,
  onSlider,
  removeStripe,
  sameConfig,
  setMode,
  setStripe,
} from '#/horizon/appearance/settings/editor'
import {Presets} from '#/horizon/appearance/settings/Presets'
import {RgbSlider} from '#/horizon/appearance/settings/RgbSlider'
import {applyCustom, setAppearancePreview} from '#/horizon/appearance/store'
import {rgbToHex} from '#/horizon/backdrops/compile'
import {type PatternName} from '#/horizon/backdrops/types'

/** The preview's debounce after the last change. */
export const PREVIEW_DELAY_MS = 150

const CHANNELS: Channel[] = ['r', 'g', 'b']

function ColorColumn({
  label,
  draft,
  onChange,
}: {
  label: string
  draft: ColorDraft
  onChange: (next: ColorDraft) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const hex = rgbToHex(draft.rgb)
  return (
    <View style={[a.gap_sm, {minWidth: 140, flexGrow: 1, flexBasis: 0}]}>
      <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>{label}</Text>
      <View style={[a.flex_row, a.align_center, a.gap_sm]}>
        <View style={[a.flex_1]}>
          <TextField.Root isInvalid={!isDraftValid(draft)}>
            <TextField.Input
              label={l({
                message: `${label} hex color`,
                comment:
                  'Label of a hex colour field: the colour column, then "hex color"',
              })}
              placeholder="#FFE2FF"
              value={draft.hexDraft}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={7}
              onChangeText={text => onChange(onHexChange(draft, text))}
              onBlur={() => onChange(onHexBlur(draft))}
            />
          </TextField.Root>
        </View>
        <View
          accessibilityRole="image"
          accessibilityLabel={l({
            message: `${label} color ${hex}`,
            comment:
              'The swatch of a custom backdrop colour: the column, then the colour',
          })}
          accessibilityHint=""
          style={[
            t.atoms.border_contrast_low,
            {
              width: 36,
              height: 36,
              borderRadius: 10,
              borderWidth: 1,
              backgroundColor: hex,
            },
          ]}
        />
      </View>
      {CHANNELS.map(channel => (
        <RgbSlider
          key={channel}
          channel={channel}
          column={label}
          value={draft.rgb[channel]}
          onChange={value => onChange(onSlider(draft, channel, value))}
        />
      ))}
    </View>
  )
}

/*
 * The one-tone's quiet pattern (change list 2, item 7): none, dots, a grid
 * or diagonal lines, drawn faintly over the colour. Previewed and applied
 * with the colour.
 */
function PatternPicker({
  value,
  onChange,
}: {
  value: PatternName | undefined
  onChange: (next: PatternName | undefined) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const labels: Record<PatternName | 'none', string> = {
    none: l({message: 'None', context: 'backdrop pattern'}),
    dots: l({message: 'Dots', context: 'backdrop pattern'}),
    grid: l({message: 'Grid', context: 'backdrop pattern'}),
    lines: l({message: 'Lines', context: 'backdrop pattern'}),
  }
  const options: (PatternName | 'none')[] = ['none', ...PATTERN_NAMES]
  return (
    <View style={[a.gap_xs]}>
      <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>
        {l({message: 'Pattern', context: 'custom backdrop pattern'})}
      </Text>
      <SegmentedControl.Root
        type="radio"
        label={l`Custom backdrop pattern`}
        value={value ?? 'none'}
        onChange={next => onChange(next === 'none' ? undefined : next)}>
        {options.map(option => (
          <SegmentedControl.Item
            key={option}
            value={option}
            label={labels[option]}>
            <SegmentedControl.ItemText>
              {labels[option]}
            </SegmentedControl.ItemText>
          </SegmentedControl.Item>
        ))}
      </SegmentedControl.Root>
    </View>
  )
}

/*
 * The custom stripes (change list 3, item 10): a chip per stripe, top
 * first, the chosen one's colour column, and buttons to move it, remove it
 * (not below 2) or add one (not above 8).
 */
function StripesEditor({
  state,
  onChange,
}: {
  state: EditorState
  onChange: (update: (s: EditorState) => EditorState) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const [chosen, setChosen] = useState(0)
  const stripes = state.stripes ?? []
  const index = Math.min(chosen, stripes.length - 1)
  const draft = stripes[index]
  if (!draft) return null
  const move = (by: number) => {
    onChange(s => moveStripe(s, index, by))
    setChosen(Math.max(0, Math.min(stripes.length - 1, index + by)))
  }
  return (
    <View style={[a.gap_sm]}>
      <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>
        {l`Stripes, top to bottom`}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={l`Custom stripes`}
        accessibilityHint=""
        style={[a.flex_row, a.flex_wrap, {gap: 8}]}>
        {stripes.map((stripe, i) => {
          const hex = rgbToHex(stripe.rgb)
          const selected = i === index
          return (
            <Pressable
              key={i}
              accessibilityRole="radio"
              accessibilityLabel={l`Stripe ${i + 1}, ${hex}`}
              accessibilityHint={selected ? '' : l`Edits this stripe`}
              accessibilityState={{checked: selected}}
              onPress={() => setChosen(i)}
              style={[
                {
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  borderWidth: selected ? 2 : 1,
                  backgroundColor: hex,
                },
                selected
                  ? {borderColor: t.atoms.text.color}
                  : t.atoms.border_contrast_low,
              ]}
            />
          )
        })}
      </View>
      {/*
       * In a row, as the other modes' columns are: the column shares a
       * row's width (`flexBasis: 0`), which in a column collapsed its height
       * and drew the buttons over it (live check, 2026-10-21).
       */}
      <View style={[a.flex_row]}>
        <ColorColumn
          label={l`Stripe ${index + 1}`}
          draft={draft}
          onChange={next => onChange(s => setStripe(s, index, next))}
        />
      </View>
      <View style={[a.flex_row, a.flex_wrap, {gap: 8}]}>
        <Button
          label={l`Move stripe ${index + 1} up`}
          color="secondary"
          size="small"
          disabled={index === 0}
          onPress={() => move(-1)}>
          <ButtonText>
            {l({message: 'Up', context: 'move a stripe'})}
          </ButtonText>
        </Button>
        <Button
          label={l`Move stripe ${index + 1} down`}
          color="secondary"
          size="small"
          disabled={index === stripes.length - 1}
          onPress={() => move(1)}>
          <ButtonText>
            {l({message: 'Down', context: 'move a stripe'})}
          </ButtonText>
        </Button>
        <Button
          label={l`Remove stripe ${index + 1}`}
          color="secondary"
          size="small"
          disabled={!canRemoveStripe(state)}
          onPress={() => {
            onChange(s => removeStripe(s, index))
            setChosen(Math.max(0, index - 1))
          }}>
          <ButtonText>
            {l({message: 'Remove', context: 'remove a stripe'})}
          </ButtonText>
        </Button>
        <Button
          label={l`Add stripe`}
          color="secondary"
          size="small"
          disabled={!canAddStripe(state)}
          onPress={() => {
            onChange(addStripe)
            setChosen(stripes.length)
          }}>
          <ButtonText>{l`Add stripe`}</ButtonText>
        </Button>
      </View>
    </View>
  )
}

/** The card. Mount it keyed on the committed colours. */
export function CustomEditor({
  did,
  committed,
  presets,
}: {
  did: string | undefined
  committed: CustomConfig
  presets: PresetSlots
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const haptics = useHaptics()
  const [state, setState] = useState<EditorState>(() => initEditor(committed))
  const config = editorConfig(state)
  const valid = isEditorValid(state)

  const {mode, a: colorA, b: colorB, pattern} = config
  // The stripes as one string, so the effect sees a value, not a new array.
  const stripesKey = config.stripes?.join(',') ?? ''
  const unchanged = sameConfig(config, committed)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (unchanged) {
        setAppearancePreview(null)
        return
      }
      const preview: CustomConfig = {mode, a: colorA, b: colorB}
      if (pattern) preview.pattern = pattern
      if (stripesKey) preview.stripes = stripesKey.split(',')
      setAppearancePreview(preview)
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [mode, colorA, colorB, pattern, stripesKey, unchanged])

  useEffect(() => () => setAppearancePreview(null), [])

  const apply = () => {
    if (!valid) return
    applyCustom(did, config)
    setAppearancePreview(null)
    haptics.confirm()
  }

  const columns: {key: 'a' | 'b'; label: string}[] =
    state.mode === 'solid'
      ? [
          {
            key: 'a',
            label: l({message: 'Color', context: 'custom backdrop colour'}),
          },
        ]
      : [
          {key: 'a', label: l`Top Left`},
          {key: 'b', label: l`Bottom Right`},
        ]

  return (
    <View
      style={[
        a.w_full,
        t.atoms.border_contrast_low,
        {marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1, gap: 10},
      ]}>
      <Text style={[a.text_sm, a.font_semi_bold]}>
        {l`Custom Backdrop Color`}
      </Text>
      <SegmentedControl.Root
        type="radio"
        label={l`Custom backdrop type`}
        value={state.mode}
        onChange={(next: CustomMode) => setState(s => setMode(s, next))}>
        <SegmentedControl.Item value="solid" label={l`Solid`}>
          <SegmentedControl.ItemText>{l`Solid`}</SegmentedControl.ItemText>
        </SegmentedControl.Item>
        <SegmentedControl.Item value="twoTone" label={l`Two-tone`}>
          <SegmentedControl.ItemText>{l`Two-tone`}</SegmentedControl.ItemText>
        </SegmentedControl.Item>
        <SegmentedControl.Item
          value="stripes"
          label={l({message: 'Stripes', context: 'custom backdrop type'})}>
          <SegmentedControl.ItemText>
            {l({message: 'Stripes', context: 'custom backdrop type'})}
          </SegmentedControl.ItemText>
        </SegmentedControl.Item>
      </SegmentedControl.Root>
      {state.mode === 'stripes' ? (
        <StripesEditor state={state} onChange={setState} />
      ) : (
        <View style={[a.flex_row, a.flex_wrap, {gap: 10}]}>
          {columns.map(column => (
            <ColorColumn
              key={column.key}
              label={column.label}
              draft={state[column.key]}
              onChange={next => setState(s => ({...s, [column.key]: next}))}
            />
          ))}
        </View>
      )}
      {state.mode === 'solid' && (
        <PatternPicker
          value={state.pattern}
          onChange={next => setState(s => ({...s, pattern: next}))}
        />
      )}
      <View style={[a.flex_row]}>
        <Button
          label={l`Apply`}
          color="secondary"
          size="small"
          disabled={!valid}
          onPress={apply}>
          <ButtonText>{l`Apply`}</ButtonText>
        </Button>
      </View>
      <Presets did={did} presets={presets} current={config} canSave={valid} />
    </View>
  )
}
