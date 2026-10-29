/*
 * One mount point for Horizon's app-wide pieces: the current-clients record
 * (first, so it is published before anything else runs), the in-place
 * sign-in window,
 * the password dialog, the membership probe and its notice, the write
 * routes' PDS cross-check, the private outbox and the direct `getPosts`
 * token's prefetch, the Thread Lens `getThread` token's prefetch and the
 * reader's mutes on the device (for a lens member), the identity
 * reads' `getRecords` and `listMembers` tokens' prefetch, the appearance
 * record's sync, the pre-warm of prism's private activity subscriptions,
 * the "spoilers from other apps" choice, an adult's choice to turn
 * Bluesky's moderation labeler off, the one-time removal of audience
 * records left in the repo once prism holds audiences, the system accounts'
 * list read
 * and announcer, the launch-time
 * check for a sign-in that never came back, the notice for a resume that
 * found its OAuth session busy in another tab, and the cross-tab reload after an
 * AppView change. Mounted inside the account-keyed tree, so it remounts on
 * every account change.
 */

import {useEffect} from 'react'

import {AppearanceSync} from '#/horizon/appearance/AppearanceSync'
import {InPlaceSignInWindow} from '#/horizon/auth/InPlaceSignIn'
import {PasswordGateDialog} from '#/horizon/auth/PasswordSessionGate'
import {StalledSignInCheck} from '#/horizon/auth/StalledSignInCheck'
import {BskyModerationSync} from '#/horizon/bsky-moderation'
import {IdentityTokenPrefetch} from '#/horizon/identity/TokenPrefetch'
import {MuteCacheHost} from '#/horizon/mutes/MuteCacheHost'
import {usePrivateActivityPrefetch} from '#/horizon/private/activity-subscriptions/private-state'
import {LeftoverAudienceCleanup} from '#/horizon/private/audiences/LeftoverAudienceCleanup'
import {OutboxHost} from '#/horizon/private/outbox/OutboxHost'
import {RefractHost} from '#/horizon/refract/RefractHost'
import {CurrentClientsPublisher} from '#/horizon/routing/CurrentClientsPublisher'
import {DirectPrismPrefetch} from '#/horizon/routing/DirectPrismPrefetch'
import {
  MembershipNotice,
  MembershipProbe,
} from '#/horizon/routing/MembershipNotice'
import {subscribePublicAppviewChoice} from '#/horizon/routing/public-appview'
import {WriteRouteResolver} from '#/horizon/routing/WriteRouteResolver'
import {OAuthBusyNotice} from '#/horizon/session/oauth-busy-notice'
import {OtherAppSpoilersSync} from '#/horizon/spoilers/OtherAppSpoilers'
import {SystemAccountsHost} from '#/horizon/system-accounts/SystemAccountsHost'
import {ThreadLensTokenPrefetch} from '#/horizon/thread-lens/TokenPrefetch'

/**
 * Another tab changed the public AppView: reload when this tab is next
 * brought to the front, so a tab the user is typing in is not reloaded under
 * them.
 */
function AppViewChangeReload() {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }
    let pending = false
    const reloadIfPending = () => {
      if (pending && document.visibilityState === 'visible') {
        window.location.reload()
      }
    }
    const unsubscribe = subscribePublicAppviewChoice(() => {
      pending = true
    })
    document.addEventListener('visibilitychange', reloadIfPending)
    window.addEventListener('focus', reloadIfPending)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', reloadIfPending)
      window.removeEventListener('focus', reloadIfPending)
    }
  }, [])

  return null
}

/**
 * Horizon's app-wide host. See the file header.
 */
export function HorizonHost() {
  // Pre-warms prism's list of private activity subscriptions for a member.
  usePrivateActivityPrefetch()
  return (
    <>
      <CurrentClientsPublisher />
      <StalledSignInCheck />
      <OAuthBusyNotice />
      <AppViewChangeReload />
      <MembershipProbe />
      <MembershipNotice />
      <WriteRouteResolver />
      <DirectPrismPrefetch />
      <RefractHost />
      <ThreadLensTokenPrefetch />
      <MuteCacheHost />
      <IdentityTokenPrefetch />
      <OutboxHost />
      <LeftoverAudienceCleanup />
      <AppearanceSync />
      <OtherAppSpoilersSync />
      <BskyModerationSync />
      <SystemAccountsHost />
      <InPlaceSignInWindow />
      <PasswordGateDialog />
    </>
  )
}
