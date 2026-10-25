/*
 * Native: there is no installed web app; registration is app password only
 * there for another reason (no native OAuth, 1.2).
 */

export function isInstalledMobileWebApp(): boolean {
  return false
}
