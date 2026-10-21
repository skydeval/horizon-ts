/*
 * A hover hint on a composer toolbar button, on web (change list 2, item
 * 1): the stock tooltip bubble above the button, shown while a mouse rests
 * on it for `HINT_DELAY_MS`, hidden when it leaves or presses. Touch and pen
 * never show it (their tap is the action). The bubble never takes focus, so
 * hovering a button leaves the editor's cursor where it was, and a press
 * that would open the bubble is ignored: only the hover shows it.
 */

import {useEffect, useRef, useState} from 'react'
import {View} from 'react-native'

import * as Tooltip from '#/components/Tooltip'

/** How long the pointer rests on a button before its hint shows. */
export const HINT_DELAY_MS = 500

/** Wraps a toolbar button with its hint. */
export function ToolbarHint({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const hide = () => {
    cancel()
    setVisible(false)
  }

  useEffect(() => cancel, [])

  return (
    <Tooltip.Outer
      visible={visible}
      onVisibleChange={next => {
        if (!next) hide()
      }}
      position="top"
      takesFocus={false}>
      <Tooltip.Target>
        <View
          testID="composerToolbarHintTarget"
          onPointerEnter={e => {
            if (e.nativeEvent.pointerType !== 'mouse') return
            cancel()
            timer.current = setTimeout(() => {
              timer.current = null
              setVisible(true)
            }, HINT_DELAY_MS)
          }}
          onPointerLeave={hide}
          onPointerDown={hide}>
          {children}
        </View>
      </Tooltip.Target>
      <Tooltip.BubbleText label={label}>{label}</Tooltip.BubbleText>
    </Tooltip.Outer>
  )
}
