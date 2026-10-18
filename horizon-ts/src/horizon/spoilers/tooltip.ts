import {IS_WEB} from '#/env'

/**
 * A ref callback that gives a spoiler control a native browser tooltip, so a
 * reader who does not know the Discord convention learns that the bar or the
 * arrow can be clicked. React Native Web does not forward a `title` prop, so
 * it is set on the element itself. Nothing happens on native, which has no
 * hover.
 */
export function spoilerTooltipRef(title: string) {
  return (node: unknown) => {
    if (!IS_WEB || !node) return
    const element = node as {
      setAttribute?: (name: string, value: string) => void
    }
    element.setAttribute?.('title', title)
  }
}
