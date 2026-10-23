/*
 * The catching-up note (prism busy design 10, decision 1): one quiet line
 * telling a member that some private posts may take a moment to appear,
 * worded so it never implies loss. Not a toast, banner or modal.
 *
 * Shown at once on a surface whose load the gate trimmed (its `hidden` > 0)
 * while a health cause is set (4.1); never on a launch gated only because
 * nothing has answered yet (no cause), never for a non-member. It clears with
 * the next ungated load (`hidden` back to 0) or 2 s after the account turns
 * healthy. The 20 s note on the Private tab, the notification tabs, Saved and
 * the reply prompt is the catch-up step's (BR-B14), through `shown`.
 */

import {useEffect, useRef, useState} from 'react'
import {View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Clock_Stroke2_Corner0_Rounded as ClockIcon} from '#/components/icons/Clock'
import {Text} from '#/components/Typography'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {usePrismHealth} from '#/horizon/routing/health'
import {useMembership} from '#/horizon/routing/membership'

/** How long the note stays once the account turns healthy (10). */
export const NOTE_LINGER_MS = 2_000

/**
 * Whether a surface shows the note: its gate hid `hidden` rows while a cause
 * is set, or did within {@link NOTE_LINGER_MS} of the account turning healthy.
 * `shown` forces it while a cause is set (the 20 s surfaces, BR-B14).
 */
export function useCatchingUpNoteShown({
  hidden,
  shown = false,
  did: didProp,
}: {
  hidden: number
  shown?: boolean
  did?: string
}): boolean {
  const currentDid = useCurrentClients()?.did
  const did = didProp ?? currentDid
  const member = useMembership(did) === 'member'
  const unwell = usePrismHealth(did).causes.size > 0
  const wasUnwell = useRef(unwell)
  const [lingering, setLingering] = useState(false)
  useEffect(() => {
    const recovered = wasUnwell.current && !unwell
    wasUnwell.current = unwell
    if (!recovered) {
      setLingering(false)
      return
    }
    setLingering(true)
    const timer = setTimeout(() => setLingering(false), NOTE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [unwell])
  if (!member) return false
  return (hidden > 0 || shown) && (unwell || lingering)
}

/**
 * The note itself, rendered only while {@link useCatchingUpNoteShown} says
 * so: one contrast-medium line with a clock icon.
 */
export function CatchingUpNote({
  hidden,
  shown,
  did,
}: {
  hidden: number
  shown?: boolean
  did?: string
}) {
  const visible = useCatchingUpNoteShown({hidden, shown, did})
  if (!visible) return null
  return <CatchingUpNoteLine />
}

/** The note's line, with no condition (its surfaces decide). */
export function CatchingUpNoteLine() {
  const t = useTheme()
  return (
    <View
      testID="privateCatchingUpNote"
      accessibilityRole="text"
      style={[a.flex_row, a.align_center, a.gap_sm, a.px_lg, a.py_sm]}>
      <ClockIcon size="sm" style={[t.atoms.text_contrast_medium]} />
      <Text style={[a.flex_1, a.text_sm, t.atoms.text_contrast_medium]}>
        <Trans>
          Catching up. Some private posts may take a moment to appear.
        </Trans>
      </Text>
    </View>
  )
}
