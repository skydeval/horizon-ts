/*
 * One stock media cell under a media spoiler (2J design, 6.4). A flagged
 * item is drawn inside a wrapper whose own box is the only new one (the
 * stock children sit in a `display: contents` view, so their layout is
 * unchanged), with the cover as the wrapper's last child while covered.
 * The wrapper stays once the item is revealed, so the stock subtree never
 * remounts (no image reload, no video reset). An unflagged item, an item
 * outside a scope and every item with the switch off render the children
 * alone.
 *
 * While covered, the stock children are hidden from pointer, keyboard and
 * screen reader: `aria-hidden`, no pointer events, and on web the DOM
 * attribute `inert`, set through a ref because react-native-web does not
 * forward it. So the stock press (the lightbox) cannot run, and the alt text
 * is not announced.
 */

import {useEffect, useRef} from 'react'
import {type StyleProp, View, type ViewStyle} from 'react-native'

import {atoms as a} from '#/alf'
import {IS_WEB} from '#/env'
import {MediaSpoilerCover} from './MediaSpoilerCover'
import {
  type MediaSpoilerCellState,
  useMediaSpoilerCell,
} from './MediaSpoilerScope'

/** What focus moves to in a cell once its cover is gone (6.7). */
const FOCUS_AFTER_REVEAL = '[tabindex]:not([tabindex="-1"]), [role="button"]'

type DomNode = {
  setAttribute?: (name: string, value: string) => void
  removeAttribute?: (name: string) => void
  querySelector?: (selector: string) => {focus?: () => void} | null
}

/**
 * A ref callback that sets or removes the DOM `inert` attribute, on web.
 */
function inertRef(inert: boolean) {
  return (node: unknown) => {
    if (!IS_WEB || !node) return
    const element = node as DomNode
    if (inert) element.setAttribute?.('inert', '')
    else element.removeAttribute?.('inert')
  }
}

/**
 * Hooks MS 24 to MS 26 and MS 29 to MS 31. `thumb` draws the cover's
 * blurred copy (a video's thumbnail is optional); `kind` picks how the cell
 * finds its item (6.2). `rounded: false` for a cell whose corners its
 * container already clips (the 2-4 image grid).
 */
export function MediaSpoilerCell({
  thumb,
  kind = 'image',
  style,
  rounded = true,
  children,
}: {
  thumb: string | undefined
  kind?: 'image' | 'video'
  style?: StyleProp<ViewStyle>
  rounded?: boolean
  children: React.ReactNode
}) {
  const cell = useMediaSpoilerCell(thumb, kind)
  if (!cell.flagged) return <>{children}</>
  return (
    <FlaggedCell cell={cell} thumb={thumb} style={style} rounded={rounded}>
      {children}
    </FlaggedCell>
  )
}

function FlaggedCell({
  cell,
  thumb,
  style,
  rounded,
  children,
}: {
  cell: MediaSpoilerCellState
  thumb: string | undefined
  style?: StyleProp<ViewStyle>
  rounded: boolean
  children: React.ReactNode
}) {
  const wrapperRef = useRef<React.ComponentRef<typeof View>>(null)
  const focusAfterReveal = useRef(false)
  const {covered} = cell

  useEffect(() => {
    if (covered || !focusAfterReveal.current) return
    focusAfterReveal.current = false
    if (!IS_WEB) return
    const node = wrapperRef.current as unknown as DomNode | null
    node?.querySelector?.(FOCUS_AFTER_REVEAL)?.focus?.()
  }, [covered])

  return (
    <View ref={wrapperRef} style={[style, a.relative]}>
      <View
        ref={inertRef(covered)}
        style={{display: 'contents'}}
        aria-hidden={covered}
        pointerEvents={covered ? 'none' : 'auto'}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={covered}>
        {children}
      </View>
      {covered ? (
        <MediaSpoilerCover
          thumb={thumb}
          contentWarning={cell.contentWarning}
          label={cell.coverLabel}
          hint={cell.coverHint}
          rounded={rounded}
          onReveal={hadFocus => {
            focusAfterReveal.current = hadFocus
            cell.reveal()
          }}
        />
      ) : null}
    </View>
  )
}
