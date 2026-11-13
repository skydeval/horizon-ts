import {useEffect} from 'react'
import {AppState} from 'react-native'
import {Client} from '@atproto/lex'
import {useQueryClient} from '@tanstack/react-query'

import {configureGlobalAppLabelers} from '#/state/session/additional-moderation-authorities'
import {
  cairnUrl,
  checkCairnPrimaryLabeler,
  subscribeCairnPrimaryLabeler,
} from '#/horizon/cairn/primary-labeler'

/** How often the primary is checked again while the app is open. */
const RECHECK_MS = 5 * 60_000

/**
 * Keeps the cairn primary labeler current: checked at launch, every few
 * minutes and when the app comes back to the front. When it changes, the
 * app's labelers are rebuilt and everything is read again under them.
 * Renders nothing; does nothing without an operator cairn address. Mounted
 * once, in `HorizonHost`.
 */
export function CairnLabelerSync() {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!cairnUrl()) return
    const check = () => {
      void checkCairnPrimaryLabeler()
    }
    const unsubscribe = subscribeCairnPrimaryLabeler(() => {
      configureGlobalAppLabelers([...Client.appLabelers])
      void queryClient.invalidateQueries()
    })
    check()
    const timer = setInterval(check, RECHECK_MS)
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') check()
    })
    return () => {
      unsubscribe()
      clearInterval(timer)
      appState.remove()
    }
  }, [queryClient])
  return null
}
