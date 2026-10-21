/*
 * The Custom editor's state (Phase 3 design, 10.4), as pure functions: per
 * colour one committed RGB and one hex draft, so the hex field and the
 * sliders stay in sync without effects (1.0 looped between them). Custom
 * stripes (change list 3, item 10) are a list of the same drafts, 2 to 8,
 * added, removed and moved by the functions below.
 */

import {
  type CustomConfig,
  isHex,
  STRIPES_MAX,
  STRIPES_MIN,
} from '#/horizon/appearance/model'
import {hexToRgb, type RGB, rgbToHex} from '#/horizon/backdrops/compile'
import {type PatternName} from '#/horizon/backdrops/types'

export type Channel = 'r' | 'g' | 'b'

export type ColorDraft = {rgb: RGB; hexDraft: string}

export type EditorState = {
  mode: CustomConfig['mode']
  a: ColorDraft
  b: ColorDraft
  /** The one-tone's pattern (change list 2, item 7); kept while two-tone. */
  pattern?: PatternName
  /**
   * The custom stripes, top to bottom; absent until the Stripes mode is
   * first chosen, then kept in every mode.
   */
  stripes?: ColorDraft[]
}

function draftOf(hex: string): ColorDraft {
  return {rgb: hexToRgb(hex), hexDraft: hex.toUpperCase()}
}

/** The editor for a committed configuration. */
export function initEditor(config: CustomConfig): EditorState {
  const state: EditorState = {
    mode: config.mode,
    a: draftOf(config.a),
    b: draftOf(config.b),
  }
  if (config.pattern) state.pattern = config.pattern
  if (config.stripes) state.stripes = config.stripes.map(draftOf)
  return state
}

/**
 * The mode changed. Stripes chosen for the first time start from the
 * two-tone's colours, top and bottom.
 */
export function setMode(
  state: EditorState,
  mode: CustomConfig['mode'],
): EditorState {
  if (mode === 'stripes' && !state.stripes) {
    return {...state, mode, stripes: [{...state.a}, {...state.b}]}
  }
  return {...state, mode}
}

/** Whether another stripe can be added (fewer than 8). */
export function canAddStripe(state: EditorState): boolean {
  return (state.stripes?.length ?? 0) < STRIPES_MAX
}

/** Whether a stripe can be removed (more than 2). */
export function canRemoveStripe(state: EditorState): boolean {
  return (state.stripes?.length ?? 0) > STRIPES_MIN
}

/**
 * A stripe added at the bottom, the bottom stripe's colour committed, so
 * the backdrop does not change until it is edited. Nothing at 8.
 */
export function addStripe(state: EditorState): EditorState {
  const stripes = state.stripes
  if (!stripes || !canAddStripe(state)) return state
  const last = stripes[stripes.length - 1]
  return {
    ...state,
    stripes: [...stripes, {rgb: {...last.rgb}, hexDraft: rgbToHex(last.rgb)}],
  }
}

/** Stripe `index` removed. Nothing at 2 or for an index out of range. */
export function removeStripe(state: EditorState, index: number): EditorState {
  const stripes = state.stripes
  if (!stripes || !canRemoveStripe(state)) return state
  if (index < 0 || index >= stripes.length) return state
  return {...state, stripes: stripes.filter((_s, i) => i !== index)}
}

/**
 * Stripe `index` moved by `by` places (negative is up), clamped to the
 * ends; the same state when it cannot move.
 */
export function moveStripe(
  state: EditorState,
  index: number,
  by: number,
): EditorState {
  const stripes = state.stripes
  if (!stripes || index < 0 || index >= stripes.length) return state
  const to = Math.max(0, Math.min(stripes.length - 1, index + by))
  if (to === index) return state
  const next = [...stripes]
  const [moved] = next.splice(index, 1)
  next.splice(to, 0, moved)
  return {...state, stripes: next}
}

/** Stripe `index`'s draft replaced. */
export function setStripe(
  state: EditorState,
  index: number,
  draft: ColorDraft,
): EditorState {
  const stripes = state.stripes
  if (!stripes || index < 0 || index >= stripes.length) return state
  return {
    ...state,
    stripes: stripes.map((s, i) => (i === index ? draft : s)),
  }
}

function withHash(text: string) {
  const trimmed = text.trim()
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

/** A slider moved: the RGB and the hex follow. */
export function onSlider(
  draft: ColorDraft,
  channel: Channel,
  value: number,
): ColorDraft {
  const v = Math.max(0, Math.min(255, Math.round(value)))
  const rgb = {...draft.rgb, [channel]: v}
  return {rgb, hexDraft: rgbToHex(rgb)}
}

/** The hex field changed: the RGB follows once the text is a colour. */
export function onHexChange(draft: ColorDraft, text: string): ColorDraft {
  const hex = withHash(text)
  return isHex(hex)
    ? {rgb: hexToRgb(hex), hexDraft: text}
    : {rgb: draft.rgb, hexDraft: text}
}

/** The hex field lost focus: it shows the committed colour again. */
export function onHexBlur(draft: ColorDraft): ColorDraft {
  return {rgb: draft.rgb, hexDraft: rgbToHex(draft.rgb)}
}

/** Whether a draft's text is a colour. */
export function isDraftValid(draft: ColorDraft): boolean {
  return isHex(withHash(draft.hexDraft))
}

/**
 * Whether every shown field is valid (Solid shows one colour, Stripes its
 * stripes).
 */
export function isEditorValid(state: EditorState): boolean {
  if (state.mode === 'stripes') {
    return (state.stripes ?? []).every(isDraftValid)
  }
  return (
    isDraftValid(state.a) && (state.mode === 'solid' || isDraftValid(state.b))
  )
}

/**
 * The configuration the editor shows. `b` is kept while solid, the stripes
 * in every mode once made.
 */
export function editorConfig(state: EditorState): CustomConfig {
  const config: CustomConfig = {
    mode: state.mode,
    a: rgbToHex(state.a.rgb),
    b: rgbToHex(state.b.rgb),
  }
  if (state.pattern) config.pattern = state.pattern
  if (state.stripes) config.stripes = state.stripes.map(s => rgbToHex(s.rgb))
  return config
}

/** Whether two configurations are the same, pattern and stripes included. */
export function sameConfig(x: CustomConfig, y: CustomConfig): boolean {
  return (
    x.mode === y.mode &&
    x.a === y.a &&
    x.b === y.b &&
    (x.pattern ?? null) === (y.pattern ?? null) &&
    (x.stripes ?? []).join(',') === (y.stripes ?? []).join(',')
  )
}
