/*
 * What the user is told when an OAuth session stayed busy: another Horizon
 * document held the OAuth library's lock on it for longer than Horizon waits
 * (see `oauth-lock.ts`).
 */

import {useEffect} from 'react'
import {t} from '@lingui/core/macro'

import * as Toast from '#/components/Toast'
import {
  subscribeOAuthBusyReports,
  takeOAuthBusyReport,
} from '#/horizon/session/oauth-busy-report'

/**
 * The message for a sign-in or account switch that found the session busy.
 */
export function oauthBusyMessage() {
  return t`Horizon is busy in another tab. Close other Horizon tabs or try again in a moment.`
}

function showReport() {
  if (!takeOAuthBusyReport()) return
  Toast.show(oauthBusyMessage(), {type: 'warning'})
}

/**
 * Shows a held or later busy report (`reportOAuthBusyResume`) as a toast.
 * Mounted by `HorizonHost`.
 */
export function OAuthBusyNotice() {
  useEffect(() => {
    showReport()
    return subscribeOAuthBusyReports(showReport)
  }, [])
  return null
}
