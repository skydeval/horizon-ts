/*
 * Shared accessibility bits for the member editor's pickers (Phase 5
 * design 6.5): a visible focus ring for keyboard users on web, and the 44 px
 * minimum hit target.
 */

import {web} from '#/alf'

/** The smallest side of a touch or click target. */
export const MIN_TARGET = 44

/**
 * A 2 px outline around a focused control on web. Native has its own focus
 * indicators (VoiceOver and TalkBack draw them), so this is web only.
 */
export function focusRing(color: string, focused: boolean) {
  return focused
    ? web({
        outlineStyle: 'solid',
        outlineWidth: 2,
        outlineColor: color,
        outlineOffset: 2,
      })
    : undefined
}

/**
 * What a key does in a radio group (the WAI-ARIA radio group pattern): the
 * index to move selection and focus to, wrapping at the ends; `'select'` to
 * check the focused radio; or null when the key is not the group's.
 */
export function radioGroupKey(
  key: string,
  index: number,
  count: number,
): number | 'select' | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    case ' ':
    case 'Spacebar':
      return 'select'
    default:
      return null
  }
}
