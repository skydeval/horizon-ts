/*
 * Windowing for the web List (`view/com/util/List.web.tsx`). Bluesky's web
 * list keeps every loaded row mounted, so a long scroll grows memory until
 * the tab runs out. Here a row more than WINDOW_SCREENS screens from the
 * visible area renders as an empty box of its last measured height, and
 * mounts again before it comes back into view.
 *
 * The row's own element stays in place, so the scroll height, the row
 * registry used by scrollToIndex and the "seen" observer are unchanged.
 */

import {useEffect, useRef, useState} from 'react'

import {WEB_LIST_WINDOWING} from '#/horizon/switches'

/** How many screens above and below the visible area stay mounted. */
export const WINDOW_SCREENS = 4

/**
 * How long a row that mounts again keeps at least its old height, while
 * its images load back in. Without it the row first renders shorter, then
 * grows, which moves the page in browsers without scroll anchoring.
 */
export const SETTLE_MS = 1500

const MARGIN = `${WINDOW_SCREENS * 100}%`

export type RowWindow = {
  /** True while the row is far away and renders nothing. */
  held: boolean
  /**
   * The height to keep: exact while held, a minimum while settling, and
   * `undefined` otherwise.
   */
  height: number | undefined
}

const OPEN: RowWindow = {held: false, height: undefined}

/**
 * Whether a far-away row is held, and the height to keep it at.
 *
 * A row is never held while it holds keyboard focus, or while its list is
 * in a hidden tab (it measures 0 then), so switching tabs keeps each feed
 * as it was.
 */
export function useRowWindow(
  rowRef: React.RefObject<HTMLElement | null>,
  root: React.RefObject<HTMLElement | null> | null | undefined,
): RowWindow {
  const [state, setState] = useState<RowWindow>(OPEN)
  const current = useRef<RowWindow>(OPEN)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const apply = (next: RowWindow) => {
      current.current = next
      setState(next)
    }
    const row = rowRef.current
    if (
      !WEB_LIST_WINDOWING ||
      !row ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          clearTimeout(settle.current)
          if (entry.isIntersecting) {
            if (!current.current.held) continue
            apply({held: false, height: current.current.height})
            settle.current = setTimeout(() => apply(OPEN), SETTLE_MS)
            continue
          }
          const height = entry.boundingClientRect.height
          if (height <= 0) continue
          const focused = globalThis.document?.activeElement
          if (focused && row.contains(focused)) continue
          apply({held: true, height})
        }
      },
      {root: root?.current ?? null, rootMargin: `${MARGIN} 0px ${MARGIN} 0px`},
    )
    observer.observe(row)
    return () => {
      observer.disconnect()
      clearTimeout(settle.current)
    }
  }, [rowRef, root])

  return state
}
