/*
 * The Custom editor's state (Phase 3 design, 10.4), as pure functions: per
 * colour one committed RGB and one hex draft, so the hex field and the
 * sliders stay in sync without effects (1.0 looped between them).
 */

import {type CustomConfig, isHex} from '#/horizon/appearance/model'
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
  return state
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

/** Whether every shown field is valid (Solid shows one colour). */
export function isEditorValid(state: EditorState): boolean {
  return (
    isDraftValid(state.a) && (state.mode === 'solid' || isDraftValid(state.b))
  )
}

/** The configuration the editor shows. `b` is kept while solid. */
export function editorConfig(state: EditorState): CustomConfig {
  const config: CustomConfig = {
    mode: state.mode,
    a: rgbToHex(state.a.rgb),
    b: rgbToHex(state.b.rgb),
  }
  if (state.pattern) config.pattern = state.pattern
  return config
}

/** Whether two configurations are the same, pattern included. */
export function sameConfig(x: CustomConfig, y: CustomConfig): boolean {
  return (
    x.mode === y.mode &&
    x.a === y.a &&
    x.b === y.b &&
    (x.pattern ?? null) === (y.pattern ?? null)
  )
}
