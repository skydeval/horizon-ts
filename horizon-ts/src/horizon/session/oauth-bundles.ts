/*
 * The side store that marks a session bundle as an OAuth bundle.
 *
 * An OAuth bundle has the stock public-bundle shape (`session: null` and the
 * three clients), so Bluesky's bundle types do not change. Membership of this
 * store is what makes it signed in.
 */

/**
 * What Horizon keeps beside an OAuth bundle.
 */
export type OAuthBundleInfo = {
  did: string
  /** Disable the bundle's transport: every later request throws before I/O. */
  kill: () => void
  /**
   * Set on a cold-start resume, which builds the account from the stored copy
   * without asking the server; the session provider then refreshes the
   * account fields once in the background.
   */
  needsAccountRefresh: boolean
}

const oauthBundles = new WeakMap<object, OAuthBundleInfo>()

/**
 * Record a bundle as an OAuth bundle.
 */
export function registerOAuthBundle(bundle: object, info: OAuthBundleInfo) {
  oauthBundles.set(bundle, info)
}

/**
 * The OAuth info of a bundle, or `undefined` for any other bundle.
 */
export function getOAuthBundleInfo(
  bundle: object | null | undefined,
): OAuthBundleInfo | undefined {
  return bundle ? oauthBundles.get(bundle) : undefined
}

/**
 * Whether the bundle is an OAuth bundle.
 */
export function isOAuthBundle(bundle: object | null | undefined): boolean {
  return !!bundle && oauthBundles.has(bundle)
}

/**
 * The DID of an OAuth bundle, or `undefined` for any other bundle.
 */
export function getOAuthBundleDid(
  bundle: object | null | undefined,
): string | undefined {
  return getOAuthBundleInfo(bundle)?.did
}

/**
 * Whether the bundle carries a session of either kind: a password bundle has
 * a `session`, an OAuth bundle is in the side store, anything else is the
 * public bundle.
 */
export function isSignedInBundle(bundle: {session: unknown}): boolean {
  return bundle.session !== null || oauthBundles.has(bundle)
}

/**
 * Dispose an OAuth bundle: its transport stops before any I/O. Returns
 * `false`, doing nothing, for any other bundle.
 */
export function disposeOAuthBundle(bundle: object): boolean {
  const info = oauthBundles.get(bundle)
  if (!info) return false
  info.kill()
  return true
}
