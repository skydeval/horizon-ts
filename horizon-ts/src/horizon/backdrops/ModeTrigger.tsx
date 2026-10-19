/*
 * The minimal-shell triggers of a compact window (Phase 3 design, 9.2): the
 * bottom bar's `footerMode` and the Home header's `headerMode` animate the
 * bars' transforms, and the bottom bar's slide on navigation is not driven
 * by scroll, so a window re-measures whenever either changes. Each trigger
 * is its own component that renders nothing, so a window can include the
 * Home header one only where its provider exists (`useHomeHeaderMode`
 * throws outside it) without a conditional hook call.
 */

import {type SharedValue, useAnimatedReaction} from 'react-native-reanimated'
import {scheduleOnRN} from 'react-native-worklets'

import {useMinimalShellMode} from '#/state/shell/minimal-mode'
import {useHomeHeaderMode} from '#/view/com/util/MainScrollProvider'

function ModeTrigger({
  mode,
  onChange,
}: {
  mode: SharedValue<number>
  onChange: () => void
}) {
  useAnimatedReaction(
    () => mode.get(),
    (value, previous) => {
      // The mount already measured; every later change re-measures.
      if (previous !== null && value !== previous) {
        scheduleOnRN(onChange)
      }
    },
  )
  return null
}

/** Calls `onChange` when the bottom bar's minimal-shell mode changes. */
export function FooterModeTrigger({onChange}: {onChange: () => void}) {
  const {footerMode} = useMinimalShellMode()
  return <ModeTrigger mode={footerMode} onChange={onChange} />
}

/** Calls `onChange` when the Home header's mode changes. Home header only. */
export function HomeHeaderModeTrigger({onChange}: {onChange: () => void}) {
  const headerMode = useHomeHeaderMode()
  return <ModeTrigger mode={headerMode} onChange={onChange} />
}
