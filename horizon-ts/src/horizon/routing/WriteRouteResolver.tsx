import {useEffect} from 'react'

import {logger} from '#/logger'
import {resolvePdsForIdentifier} from '#/state/queries/pds-detection'
import {useSession} from '#/state/session'

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The write routes' background cross-check (2K design PA-4). The routes
 * themselves need nothing published: they are computed from the session
 * account's PDS URL and the membership store, so they are known at once.
 * After sign-in, resume and an account switch (this host remounts on each),
 * the account's DID document is read once; a PDS origin other than the
 * session's is logged (origins only) and changes nothing: the session's URL
 * is the PDS writes go to, and it follows the DID document at the next
 * resume. Mounted in `HorizonHost`.
 */
export function WriteRouteResolver() {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const sessionOrigin = originOf(
    currentAccount?.pdsUrl ?? currentAccount?.service,
  )

  useEffect(() => {
    if (!did) return
    let cancelled = false
    resolvePdsForIdentifier(did).then(
      resolved => {
        if (cancelled) return
        const didDocOrigin = originOf(resolved?.pdsUrl)
        if (didDocOrigin === sessionOrigin) return
        logger.info('write-route: pds mismatch', {
          did,
          sessionOrigin,
          didDocOrigin,
        })
      },
      () => {
        if (cancelled) return
        logger.info('write-route: pds mismatch', {
          did,
          sessionOrigin,
          didDocOrigin: null,
        })
      },
    )
    return () => {
      cancelled = true
    }
  }, [did, sessionOrigin])

  return null
}
