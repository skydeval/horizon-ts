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
 * Private posting for members on a PDS other than locus (2K design 10): the
 * `encode` posting route, where Horizon encodes the post in the browser and
 * writes it to the member's own PDS. `false`: such a member's posting route
 * is `none` (Private shown inert with the note), the encoder is never loaded,
 * and deletes still work through the repo route. Guards Horizon code only.
 */
export const PRIVATE_POSTING_ANY_PDS: boolean = true

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

/**
 * Per-item media spoilers (`media-spoilers/`, 2J design): the "Mark as
 * spoiler" checkboxes and thumbnail badges in the composer, the flags written
 * at publish (a content warning's flags too), and the covers, autoplay hold,
 * lightbox filter and compact blurs that read them. `false` writes no flag
 * and renders flagged media as stock.
 */
export const MEDIA_SPOILERS: boolean = true

/**
 * Spoilers from other apps (change list item 2, reversing spoilers design
 * S-3 as an opt-out): a post without spoiler facets has its `||...||` pairs
 * parsed on this device under a strict rule (`spoilers/other-apps.ts`) and
 * drawn as covers, while the account's "Cover ||spoilers|| from other apps"
 * setting in Content and media is on (the default). Effective only with
 * `SPOILER_TAGS` on. `false` removes the setting row and renders such posts
 * as stock, markers visible.
 */
export const OTHER_APP_SPOILERS: boolean = true

/**
 * Whole-post content warnings (2J design): the composer's CW toggle and line,
 * the CW text pipeline, the `app.nearhorizon.cw` self-label, and the "Content
 * warning" wording of drawers and pills. Effective only with `SPOILER_TAGS`
 * on, since the body is written as a spoiler. `false` removes the toggle and
 * field, writes stock text and no label, and renders a CW post's body as a
 * plain spoiler.
 */
export const CONTENT_WARNINGS: boolean = true

/**
 * Backdrops (Phase 3 design, `backdrops/`, `appearance/`): the backdrop
 * layer, the transparent shell root, the transparent web `contentStyle` and
 * navigation-theme background, the reading surface, the split-view
 * background, the rail and nav cards and the Appearance sections. `false`
 * returns every hook to its stock value (`t.atoms.bg` roots and
 * `contentStyle`, the input navigation theme, `RailCard` as a fragment or the
 * stock view, `ReadingSurface`, `BackdropLayer` and
 * `HorizonAppearanceSections` render nothing, `horizonOpaque` is
 * `undefined`), and sync does not run.
 */
export const BACKDROPS: boolean = true

/**
 * The compact frame windows (Phase 3 design, section 9): below 800px the
 * Home header, the sticky headers, the bottom bar and the drawer paint the
 * backdrop inside themselves, bare or under the theme's glass as the phone
 * frame says. Effective only with `BACKDROPS` on. `false` leaves compact
 * screens stock (`FrameWindow` and `BarShade` render nothing, the inner Home header
 * row is sticky, the Home tab bar paints `t.atoms.bg`): the backdrop shows on
 * desktop and tablet only.
 */
export const COMPACT_FRAME_WINDOWS: boolean = true

/**
 * Reading and writing the public appearance record
 * (`app.nearhorizon.actor.appearance/self`) in the account's own repo.
 * Guards Horizon code only. `false` keeps the appearance on this device only.
 */
export const APPEARANCE_SYNC: boolean = true

/**
 * "Interaction settings" as a main Settings row, between "Moderation and
 * content filters" and "Notifications" (Phase 3, batch B). It opens the same
 * screen as the Moderation screen's row, which stays. `false` removes the
 * main row.
 */
export const INTERACTION_SETTINGS_ROW: boolean = true

/**
 * The private posting defaults (Phase 3, batch B): the Interaction settings
 * screen's "Public posts" heading and "Private posts" section for members
 * ("New posts start as", "Default audience", the reply and quote note and
 * the Audiences link), the record that holds them
 * (`app.nearhorizon.actor.postingDefaults/self`, read and written in the
 * account's own repo), and the composer starting a member's new post from
 * them. Audiences moves into that section, so its own Settings row is not
 * shown. `false` restores the stock Interaction settings screen, the
 * composer starts Public with Everyone, and the Audiences row comes back.
 */
export const PRIVATE_POSTING_DEFAULTS: boolean = true

/**
 * The Public | Private folder tabs on the Notifications settings screen,
 * for members (Phase 3, batch B). Public is the stock screen; Private holds
 * the private notification settings. `false` restores the stock screen
 * with no tabs.
 */
