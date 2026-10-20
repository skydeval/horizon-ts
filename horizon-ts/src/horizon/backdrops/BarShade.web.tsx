/*
 * Bar shades on web (the Bars frame, batch A; Header's top bars, round 2
 * list): a small soft oblong of the theme's tint under each thing written
 * on a bare window (`frame.ts`, "Bar shades"). A raw `div` at
 * `z-index: -1`, first in its item, so it paints over the window and under
 * the item's icon or text. Its colour is the custom property the bare window sets on its
 * piece, so outside one it draws nothing. The soft edge is a mask of two
 * linear ramps, across and down: a solid middle whose ends and corners
 * fade out (`fadeX`, `fadeY`), painted once with the bar and moved with it.
 */

import {
  Children,
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react'
import {type StyleProp, StyleSheet, type TextStyle} from 'react-native'

import {useBreakpoints} from '#/alf'
import {useDialogContext} from '#/components/Dialog/context'
import {useAppearanceState} from '#/horizon/appearance/store'
import {useActiveBackdrop} from '#/horizon/backdrops/active'
import {
  barShadesOn,
  SHADE_SHAPES,
  type ShadeKind,
  shadeVar,
  TEXT_SHADE_PADDING,
} from '#/horizon/backdrops/frame'

/** Whether a shade of `kind` is rendered here. */
function useShadesOn(kind: ShadeKind): boolean {
  const def = useActiveBackdrop()
  const {device} = useAppearanceState()
  const {gtMobile} = useBreakpoints()
  const {isWithinDialog} = useDialogContext()
  return barShadesOn({
    def,
    frameStyle: device.frameStyle,
    kind,
    gtMobile,
    isWithinDialog,
  })
}

function ramp(direction: 'right' | 'bottom', fade: number) {
  return `linear-gradient(to ${direction}, transparent 0px, #000 ${fade}px, #000 calc(100% - ${fade}px), transparent 100%)`
}

/** The paint of a shade of `kind`, without its box. */
export function shadePaint(kind: ShadeKind): React.CSSProperties {
  const {fadeX, fadeY} = SHADE_SHAPES[kind]
  const mask = `${ramp('right', fadeX)}, ${ramp('bottom', fadeY)}`
  return {
    position: 'absolute',
    zIndex: -1,
    pointerEvents: 'none',
    backgroundColor: `var(${shadeVar(kind)}, transparent)`,
    WebkitMaskImage: mask,
    WebkitMaskComposite: 'source-in',
    maskImage: mask,
    maskComposite: 'intersect',
  }
}

function shadeBox(kind: ShadeKind): React.CSSProperties {
  const {fadeX: _fadeX, fadeY: _fadeY, ...box} = SHADE_SHAPES[kind]
  return box
}

/*
 * A Home feed tab's label sits in a box that clips (`overflowX: hidden`),
 * so its shade sits one level up, in the tab, and follows the label's size
 * and place with a ResizeObserver (read after layout, so no forced layout).
 */
function LabelShade() {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const shade = ref.current
    const inner = shade?.nextElementSibling
    const label = inner?.firstElementChild
    const item = shade?.parentElement
    if (
      !shade ||
      !(inner instanceof HTMLElement) ||
      !(label instanceof HTMLElement) ||
      !item ||
      typeof ResizeObserver === 'undefined'
    ) {
      return
    }
    const {horizontal, vertical} = TEXT_SHADE_PADDING
    const observer = new ResizeObserver(() => {
      // The label's content box: its line, without the indicator's padding.
      const padding = getComputedStyle(label)
      const width =
        label.clientWidth -
        (parseFloat(padding.paddingLeft) || 0) -
        (parseFloat(padding.paddingRight) || 0)
      const height =
        label.clientHeight -
        (parseFloat(padding.paddingTop) || 0) -
        (parseFloat(padding.paddingBottom) || 0)
      shade.style.left = `${inner.offsetLeft + label.offsetLeft - horizontal}px`
      shade.style.top = `${inner.offsetTop + label.offsetTop - vertical}px`
      shade.style.width = `${width + 2 * horizontal}px`
      shade.style.height = `${height + 2 * vertical}px`
    })
    observer.observe(label)
    observer.observe(item)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      aria-hidden
      style={{...shadePaint('label'), ...shadeBox('label')}}
    />
  )
}

/**
 * A shade under the item it is placed in (first inside it). `show` false
 * renders nothing. `label` follows the Home feed tab label that comes
 * after it.
 */
export function BarShade({
  kind,
  show = true,
}: {
  kind: ShadeKind
  show?: boolean
}) {
  const on = useShadesOn(kind)
  if (!show || !on) return null
  if (kind === 'label') return <LabelShade />
  return <div aria-hidden style={{...shadePaint(kind), ...shadeBox(kind)}} />
}

const InSlot = createContext(false)

/**
 * A header slot's shade, around the slot's children. Nothing for an empty
 * slot (a spacer), and nothing for a slot inside another (the Home
 * header's menu button), so a shade is never doubled. Inactive, the
 * children only.
 */
export function BarSlot({children}: {children?: React.ReactNode}) {
  const nested = useContext(InSlot)
  const on = useShadesOn('button')
  if (!on || nested || Children.toArray(children).length === 0) {
    return <>{children}</>
  }
  return (
    <InSlot.Provider value>
      <div
        aria-hidden
        style={{...shadePaint('button'), ...shadeBox('button')}}
      />
      {children}
    </InSlot.Provider>
  )
}

/**
 * The style a header title or subtitle takes for its shade: its box hugs
 * the text (aligned as the text is) and reaches `TEXT_SHADE_PADDING` past
 * it, the negative margins keeping the text where it was. Undefined when
 * no shade is drawn.
 */
export function useBarTextShade(
  kind: 'title' | 'subtitle',
  style?: StyleProp<TextStyle>,
): TextStyle | undefined {
  const on = useShadesOn(kind)
  if (!on) return undefined
  const align = StyleSheet.flatten(style)?.textAlign
  const {horizontal, vertical} = TEXT_SHADE_PADDING
  return {
    alignSelf:
      align === 'center'
        ? 'center'
        : align === 'right'
          ? 'flex-end'
          : 'flex-start',
    paddingLeft: horizontal,
    paddingRight: horizontal,
    marginLeft: -horizontal,
    marginRight: -horizontal,
    paddingTop: vertical,
    paddingBottom: vertical,
    marginTop: -vertical,
    marginBottom: -vertical,
  }
}
