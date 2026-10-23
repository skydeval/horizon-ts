/*
 * The words restored accounts' surfaces show when Refract can't answer yet
 * (refract client design 4.1, 4.2, 4.4, 9.3, Q6). None names the feature, a
 * community, a restore or a ban, and the `pending` and unconfirmed texts
 * claim no server fault (handoff 7, 11.1 "copy").
 */

import {t} from '@lingui/core/macro'
import {onlineManager} from '@tanstack/react-query'

/** Stock's server-issues text, true only when a call failed or was skipped. */
export function serverIssuesText(): string {
  return t`The server appears to be experiencing issues. Please try again in a few moments.`
}

/** Stock's connection text. */
export function connectionText(): string {
  return t`Unable to connect. Please check your internet connection and try again.`
}

/** A failed or skipped call: the connection text offline, else server issues. */
export function transientText(): string {
  return onlineManager.isOnline() ? serverIssuesText() : connectionText()
}

/** The profile while prism hasn't answered definitively (Q6). */
export function profileNotNowText(): string {
  return t`This profile can’t be shown right now.`
}

/** The composer's matching text for a reply parent (Q6). */
export function replyNotNowText(): string {
  return t`This post can’t be replied to right now.`
}
