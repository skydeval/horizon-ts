/*
 * The catching-up note (prism busy design 10, decision 1): one quiet line
 * telling a member that some private posts may take a moment to appear,
 * worded so it never implies loss. Not a toast, banner or modal.
 *
 * Shown at once on a surface whose load the gate trimmed (its `hidden` > 0)
 * while a health cause is set (4.1); never on a launch gated only because
 * nothing has answered yet (no cause), never for a non-member. It clears with
 * the next ungated load (`hidden` back to 0) or 2 s after the account turns
 * healthy. On the Private tab, each notification tab, Saved's Private mode and
 * above a private thread's reply prompt it also shows after
 * {@link ILL_HEALTH_NOTE_MS} of ill health (`illHealth`).
 */

import {useEffect, useRef, useState} from 'react'
import {View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Clock_Stroke2_Corner0_Rounded as ClockIcon} from '#/components/icons/Clock'
import {Text} from '#/components/Typography'
import {useCurrentClients} from '#/horizon/routing/current-clients'
import {healthEnvironment, usePrismHealth} from '#/horizon/routing/health'
import {useMembership} from '#/horizon/routing/membership'

/** How long the note stays once the account turns healthy (10). */
export const NOTE_LINGER_MS = 2_000

/** How long ill health lasts before the note shows on its own surfaces (10). */
export const ILL_HEALTH_NOTE_MS = 20_000

/**
 * Whether `did`'s health has had a cause for {@link ILL_HEALTH_NOTE_MS} or
 * more, kept current (a timer turns it on).
 */
export function useIllHealthFor(did: string | undefined): boolean {
  const health = usePrismHealth(did)
  const unwell = health.causes.size > 0
  const since = health.since
  const [long, setLong] = useState(false)
  useEffect(() => {
    if (!unwell) {
      setLong(false)
      return
    }
    const env = healthEnvironment()
    const left = since + ILL_HEALTH_NOTE_MS - env.now()
    if (left <= 0) {
      setLong(true)
      return
    }
    setLong(false)
    const timer = env.setTimeout(() => setLong(true), left)
    return () => env.clearTimeout(timer)
  }, [unwell, since])
  return unwell && long
}

/**
 * Whether a surface shows the note: its gate hid `hidden` rows while a cause
 * is set, or did within {@link NOTE_LINGER_MS} of the account turning healthy.
 * `shown` forces it while a cause is set; `illHealth` does once a cause has
 * lasted {@link ILL_HEALTH_NOTE_MS} (the 20 s surfaces, design 10).
 */
export function useCatchingUpNoteShown({
  hidden,
  shown: shownProp = false,
  illHealth = false,
  did: didProp,
}: {
  hidden: number
  shown?: boolean
  illHealth?: boolean
  did?: string
}): boolean {
  const currentDid = useCurrentClients()?.did
  const did = didProp ?? currentDid
  const member = useMembership(did) === 'member'
  const unwell = usePrismHealth(did).causes.size > 0
  const ill = useIllHealthFor(did)
  // Shown by ill health, it lingers like any other note once healthy.
  const [illLatched, setIllLatched] = useState(false)
  useEffect(() => {
    if (ill) setIllLatched(true)
  }, [ill])
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
    const timer = setTimeout(() => {
      setLingering(false)
      setIllLatched(false)
    }, NOTE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [unwell])
  if (!member) return false
  const shown = shownProp || (illHealth && (ill || illLatched))
  return (hidden > 0 || shown) && (unwell || lingering)
}

/**
 * The note itself, rendered only while {@link useCatchingUpNoteShown} says
 * so: one contrast-medium line with a clock icon.
 */
export function CatchingUpNote({
  hidden,
  shown,
  illHealth,
  did,
}: {
  hidden: number
  shown?: boolean
  /** Also after 20 s of ill health (the Private tab, notifications, Saved, a private thread). */
  illHealth?: boolean
  did?: string
}) {
  const visible = useCatchingUpNoteShown({hidden, shown, illHealth, did})
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
