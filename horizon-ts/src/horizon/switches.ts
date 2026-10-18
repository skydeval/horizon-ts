/*
 * Fixed switches that Horizon's hooks into Bluesky's files guard on. They are
 * not user settings. Each is typed as `boolean`, not as its literal value, so
 * TypeScript keeps the guarded stock branch and lint sees its imports as used.
 * Flipping one restores Bluesky's behaviour at that hook.
 */

/**
 * Nothing is sent to Bluesky's metrics service, and Sentry stays off even if
 * a DSN is set.
 */
export const TELEMETRY_OFF: boolean = true

/**
 * Bluesky's feature flags are read from the local table in
 * `#/horizon/flags` instead of being fetched from Bluesky's GrowthBook.
 */
export const LOCAL_FLAGS: boolean = true

/**
 * Age assurance is off for every session, signed in or out.
 */
export const AGE_ASSURANCE_OFF: boolean = true

/**
 * Settings > About shows "Send error report". Off while error reporting is
 * off, since the report would go nowhere.
 */
export const SHOW_ERROR_REPORT: boolean = false

/**
 * Settings shows "Beta features", Bluesky's beta enrolment, kept for when
 * Bluesky ships new betas. Its list is empty while every current beta is on
 * by default in the local flag table.
 */
export const SHOW_BETA_FEATURES: boolean = true

/**
 * Signing out runs Horizon's sign-out sequence (push unregistration, OAuth
 * revocation, ending the password session on the server) in place of the
 * reducer's own push-unregistration side effect. `false` restores the stock
 * side effect and skips Horizon's sequence entirely.
 */
export const HORIZON_SIGN_OUT: boolean = true

/**
 * Switching to an account whose session has ended opens the in-place sign-in
 * window instead of the signed-out screen.
 */
export const IN_PLACE_SIGN_IN: boolean = true

/**
 * The sign-in screen's description names both sign-in ways (OAuth and
 * password) instead of only the password.
 */
export const SIGN_IN_TABS: boolean = true

/**
 * Private posting: the composer's Public | Private control and the private
 * write path, the draft visibility table, and the Audiences settings row.
 */
export const PRIVATE_POSTING: boolean = true

/**
 * The composer's footer drop-down sets who can reply and who can quote for
 * every account, members or not, in place of the stock interaction pill and
 * dialog; a private compose writes its reply and quote limits as stock
 * threadgate and postgate records. `false` restores the stock pill, puts the
 * Private-only control above the pills, and writes no gates for a private
 * compose. Only meaningful with `PRIVATE_POSTING` on for the private parts.
 */
export const COMPOSER_AUDIENCE_MENU: boolean = true

/**
 * Private reading: private posts in Following, the profile Private tab,
 * private threads and posts by URI, pasted private links, private quotes.
 */
export const PRIVATE_READING: boolean = true

/**
 * How private posts look and which controls they offer: the badge and
 * border, hidden counts, link proxying, menus. Only meaningful with
 * `PRIVATE_READING` on.
 */
export const PRIVATE_POST_DISPLAY: boolean = true

/**
 * Private post links use the `ppost` path segment and share on Horizon's
 * own host. Only meaningful with `PRIVATE_READING` on.
 */
export const PRIVATE_POST_LINKS: boolean = true

/**
 * The Public | Private switch on the notifications screen.
 */
export const PRIVATE_NOTIFICATIONS_SWITCH: boolean = true

/**
 * The Public | Private folder tabs on the Saved screen and its private list,
 * for members.
 */
export const PRIVATE_SAVED_SWITCH: boolean = true

/**
 * The membership probe falls back to prism's private timeline when prism
 * answers the public probe with 501 (public indexing off). Guards Horizon
 * code only.
 */
export const MEMBERSHIP_PROBE_FALLBACK: boolean = true

/**
 * The membership probe asks prism's `app.nearhorizon.actor.getMembership`
 * first, which answers the status and the private-tier features prism serves
 * (2H design 3). `false` restores the Phase 2 probe exactly, with no
 * features: every family but `private` reads as absent, so private spoilers
 * are written in keep mode and links and tags in served private posts are
 * detected locally. Guards Horizon code only.
 */
export const MEMBERSHIP_QUERY: boolean = true

/**
 * The search screen's Top and Latest tabs list a member's private results
 * with the public ones (2H design 11, H-2), while prism searches private
 * posts (`private.search`). `false` restores the stock search results.
 */
export const PRIVATE_SEARCH_SWITCH: boolean = true

/**
 * A page of the redesigned notifications whose
 * `app.bsky.notification.getGroupedNotifications` request fails with a 5xx or
 * a network error is loaded through `app.bsky.notification.listNotifications`
 * and grouped on the client instead (`notifications/grouped-fallback.ts`).
 * `false` lets the failure reach the screen, as in Bluesky.
 */
export const GROUPED_NOTIFICATIONS_FALLBACK: boolean = true

/**
 * Spoiler tags (`spoilers/`): `||...||` in a post is written as spoiler
 * facets and rendered as covers and drawers, with the composer's spoiler
 * button and its character count. `false` restores Bluesky's behaviour: the
 * text and facets are written as stock, the markers show as typed, and the
 * button is absent.
 */
export const SPOILER_TAGS: boolean = true