export const PRIVATE_NOTIFICATION_SETTINGS: boolean = true

/**
 * Activity subscriptions for private posts (activity subscriptions design
 * 2.5, the gate): while prism lists `private.activitySubscriptions`, a
 * member's bell dialog adds "Private posts" and "Private replies", which
 * write only to prism (the bell icon lit by any of the four), and Private
 * notifications gain the Activity pill, the "Activity from others" settings
 * row and the client mute filter. `false`: no prism call for subscriptions,
 * two toggles, two pills, five settings rows and no mute filter beyond the
 * stock one. Guards Horizon code only; the public toggles' optimistic save
 * runs either way.
 */
export const PRIVATE_ACTIVITY_SUBSCRIPTIONS: boolean = true

/**
 * The profile Media tab as a grid of square thumbnails (change list item 6,
 * `media-grid/`), 3 or 4 to a row by width, on web and native: a tap opens
 * the post, a post with several images shows a stack mark, spoiler and CW
 * media stay blurred with the compact covers, and a private post carries the
 * corner lock. `false` restores the stock list of posts.
 */
export const MEDIA_GRID: boolean = true

/**
 * The reply block check (`private/api/reply-block.ts`; skydeval,
 * 2026-10-23): before a private reply to another author's post is written,
 * Horizon asks the public AppView (`getRelationships`) for public and list
 * blocks either way between the member and that author, and reads private
 * blocks from prism's serve or the two `tools.kryphocron.graph.block`
 * listings. A block fails the reply as `reply-blocked` with nothing
 * written; a check that cannot be made fails it as `parent-busy`. Public
 * replies are untouched: stock's `resolveReply` already refuses a blocker's
 * post. Once prism lists its list-block fix (feature id to come), the check
 * can be limited to the paths that skip prism's parent read. `false`: no
 * check, and a private reply to a list-blocked author is written as before.
 * Guards Horizon code only.
 */
export const REPLY_BLOCK_CHECK: boolean = true

/**
 * Thread Lens (Phase 4 design, `thread-lens/`): with the reader's toggle on,
 * a public thread is read from prism's `app.nearhorizon.threadLens.*` and
 * every post prism does not show is a placeholder in its place. `false`
 * restores every Thread Lens hook to stock: the stock keys and fetch, no
 * `select` change, no writer routing, no finders, no menu item, no settings
 * group, no rows, no notice, no emitted threadgate, no composer note, no
 * gap-only screens, and the lens gap mark ignored (design 12.1).
 *
 * On since sub-step 4C wired every hook (2026-10-23), as the design's
 * `true`. Live checks (design 14, sub-step 4D) are skydeval's.
 */
export const THREAD_LENS: boolean = true

/**
 * Restored accounts (refract client design RF-1, RF-12; code under
 * `refract/`): accounts Bluesky's AppView withholds that a community prism
 * trusts still hosts, read through prism's `app.nearhorizon.refract.*` and
 * rendered as ordinary content, while prism lists `refract`. RF-12's gate
 * needed prism's deploy reply to name `14c5b57` (fixes A, the not-hosted
 * cache), `5bbd301` (RF-S14, `withheld` `unavailable`) and `c037058`
 * (RF-S16, a DID restored after the snapshot answers `pending`) as deployed.
 * It was met on 2026-10-23: prism.nearhorizon.app runs `839e8ed`, which
 * carries all three with `b87c39d` (`withheld`, `servedAs`, `viewerChecked`),
 * then `53128b9` (RF-S15 and the parallel profile walk)
 * (`docs/internal/handoff/prism-refract-client-fixes-deployed.md`). `false`:
 * no refract call, and every hook keeps Bluesky's behaviour.
 */
export const REFRACT: boolean = true

/**
 * C-8, decided by skydeval on 2026-10-23: "show community labels to everyone
 * who is a horizon member". `true` means on for members: for a Horizon member
 * (`getMembership(did) === 'member'`), a restored view whose marker carries
 * `labeler` is moderated with that labeler added for that view only, whether
 * or not the reader subscribes, with its definitions from
 * `app.bsky.labeler.getServices` cached for an hour (`refract/labeler.ts`,
 * RF-B9). A non-member keeps stock moderation, which honours the community's
 * labels only for readers who subscribe to that labeler. `false` is stock
 * moderation for everyone.
 *
 * For later: when Horizon's own labeler is created, its labels default to
 * warn, never hide.
 */
export const REFRACT_COMMUNITY_LABELER: boolean = true

