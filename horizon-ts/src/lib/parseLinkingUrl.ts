// HORIZON: the app's own scheme (app.config.js), not Bluesky's
const SCHEME = 'app.nearhorizon://'

export function parseLinkingUrl(url: string): URL {
  /*
   * Hack: add a third slash to app scheme urls so that `URL.host` is empty and
   * `URL.pathname` has the full path.
   */
  if (url.startsWith(SCHEME) && !url.startsWith(`${SCHEME}/`)) {
    url = url.replace(SCHEME, `${SCHEME}/`)
  }
  return new URL(url)
}
