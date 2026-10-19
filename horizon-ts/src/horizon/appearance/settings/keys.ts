/*
 * Web keyboard paths of the Backdrops group (Phase 3 design, 10.2 and
 * 10.5), as pure handlers. RN-web's press responder treats Shift+Enter as
 * Enter and runs its long-press timer while a key is held, so the preset and
 * clear chips take their keys in `onKeyDownCapture`, before the responder.
 */

export type KeyEventLike = {
  key: string
  shiftKey?: boolean
  repeat?: boolean
  preventDefault: () => void
  stopPropagation: () => void
}

/** A swatch's `onKeyDown`: Space selects (RN-web presses a radio on Enter only). */
export function swatchKeyDown(select: () => void) {
  return (e: KeyEventLike) => {
    if (e.key !== ' ') return
    e.preventDefault()
    select()
  }
}

/**
 * A preset chip's `onKeyDownCapture`: Enter or Space loads, Shift+Enter
 * saves, a repeated key does nothing; none of them reaches the responder.
 */
export function presetKeyDownCapture({
  load,
  save,
}: {
  load: () => void
  save: () => void
}) {
  return (e: KeyEventLike) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    if (e.key === 'Enter' && e.shiftKey) save()
    else load()
  }
}

/** How long an armed "Hold to clear" chip waits for the second Enter. */
export const CLEAR_ARM_MS = 2000

/**
 * A "Hold to clear" chip's `onKeyDownCapture`: Enter arms the chip, a second
 * Enter while armed clears; Space and held keys do nothing; none of them
 * reaches the responder (whose long press would clear at once).
 */
export function clearKeyDownCapture({
  armed,
  arm,
  clear,
}: {
  armed: boolean
  arm: () => void
  clear: () => void
}) {
  return (e: KeyEventLike) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat || e.key !== 'Enter') return
    if (armed) clear()
    else arm()
  }
}

/**
 * A range input's `onKeyDown`: Page Up and Page Down step by `page` (16 for
 * the colour sliders, 0 to 255), clamped to 0 and `max`.
 */
export function rangeKeyDown(
  value: number,
  onChange: (next: number) => void,
  {page = 16, max = 255}: {page?: number; max?: number} = {},
) {
  return (e: KeyEventLike) => {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return
    e.preventDefault()
    const next = value + (e.key === 'PageUp' ? page : -page)
    onChange(Math.max(0, Math.min(max, next)))
  }
}
