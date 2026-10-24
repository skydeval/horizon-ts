import {createContext, useContext, useEffect} from 'react'
import {type OAuthSession} from '@atproto/oauth-client-browser'

import {logger} from '#/logger'
import {type SessionAccount} from '#/state/session/types'
import {createOAuthSessionBundleAndLogin} from '#/horizon/session/oauth-bundle-factory'
import {
  disposeOAuthBundle,
  getOAuthBundleInfo,
} from '#/horizon/session/oauth-bundles'
import {watchOAuthSessionDeath} from '#/horizon/session/session-death'
import {
  currentBundle,
  type HorizonSessionStore,
} from '#/horizon/session/session-store'
import {registerStoredAccountSink} from '#/horizon/session/stored-account'
import {com} from '#/lexicons'

/**
 * Horizon's session operations, beside the stock session API (whose type is
 * not widened).
 */
export type HorizonSessionApi = {
  /**
   * Sign in with a completed OAuth session, as the stock `login` does for a
   * password: builds the bundle and account and switches to them, unless a
   * newer session task superseded this one.
   */
  loginWithOAuth: (session: OAuthSession) => Promise<void>
}

const HorizonSessionApiContext = createContext<HorizonSessionApi>({
  loginWithOAuth: () =>
    Promise.reject(new Error('HorizonSessionProvider is not mounted')),
})
HorizonSessionApiContext.displayName = 'HorizonSessionApiContext'

/**
 * The stock store plus `subscribe`, which the provider uses to see bundle
 * changes.
 */
type ProviderStore = HorizonSessionStore & {
  subscribe(listener: () => void): () => void
}

/**
 * Re-read the account fields once after an OAuth cold-start resume, which
 * builds the account from the stored copy, and apply any change as an
 * `update` event, as the reducer applies a password refresh.
 */
async function refreshAccountFields(
  store: HorizonSessionStore,
  bundle: ReturnType<typeof currentBundle>,
  did: string,
) {
  try {
    const data = await bundle.pdsClient.call(com.atproto.server.getSession, {})
    if (currentBundle(store) !== bundle) return
    const stored = store.getState().accounts.find(a => a.did === did)
    if (!stored) return
    const next: SessionAccount = {
      ...stored,
      handle: data.handle,
      email: data.email,
      emailConfirmed: data.emailConfirmed || false,
      emailAuthFactor: data.emailAuthFactor || false,
      active: data.active,
      status: data.status,
    }
    if (JSON.stringify(next) === JSON.stringify(stored)) return
    store.dispatch({
      type: 'received-session-event',
      bundle,
      accountDid: did,
      refreshedAccount: next,
      sessionEvent: 'update',
    })
  } catch (e) {
    logger.debug('session: OAuth account refresh failed', {
      message: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Mounted inside the stock session provider, around its children: OAuth
 * login, the remote session-death listener, and the account refresh after an
 * OAuth resume.
 */
export function HorizonSessionProvider({
  store,
  cancelPendingTask,
  children,
}: {
  store: ProviderStore
  cancelPendingTask: () => AbortSignal
  children: React.ReactNode
}) {
  useEffect(() => watchOAuthSessionDeath(store), [store])

  // A temporary client's rotated tokens (Phase 5, PA-4).
  useEffect(
    () =>
      registerStoredAccountSink(account =>
        store.dispatch({type: 'updated-stored-account', account}),
      ),
    [store],
  )

  useEffect(() => {
    let last = currentBundle(store)
    return store.subscribe(() => {
      const bundle = currentBundle(store)
      if (bundle === last) return
      last = bundle
      const info = getOAuthBundleInfo(bundle)
      if (info?.needsAccountRefresh) {
        info.needsAccountRefresh = false
        void refreshAccountFields(store, bundle, info.did)
      }
    })
  }, [store])

  const api: HorizonSessionApi = {
    async loginWithOAuth(session) {
      const signal = cancelPendingTask()
      const {bundle, account} = await createOAuthSessionBundleAndLogin(session)
      if (signal.aborted) {
        disposeOAuthBundle(bundle)
        return
      }
      store.dispatch({
        type: 'switched-to-account',
        newBundle: bundle,
        newAccount: account,
      })
    },
  }

  return (
    <HorizonSessionApiContext.Provider value={api}>
      {children}
    </HorizonSessionApiContext.Provider>
  )
}

/**
 * Horizon's session operations. See {@link HorizonSessionApi}.
 */
export function useHorizonSessionApi() {
  return useContext(HorizonSessionApiContext)
}
