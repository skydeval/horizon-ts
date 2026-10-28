/*
 * Once prism holds the account's audiences (`private.audiences`, answered
 * by prism in this run, not only remembered on the device), delete the
 * audience records still in its repo, once per account per run. prism kept
 * its own rows at the same URIs before listing the feature (prism's private
 * audiences reply, section 3), so this removes only the public copies.
 */

import {useEffect} from 'react'

import {logger} from '#/logger'
import {useMaybePdsClient, useSession} from '#/state/session'
import {deleteLeftoverRepoAudiences} from '#/horizon/private/api/audiences'
import {usePrismFeatureForWrite} from '#/horizon/private/features-hooks'

/** Accounts cleaned (or being cleaned) in this run. */
const started = new Set<string>()

/**
 * Mounted in `HorizonHost`. Renders nothing.
 */
export function LeftoverAudienceCleanup() {
  const {currentAccount} = useSession()
  const pdsClient = useMaybePdsClient()
  const onPrism = usePrismFeatureForWrite('private.audiences')
  const did = currentAccount?.did

  useEffect(() => {
    if (!onPrism || !did || !pdsClient || started.has(did)) return
    started.add(did)
    deleteLeftoverRepoAudiences({did, pdsClient}).then(
      deleted => {
        if (deleted > 0) {
          logger.info('deleted leftover repo audiences', {deleted})
        }
      },
      error => {
        // Tried again on the next run.
        started.delete(did)
        logger.warn('leftover repo audience cleanup failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }, [onPrism, did, pdsClient])

  return null
}

/** Forget which accounts were cleaned (tests). */
export function resetLeftoverAudienceCleanup() {
  started.clear()
}