/**
 * The per-account TID clock (Phase 5 design, Appendix A; `tid-clock/`): every
 * client-made rkey and saved-feed id is minted with a random clock id and a
 * counter of the account's own per page load, so accounts used in one page
 * share neither. `false` makes `nextTid` and `nextTidStr` return stock's
 * `TID.next` and `TID.nextStr`, for bisecting only.
 */
export const PER_ACCOUNT_TID_CLOCK: boolean = true

/**
 * Pronouns (Phase 5 design section 10; `identity/`): the
 * `app.nearhorizon.actor.pronouns` record read for every account (prism's
 * S-2 for others, the own PDS for one's own) and shown on every site, and
 * the pronouns editor. `false`: every pronouns hook renders nothing and no
 * pronouns record is read or written.
 */
export const PRONOUNS: boolean = true

/**
 * Plural display (Phase 5 design section 10; `identity/`): the plural
 * profile (badge, member list, front indicator, header) and fronters on
 * posts. `false`: the account as stock everywhere and no plural record is
 * read.
 */
export const PLURAL_DISPLAY: boolean = true

/**
 * Identity reads through prism (Phase 5 design PP-20 as amended 2026-10-26;
 * `identity/reads.ts`): other accounts' pronouns and plural records come
 * from prism's batch read first, and from each author's own repo whenever
 * prism gives no answer. `false`: prism is never asked (no S-2 call and no
 * S-2 token), and every account's records are read from its own repo, as a
 * client with no AppView of its own.
 */
export const IDENTITY_PRISM_READS: boolean = true

/**
 * Plural editing (Phase 5 design section 10, 7.2, 7.3; `identity/edit/`):
 * the Plurality tab in Edit Profile (system, members, set up and remove)
 * and the front switcher. `false`: Edit Profile as stock and no plural
 * record is written.
 */
export const PLURAL_EDITING: boolean = true

/**
 * Posting as (Phase 5 design 8, section 10; `posting-as/`): the composer's
 * "Posting as" control (the signed-in accounts, and the chosen account's
 * members when it has a system), the fronters written on public and
 * kryphocron posts, the front update after a public post with members, and
 * posting from another signed-in account through a temporary client.
 * `false`: the stock composer avatar, no fronters key written, no front
 * update, and every post goes from the current account.
 */
export const POSTING_AS: boolean = true

/**
 * Act as another signed-in account on like, repost and follow (Phase 5
 * design 8.6, section 10; `posting-as/act-as.ts`): with more than one
 * account signed in, a long press on the like and follow buttons, and
 * "Like as...", "Repost as..." and "Follow as..." in the post and profile
 * menus, open the account list; the action runs through that account's
 * temporary client and leaves the current account's shadows alone.
 * `false`: stock like, repost and follow.
 */
export const ACT_AS_CONTROLS: boolean = true

/**
 * "Suggested for you" on profile pages (skydeval, 2026-10-25): the row of
 * suggested accounts in a profile's posts and the panel that opens under the
 * header after Follow. `false`: neither shows, and the suggestions aren't
 * requested. The home feed's suggestions are unchanged.
 */
export const PROFILE_SUGGESTED_FOLLOWS: boolean = false

/**
 * System accounts (system accounts design SA-16, section 10;
 * `system-accounts/`): the "System accounts" section in Edit Profile's
 * Plurality tab (add by signing in as the account, remove, re-verify, the
 * registered account's own status), the list kept on prism and cached on
 * the device, and system-account sessions, so Posting as and Act as offer
 * the current account and its registered system accounts. `false`: no
 * section and no prism call, and Posting as and Act as offer the current
 * account only (members still), never the other switcher accounts (S-1).
 * On for testers since prism serves SP-1 (`account.systemAccounts`,
 * 2026-10-25); a prism without it answers 501 and the section says the
 * feature isn't available.
 */
export const SYSTEM_ACCOUNTS: boolean = true

/**
 * Development builds only, off by default: the five system-account methods
 * are answered by an in-memory stand-in for prism
 * (`system-accounts/prism-stub.ts`), so the section and the registration can
 * be tried before SP-1 is deployed. Ignored outside `__DEV__`.
 */
export const SYSTEM_ACCOUNTS_DEV_STUB: boolean = false

/**
 * Development builds only, off by default (refract client design 11.3): the
 * seven refract methods are answered from synthetic fixtures
 * (`refract/dev-fixtures.ts`), so the screens can be checked without reading
 * a real account. Ignored outside `__DEV__`.
 */
export const REFRACT_DEV_FIXTURES: boolean = false
