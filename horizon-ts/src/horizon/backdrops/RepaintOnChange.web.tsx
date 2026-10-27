/*
 * A forced repaint of a frame piece on web. Firefox for Android left the
 * bottom bar's Notifications tab undrawn when its unread badge appeared or
 * changed, until a scroll moved the bar and it was drawn again (skydeval,
 * 2026-10-27; Chrome on the same phone was fine). A change to the bar's own
 * style makes the browser redraw the whole bar, as the scroll did.
 */

import {useEffect, useRef} from 'react'

/**
 * Nudges `node` so the browser redraws it and everything in it: an opacity
 * a hair under 1 for two frames, then back. Returns an undo.
 */
export function repaintElement(node: HTMLElement): () => void {
  const previous = node.style.getPropertyValue('opacity')
  node.style.setProperty('opacity', '0.999')
  let second = 0
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(() => {
      node.style.setProperty('opacity', previous)
    })
  })
  return () => {
    cancelAnimationFrame(first)
    cancelAnimationFrame(second)
    node.style.setProperty('opacity', previous)
  }
}

/**
 * Placed inside a frame piece, redraws that piece (its parent element)
 * whenever `value` changes after the first render, such as a badge count.
 */
export function RepaintOnChange({value}: {value: string}) {
  const ref = useRef<HTMLSpanElement>(null)
  const last = useRef(value)

  useEffect(() => {
    if (last.current === value) return
    last.current = value
    const piece = ref.current?.parentElement
    if (!piece) return
    return repaintElement(piece)
  }, [value])

  return <span ref={ref} aria-hidden style={{display: 'none'}} />
}
