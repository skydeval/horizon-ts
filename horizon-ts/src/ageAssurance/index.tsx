import {createContext, useCallback, useContext, useMemo} from 'react'

import {useGetAndRegisterPushToken} from '#/lib/notifications/notifications'
import {Provider as RedirectOverlayProvider} from '#/ageAssurance/components/RedirectOverlay'
import {
  AgeAssuranceServerDataProvider,
  useAgeAssuranceServerDataContext,
} from '#/ageAssurance/data'
import {logger} from '#/ageAssurance/logger'
import {
  useAgeAssuranceState,
  useOnAgeAssuranceAccessUpdate,
} from '#/ageAssurance/state'
import {
  AgeAssuranceAccess,
  type AgeAssuranceFlags,
  type AgeAssuranceState,
  AgeAssuranceStatus,
} from '#/ageAssurance/types'
import {
  computeAgeAssuranceFlags,
  useAgeAssuranceRegionConfigWithFallback,
} from '#/ageAssurance/util'
// HORIZON: the app's own age checks, where a state law applies
import {
  blocksApp,
  locksAdultContent,
  useAgeCheck,
  useAgeCheckOnLaunch,
} from '#/horizon/age-checks'
// HORIZON: Bluesky's age assurance is off for every session
import {AGE_ASSURANCE_OFF} from '#/horizon/switches'

export {
  prefetchConfig as prefetchAgeAssuranceConfig,
  prefetchAgeAssuranceServerData,
  refetchServerState as refetchAgeAssuranceServerState,
  usePatchOtherRequiredData as usePatchAgeAssuranceOtherRequiredData,
  usePatchServerState as usePatchAgeAssuranceServerState,
} from '#/ageAssurance/data'
export {logger} from '#/ageAssurance/logger'

type AgeAssuranceContextValue = {
  Access: typeof AgeAssuranceAccess
  Status: typeof AgeAssuranceStatus
  state: AgeAssuranceState
  flags: AgeAssuranceFlags
}

const DEFAULT_CONTEXT: AgeAssuranceContextValue = {
  Access: AgeAssuranceAccess,
  Status: AgeAssuranceStatus,
  state: {
    lastInitiatedAt: undefined,
    status: AgeAssuranceStatus.Unknown,
    access: AgeAssuranceAccess.Full,
  },
  flags: {
    isAgeRestricted: false,
    adultContentDisabled: false,
    chatDisabled: false,
    groupChatDisabled: false,
    hasDeclaredAge: false,
    isDeclaredUnderAdultAge: false,
    isOverRegionMinAccessAge: false,
    isOverAppMinAccessAge: false,
    allowsDeviceVerification: false,
    hasSharedDeviceSignals: false,
  },
}

const AgeAssuranceStateContext =
  createContext<AgeAssuranceContextValue>(DEFAULT_CONTEXT)

/**
 * THE MAIN AGE ASSURANCE CONTEXT HOOK
 *
 * Prefer this to using any of the lower-level data-provider hooks.
 */
export function useAgeAssurance() {
  return useContext(AgeAssuranceStateContext)
}

export function Provider({children}: {children: React.ReactNode}) {
  /*
   * HORIZON: Bluesky's age assurance is off; the context grants full access
   * except where the app's own age check applies (`#/horizon/age-checks`).
   */
  if (AGE_ASSURANCE_OFF) {
    return <HorizonAgeCheckProvider>{children}</HorizonAgeCheckProvider>
  }
  return (
    <AgeAssuranceServerDataProvider>
      <InnerProvider>
        <RedirectOverlayProvider>{children}</RedirectOverlayProvider>
      </InnerProvider>
    </AgeAssuranceServerDataProvider>
  )
}

/*
 * HORIZON: in the app in a covered state, the store's answer drives the
 * same context Bluesky's screens read: a block shows the blocked screen
 * (access `None`), anything short of an adult locks adult content off. Chat
 * and everything else are untouched (skydeval, 2026-10-29). Elsewhere the
 * defaults.
 */
function HorizonAgeCheckProvider({children}: {children: React.ReactNode}) {
  const check = useAgeCheck()
  useAgeCheckOnLaunch(check !== null)
  const outcome = check?.outcome
  const value = useMemo((): AgeAssuranceContextValue => {
    if (!outcome) return DEFAULT_CONTEXT
    const blocked = blocksApp(outcome)
    return {
      ...DEFAULT_CONTEXT,
      state: {
        ...DEFAULT_CONTEXT.state,
        status: blocked
          ? AgeAssuranceStatus.Blocked
          : AgeAssuranceStatus.Unknown,
        access: blocked ? AgeAssuranceAccess.None : AgeAssuranceAccess.Full,
      },
      flags: {
        ...DEFAULT_CONTEXT.flags,
        adultContentDisabled: locksAdultContent(outcome),
      },
    }
  }, [outcome])
  return (
    <AgeAssuranceStateContext.Provider value={value}>
      {children}
    </AgeAssuranceStateContext.Provider>
  )
}

function InnerProvider({children}: {children: React.ReactNode}) {
  const state = useAgeAssuranceState()
  const {metadata, deviceSignals} = useAgeAssuranceServerDataContext()
  const regionConfig = useAgeAssuranceRegionConfigWithFallback()
  const getAndRegisterPushToken = useGetAndRegisterPushToken()

  const handleAccessUpdate = useCallback(
    (s: AgeAssuranceState) => {
      const flags = computeAgeAssuranceFlags({
        state: s,
        regionConfig,
        metadata,
        deviceSignals,
      })
      if (flags.isAgeRestricted) {
        void getAndRegisterPushToken({
          isAgeRestricted: true,
        })
      }
    },
    [getAndRegisterPushToken, regionConfig, metadata, deviceSignals],
  )
  useOnAgeAssuranceAccessUpdate(handleAccessUpdate)

  return (
    <AgeAssuranceStateContext.Provider
      value={useMemo(() => {
        const res = {
          Access: AgeAssuranceAccess,
          Status: AgeAssuranceStatus,
          state,
          flags: computeAgeAssuranceFlags({
            state,
            regionConfig,
            metadata,
            deviceSignals,
          }),
        }
        logger.debug(`useAgeAssurance`, res)
        return res
      }, [state, metadata, regionConfig, deviceSignals])}>
      {children}
    </AgeAssuranceStateContext.Provider>
  )
}
