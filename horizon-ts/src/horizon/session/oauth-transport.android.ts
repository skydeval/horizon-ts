/*
 * Android uses the web transport unchanged: it is written over the library's
 * `OAuthSession`, which the Expo client returns too, and its page-cache guard
 * does nothing where there is no `window.addEventListener`. Its imports
 * resolve to their Android siblings (the Expo client here).
 */

export * from './oauth-transport.web'
