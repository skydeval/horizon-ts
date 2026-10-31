/*
 * What the composer's spoiler button does (spoilers design, 7.2), shared by
 * the web editor (`editor.ts`) and the native one (`spoiler-text.ts`).
 */

/**
 * The editor event the spoiler button emits, as the emoji picker emits its
 * own.
 */
export const SPOILER_WRAP_EVENT = 'horizon-spoiler-wrap'

export type SpoilerEditAction = 'insert' | 'wrap' | 'unwrap' | 'unwrapInner'

/**
 * What the button does for a selection, from the two characters on each
 * side of it and the selected text.
 */
export function spoilerEditAction({
  empty,
  before,
  after,
  selected,
}: {
  empty: boolean
  before: string
  after: string
  selected: string
}): SpoilerEditAction {
  if (empty) return 'insert'
  if (before === '||' && after === '||') return 'unwrap'
  if (
    selected.length > 4 &&
    selected.startsWith('||') &&
    selected.endsWith('||')
  ) {
    return 'unwrapInner'
  }
  return 'wrap'
}
