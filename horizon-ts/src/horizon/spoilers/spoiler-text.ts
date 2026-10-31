/*
 * The spoiler button on a plain-text editor (the native composer): the same
 * insert, wrap and unwrap as the web editor's command (`editor.ts`),
 * applied to the text and its selection.
 */

import {useEffect, useEffectEvent} from 'react'

import {textInputWebEmitter} from '#/view/com/composer/text-input/textInputWebEmitter'
import {SPOILER_TAGS} from '#/horizon/switches'
import {SPOILER_WRAP_EVENT, spoilerEditAction} from './spoiler-action'

export type TextSelection = {start: number; end: number}

/**
 * `text` after the spoiler button acts on `selection`, and the selection to
 * leave: inside the new markers, or where the removed ones were.
 */
export function spoilerWrapText(
  text: string,
  selection: TextSelection,
): {text: string; selection: TextSelection} {
  const s = Math.max(0, Math.min(selection.start, selection.end, text.length))
  const e = Math.min(
    text.length,
    Math.max(selection.start, selection.end, s),
  )
  const action = spoilerEditAction({
    empty: s === e,
    before: text.slice(Math.max(0, s - 2), s),
    after: text.slice(e, e + 2),
    selected: text.slice(s, e),
  })
  switch (action) {
    case 'insert':
      return {
        text: `${text.slice(0, s)}||||${text.slice(s)}`,
        selection: {start: s + 2, end: s + 2},
      }
    case 'wrap':
      return {
        text: `${text.slice(0, s)}||${text.slice(s, e)}||${text.slice(e)}`,
        selection: {start: s + 2, end: e + 2},
      }
    case 'unwrap':
      return {
        text: `${text.slice(0, s - 2)}${text.slice(s, e)}${text.slice(e + 2)}`,
        selection: {start: s - 2, end: e - 2},
      }
    case 'unwrapInner':
      return {
        text: `${text.slice(0, s)}${text.slice(s + 2, e - 2)}${text.slice(e)}`,
        selection: {start: s, end: e - 4},
      }
  }
}

/**
 * While this post's native editor is active and the switch is on, the
 * spoiler button's event rewrites its text with `spoilerWrapText`, then
 * moves the selection.
 */
export function useNativeSpoilerWrap({
  isActive,
  getText,
  getSelection,
  setText,
  setSelection,
}: {
  isActive: boolean
  getText: () => string
  getSelection: () => TextSelection
  setText: (text: string) => void
  setSelection: (selection: TextSelection) => void
}) {
  // Reads the latest text and callbacks; the listener is added once per activation
  const onWrap = useEffectEvent(() => {
    const next = spoilerWrapText(getText(), getSelection())
    setText(next.text)
    // After the new text is drawn, or the input moves the cursor back
    requestAnimationFrame(() => setSelection(next.selection))
  })
  useEffect(() => {
    if (!SPOILER_TAGS || !isActive) return
    const handler = () => onWrap()
    textInputWebEmitter.addListener(SPOILER_WRAP_EVENT, handler)
    return () => {
      textInputWebEmitter.removeListener(SPOILER_WRAP_EVENT, handler)
    }
  }, [isActive])
}
