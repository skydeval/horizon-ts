import {useEffect} from 'react'
import {useLingui} from '@lingui/react/macro'

import {useMaybePdsClient, useSession} from '#/state/session'
import * as Toast from '#/components/Toast'
import {PRODUCT_NAME} from '#/horizon/branding'
import {
  onEnteredIndexing,
  startMembershipProbe,
} from '#/horizon/routing/membership'
import {getPrismClient} from '#/horizon/routing/prism'

/**
 * Starts the membership probe whenever a signed-in bundle becomes current
 * (sign-in, resume, account switch, cross-tab adoption) and cancels it on any
 * account or bundle change.
 */
export function MembershipProbe() {
  const {currentAccount} = useSession()
  const pdsClient = useMaybePdsClient()
  const did = currentAccount?.did

  useEffect(() => {
    if (!did || !pdsClient) return
    return startMembershipProbe(did, getPrismClient(pdsClient))
  }, [did, pdsClient])

  return null
}

/**
 * One plain toast when the current account enters `indexing`. Nothing is
 * shown for `member` or `not-member`: the features simply appear or stay
 * absent.
 */
export function MembershipNotice() {
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const did = currentAccount?.did

  useEffect(() => {
    return onEnteredIndexing(enteredDid => {
      if (enteredDid !== did) return
      Toast.show(
        l`Your account is being set up for ${PRODUCT_NAME}’s network features. This usually takes a minute.`,
        {type: 'info'},
      )
    })
  }, [did, l])

  return null
}
