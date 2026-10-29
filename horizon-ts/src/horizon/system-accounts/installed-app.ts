/*
 * Native: there is no installed web app. The Android app signs in through
 * the system's browser sheet; the iOS app, with no OAuth client, offers the
 * app password only.
 */

export function isInstalledMobileWebApp(): boolean {
  return false
}
