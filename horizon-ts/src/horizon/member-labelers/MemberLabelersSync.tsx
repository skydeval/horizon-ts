import {useEffect} from 'react'
import {AppState} from 'react-native'

import {
  getCurrentClients,
  subscribeCurrentClients,
} from '#/horizon/routing/current-clients'
import {servesFeature, subscribePrismFeatures} from '#/horizon/routing/features'
import {
  isPrivateMember,
  subscribeMembership,
} from '#/horizon/routing/membership'
import {
  fetchMemberLabelerImage,
  fetchMemberLabelers,
  fetchMemberLabels,
} from './api'
import {connectMemberLabels, dropMemberLabels} from './labels'
import {
  clearMemberLabelers,
  getMemberLabelers,
  hasMemberLabelers,
  loadMemberLabelers,
  refreshMemberLabelers,
  subscribeMemberLabelers,
} from './store'

// The AppView client's labels come from here (see `labels.ts`).
connectMemberLabels({
  hasLabelers: hasMemberLabelers,
  fetchLabels: (pdsClient, subjects) => fetchMemberLabels(pdsClient, subjects),
})

/** How often the list is asked again while the app is open. */
const RECHECK_MS = 10 * 60_000
/** The shortest gap between two asks. */
const MIN_GAP_MS = 60_000

function eligible(did: string): boolean {
  return isPrivateMember(did) && servesFeature('umbrae.read', did)
}

function idsOf(): string {
  return getMemberLabelers()
    .map(labeler => `${labeler.id}:${labeler.defs.length}`)
    .sort()
    .join(' ')
}

/**
 * Keeps the member's labelers current: loaded from the device when the
 * account becomes current, asked of prism once it confirms the account is a
 * member it serves them to, every few minutes and on returning to the front.
 * When the labelers themselves change, cached labels are dropped and the
 * account's reads run again so their views carry the new labels. Renders
 * nothing. Mounted once, in `HorizonHost`.
 */
export function MemberLabelersSync() {
  useEffect(() => {
    let did: string | undefined
    let ids = idsOf()
    let askedAt = 0

    const check = () => {
      const current = getCurrentClients()
      if (!current || current.did !== did || !eligible(current.did)) return
      // Membership and feature answers come often: ask at most once a minute.
      if (Date.now() - askedAt < MIN_GAP_MS) return
      askedAt = Date.now()
      void refreshMemberLabelers(current.did, current.pdsClient, {
        fetchLabelers: client => fetchMemberLabelers(client),
        fetchImage: (client, labeler, cid) =>
          fetchMemberLabelerImage(client, labeler, cid),
      })
    }

    const onAccount = () => {
      const next = getCurrentClients()?.did
      if (next === did) return
      did = next
      askedAt = 0
      dropMemberLabels()
      loadMemberLabelers(did)
      check()
    }

    const onEligibility = () => {
      if (!did) return
      if (eligible(did)) check()
      else if (getMemberLabelers().length > 0) clearMemberLabelers(did)
    }

    const onList = () => {
      const next = idsOf()
      if (next === ids) return
      ids = next
      dropMemberLabels()
      void getCurrentClients()?.queryClient?.invalidateQueries()
    }

    const unsubscribes = [
      subscribeCurrentClients(onAccount),
      subscribeMembership(onEligibility),
      subscribePrismFeatures(onEligibility),
      subscribeMemberLabelers(onList),
    ]
    onAccount()
    const timer = setInterval(check, RECHECK_MS)
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') check()
    })
    return () => {
      unsubscribes.forEach(unsubscribe => unsubscribe())
      clearInterval(timer)
      appState.remove()
    }
  }, [])
  return null
}
