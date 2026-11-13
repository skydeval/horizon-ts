/*
 * bsky.social's sign-up check sends its result to bsky.app, which no other
 * site can read (bsky.app refuses to load in a frame), so a bsky.social
 * account can't be finished from Horizon's web app (`BskySocialWebNote`).
 */

import {BSKY_SERVICE} from '#/lib/constants'
import {IS_WEB} from '#/env'

/** Whether sign-up with `serviceUrl` has to happen on bsky.app instead. */
export function signupNeedsBskyApp(
  serviceUrl: string,
  web: boolean = IS_WEB,
): boolean {
  if (!web) return false
  try {
    return new URL(serviceUrl).host === new URL(BSKY_SERVICE).host
  } catch {
    return false
  }
}
