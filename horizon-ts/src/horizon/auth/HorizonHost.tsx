/*
 * One mount point for Horizon's app-wide pieces: the current-clients record
 * (first, so it is published before anything else runs), the in-place
 * sign-in window,
 * the password dialog, the membership probe and its notice, the write
 * routes' PDS cross-check, the private outbox and the direct `getPosts`
 * token's prefetch, the appearance
 * record's sync, the "spoilers from other apps" choice, the launch-time
 * check for a sign-in that never came back, and the cross-tab reload after an
 * AppView change. Mounted inside the account-keyed tree, so it remounts on
 * every account change.
 */

import {useEffect} from 'react'

import {AppearanceSync} from '#/horizon/appearance/AppearanceSync'
import {InPlaceSignInWindow} from '#/horizon/auth/InPlaceSignIn'
import {PasswordGateDialog} from '#/horizon/auth/PasswordSessionGate'
import {StalledSignInCheck} from '#/horizon/auth/StalledSignInCheck'
import {OutboxHost} from '#/horizon/private/outbox/OutboxHost'
import {CurrentClientsPublisher} from '#/horizon/routing/CurrentClientsPublisher'
import {DirectPrismPrefetch} from '#/horizon/routing/DirectPrismPrefetch'
import {
  MembershipNotice,
  MembershipProbe,
} from '#/horizon/routing/MembershipNotice'
import {subscribePublicAppviewChoice} from '#/horizon/routing/public-appview'
import {WriteRouteResolver} from '#/horizon/routing/WriteRouteResolver'
import {OtherAppSpoilersSync} from '#/horizon/spoilers/OtherAppSpoilers'

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
  return (
    <>
      <CurrentClientsPublisher />
      <StalledSignInCheck />
      <AppViewChangeReload />
      <MembershipProbe />
      <MembershipNotice />
      <WriteRouteResolver />
      <DirectPrismPrefetch />
      <OutboxHost />
      <AppearanceSync />
      <OtherAppSpoilersSync />
      <InPlaceSignInWindow />
      <PasswordGateDialog />
    </>
  )
}
