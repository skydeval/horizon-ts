# src/horizon

All of Horizon's own code. Bluesky's code lives everywhere else in this tree
and is merged from upstream once for every Bluesky release, so Horizon keeps
its logic here and touches Bluesky's files only through small, marked hooks.

| Path | What it is |
|---|---|
| `index.ts` | Side-effect-free barrel: re-exports branding and switches. |
| `switches.ts` | Fixed booleans that hooks guard on. Flipping one restores Bluesky's behaviour at that hook. |
| `preview.ts` | A preview build's origin (`EXPO_PUBLIC_OAUTH_CLIENT=preview` with `EXPO_PUBLIC_PREVIEW_ORIGIN`), read by the OAuth client mode and the private share links; `undefined` in every other build. |
| `flags/` | The local feature-flag table that replaces Bluesky's GrowthBook fetch. |
| `telemetry/` | The no-op metrics client. |
| `branding/` | The product name. `product.json` is its one source. |
| `session/` | Session logic: the OAuth client, its metadata and transport, OAuth bundles and accounts, kind dispatch, refresh, sign-out, session death, cross-tab adoption, Horizon's device keys, and the Horizon session provider. No UI. |
| `auth/` | Sign-in, callback, in-place sign-in, password gate and signup UI, and `HorizonHost`. |
| `routing/` | The public AppView choice and switcher, the prism clients, the routing table, membership (asked of prism's `app.nearhorizon.actor.getMembership`, with the Phase 2 probe and its private-timeline fallback for a prism without it; persisted per account with prism's features in a v2 device record, `membership-record.ts`, and re-checked at every start and on a private 501 `MethodNotImplemented`), the per-account feature store (`features.ts`: `servesFeature`, `servesFeatureForWrite`), and the current-clients record that code outside React reads. |
| `lexicons/` | Hand-written schemas for the kryphocron procedures and records (`tools.kryphocron.*`) and prism's private reads and `requestRecord` (`app.nearhorizon.*`), until generated ones exist; the appearance record (`appearance.ts`, `app.nearhorizon.actor.appearance`); the private posting defaults record (`posting-defaults.ts`, `app.nearhorizon.actor.postingDefaults`); and Horizon's own spoiler facet features (`richtext.ts`, `app.nearhorizon.richtext.facet#spoiler`, `#spoilerMarker` and `#contentWarning`), which the private record's closed facet union lists, with the per-item media spoiler flag (`app.nearhorizon.spoiler`) on the private image, gallery item and video objects. |
| `spoilers/` | Spoiler tags, both tiers: the feature constants (`nsid.ts`), the one `\|\|...\|\|` parser (`parse.ts`), the write pipeline (`build.ts`, `write.ts`: markers kept in the text with `#spoilerMarker` facets on public posts and, until prism answers `private.embeds` in this run (`privateFacetsServed`), on private ones; stripped from private posts after; the composer's count), local detection of a served private text's markers (`local.ts`), whole-post content warnings (`content-warning.ts`: the CW line, then the body as one block spoiler with `#contentWarning`; the composer's count; local detection of a keep-mode CW by its shape), the render layout (`layout.ts`: hidden markers, inline covers, block drawers, compact renderings) and its state (`state.ts`), the renderer (`SpoilerRichText.tsx`, `InlineSpoiler.tsx`, `SpoilerDrawer.tsx`), the composer's reply preview found by URI in the cache (`ReplyToText.tsx`, `reply-preview.ts`), the video card's placeholder text (`plain.ts`), the CW line drawn as a warning with its "CW:" prefix, found by its CW span or by the record's CW self-label through the texts the post sites mark (`cw-line.ts`, `ContentWarningLine.tsx`), the web composer button and editor command (`SpoilerButton.tsx`, `editor.ts`), and spoilers from other apps (change list item 2): the texts the post sites build from a record (`post-texts.ts`, marked by `withContentWarningRecord`, or `asPostText` for the DM share preview), the strict rule and the conversion to keep-mode facets beside the record's own (`other-apps.ts`), the account's choice for the renderers with the `RichText` hook `useOtherAppSpoilers` (`other-apps-setting.ts`), and its sync and the Content and media row (`OtherAppSpoilers.tsx`). |
| `media-spoilers/` | Per-item media spoilers and whole-post content warnings (2J): the flag and the `app.nearhorizon.cw` self-label with the B-MS1 and B-MS2 fallback constants (`nsid.ts`), the two switches as functions (`switches-read.ts`), the composer's flags and CWs by image `source.id`, video `abortController` and post id (`compose-store.ts`), the flags, the CW text and the CW label at publish (`write.ts`, both tiers), the draft table on this device (`drafts.ts`), the composer controls (`ComposerControls.tsx`: the "Mark as spoiler" checkboxes, the thumbnail badges, the CW toggle and the CW line), and the rendering: the flags of a media view paired with the record by index, failing closed (`read.ts`), the scope around one media embed with reveals kept by thumbnail and the autoplay hold (`MediaSpoilerScope.tsx`), the cell that wraps a stock image or video cell and makes it inert while covered (`MediaSpoilerCell.tsx`), the blurred cover, the video card pill and the DM note (`MediaSpoilerCover.tsx`), the lightbox filter (`lightbox.ts`), the reply preview's images (`reply-preview.ts`), and the CW self-label's name and description in the labels UI (`label-strings.ts`). A CW post's text is drawn by the spoiler renderer (`spoilers/layout.ts`: CW spans). |
| `media-grid/` | The profile Media tab as a grid (change list item 6): which feed, 3 or 4 tiles to a row, and a post's tile from its embed view (`grid.ts`), and the rows, tiles and placeholder drawn by the stock `PostFeed` through its video grid rows (`MediaGrid.tsx`: square thumbnails linking to the post, the stack mark, the moderation mask, the media spoiler blur and pill, the corner lock of a private post). |
| `backdrops/` | Backdrops (Phase 3): the types (`types.ts`), the registry and the Custom entry (`registry.ts`, with `resolveBackdrop`): 1.0's flags and materials, the flags, Nature palettes, Skies (with "Time of Day", `skyForHour`) and Colour blobs of change list 2, the flags, Calm, Seasonal (with "Follow the season", `seasonForMonth`), Space, Gems and Aesthetics collections and the custom stripes of change list 3, and `REMOVED_SOLIDS` with `migrateRemovedSolid`, which reads a stored id of one of the nine removed solids as a custom one-tone of its colour; the local hour for Time of Day, armed only while followed and switching once per hour (`hour.ts`); the local month for Follow the season, the same way, checked once a day after midnight (`season.ts`); the Starfield's fixed seeded stars, one SVG tile built once on web and the same circles as an SVG pattern on native (`stars.ts`); the static film grain tile, drawn once into a canvas on web (`grain.web.ts`; none on native, `grain.ts`); a one-tone's quiet pattern tiles (`layers.ts` `PATTERN_TILES`, coloured by the compiler against the base, drawn as texture over the gradients by both painters); 1.0's stripe and bloom builders (`stripes.ts`), a def's layers as 1.0's spec or as 1.0 drew them (`layers.ts`) chosen by `BACKDROP_LOOK` (`look.ts`, `'seen'`), the pure compiler (`compile.ts`: tuning, opacity, corner and angle directions, radials) and its two painters, the layered CSS background for web (`css.ts`) and `react-native-svg` for native (`CompiledSvg.tsx`), the theme's glass with the adaptive alpha for 4.5:1 rail text and the reduced-transparency floor (`glass.ts`; nothing is blurred live), the pale-swatch stretch for dim and dark (`swatch.ts`), whether a backdrop is active, as one stable def per backdrop and softness (`active.ts`), the compile cache per def, theme, softness and size (`compile.ts`) and the memoised layer CSS (`css.ts`), the shared viewport frame (`viewport.web.ts`), and the desktop and tablet pieces: the fixed backdrop layer, promoted and contained, and not drawn below 800px unless Gutter shows it (`BackdropLayer.web.tsx`, `fixedLayerDrawn`), the opaque reading surface (`ReadingSurface.web.tsx`), the rail and nav cards, each painting the backdrop into itself under the glass and growing outward around its content so a backdrop on or off never moves it (`RailCard.tsx`, `cardShape`, `RAIL_CARD_OUTSET`; change list 2), the shell's hook (`shell.ts`) and the navigation values (`nav.ts`); and the compact frame below 800px: when a window is drawn, its glass and shape, the bare windows of Bars and of Header's top bars with each item's shade (kinds, shapes, the 3:1 alpha over the part of the backdrop a window shows, the CSS custom properties a bare window sets on its piece, `barShadesOn`) and the Home header's two value hooks (`frame.ts`), the one shared tracker that keeps every window aligned with the fixed layer: one listener per trigger, one animation frame that reads every window then writes those that moved, hidden windows skipped, animation ends only for the drawer, rail cards read only on layout changes (`frame-tracking.ts`), the minimal-shell triggers (`ModeTrigger.tsx`), the windows of the Home header, sticky headers, bottom bar and drawer (`FrameWindow.tsx`), the shades themselves and the header slot and title hooks (`BarShade.web.tsx`; `BarShade.tsx`, native, stock), the four phone frame styles Bars, Edges, Gutter and Header, picked per device by "Phone frame" while `SHOW_FRAME_STYLE_PICKER` (`frame-style.ts`, with the lenient parse; the retired Buttons reads as Bars; offered below 800px or on a touch-first device, `offersFrameStylePicker`, with `coarse-pointer.ts`/`.web.ts` following `(pointer: coarse)` live), their painters (`BackdropWindow.web.tsx`, a raw `div` at `z-index: -1` clipping a viewport-sized gradient layer moved by a transform; `BackdropWindow.tsx`, native, `measureInWindow` and `CompiledSvg`; both paint uniform overlays only), the inset reading card of the Gutter style (`inset.ts`), and the dim and dark backdrop softness that the compiler applies to every stop (`softness.ts`). |
| `appearance/` | An appearance (Phase 3): the model and defaults (`model.ts`), the public record `app.nearhorizon.actor.appearance/self` read leniently and written field by field (`record.ts`, schema in `lexicons/appearance.ts`), the device value under `horizon:appearance` with an account copy per DID and the opt-out (`device-value.ts`; `localStorage` on web, MMKV on native: `device-store.web.ts`, `device-store.ts`), the store with the one edit path and the editor's preview (`store.ts`, `useEffectiveAppearance`), the record's reads and debounced, CID-swapped writes (`sync.ts`, driven by `AppearanceSync.tsx` in `HorizonHost` and the native `App.tsx`), the account's colour mode, dark theme, font and font size (change list 2: optional record fields, saved from the stock Appearance screen with `useSaveThemePref` and applied over the stock device settings on account switch by `ThemePrefsSync.tsx`, `theme-prefs.ts`; never copied into the device's own appearance), and the Appearance screen's Backdrops group (`settings/`: the swatches in sections by collection (`picker.ts`) and Custom chip, the one-tone's pattern picker, the Custom card with its editor state, R/G/B rows, the custom stripes' add, remove and reorder (change list 3) and presets, the "Southern hemisphere" switch while Follow the season is selected (device only, `southern` in the device value), the web key handlers, the opt-out "Keep this device's own appearance", "Film grain" (web, device only), "Backdrop softness" with its dim and dark sliders (`SoftnessSlider.web.tsx`, native stepper `SoftnessSlider.tsx`), and the device-only "Phone frame" picker). |
| `composer-hints/` | Hover hints on the composer toolbar buttons (change list 2): the stock tooltip bubble after a mouse rests on a button, never taking focus (`ToolbarHint.web.tsx`; native renders the button alone, `ToolbarHint.tsx`). |
| `settings/` | Settings rows that are not private-only (Phase 3, batch B): the main "Interaction settings" row (`InteractionSettingsItem.tsx`), which opens the stock `/moderation/interaction-settings` screen. |
| `notifications/` | The redesigned notifications' fallback (`grouped-fallback.ts`): a page whose `getGroupedNotifications` request fails with a 5xx or a network error is read from `listNotifications`, grouped on the client with the stock grouping and hydrated by the stock `hydratePage`, so the rows and the five pills render unchanged; a page on the fallback keeps its list there, and a failure holds the grouped request back for five minutes per account and feed. |
| `video/` | The video service's DID and URL in one constant (`service.ts`, read by the stock `VIDEO_SERVICE` and `VIDEO_SERVICE_DID`), and web playback of a non-HLS `playlist` (a private post's MP4 on its author's PDS) as a direct source, its first frame as the poster when there is no thumbnail, and its load errors sent to the stock error fallback (`playback.ts`); the video card's neutral tile for a video without a thumbnail (`NoThumbnailTile.tsx`). |
| `private/` | Private posting: URI helpers, side stores, the server-support table, membership for private features, the write path and local validation (languages and self-labels included), where a private reply goes (`api/reply-anchor.ts`: its thread root or branch root and that anchor's current audience), changing a post's audience in place (`api/update-audience.ts`), reply and quote limits as stock gate records (`api/gates.ts`: written at compose, read and evaluated for readers until prism applies them; `api/gate-guard.ts`: the reply and quote press guard), reply lists (`api/reply-lists.ts`), audiences, the composer's visibility record, its Public \| Private control and the audience drop-down in the pills row (`composer/VisibilityControl.tsx`, `composer/AudienceMenu.tsx`, `composer/interaction.ts`, `composer/useReplyAnchor.ts`), blockers and draft table (with the drafts list's lock on a draft saved Private, `composer/PrivateDraftLock.tsx`), and the Audiences screen. The compose session (`composer/session.ts`: the composer owns the visibility record and starts it from a confirmed member's private posting defaults, applying defaults that arrive late until the record is set otherwise; a quote starts as the quoted post is, Private with the default audience (Everyone while none is chosen) for a private one, Public for a public one, not locked). The private posting defaults (Phase 3, batch B, `defaults/`): the model and the record `app.nearhorizon.actor.postingDefaults/self`, read leniently (a bad audience reads as Only me, never wider; an absent one stays unchosen; a list must be one of the owner's own audience records) and written keeping unknown fields (`record.ts`), the query with a device copy as its initial data and the queued, CID-swapped writes in the account's own repo (`query.ts`), the composer's read, members only (`compose.ts`), and the Interaction settings screen's "Public posts" heading and "Private posts" section with "New posts start as", "Default audience", the reply and quote note and the Audiences link (`InteractionSections.tsx`); the same record's `reading` field holds the account's reading choices, read for every signed-in account (`ReadingSettings`, `useReadingSettingsQuery`, written through the same queue). After posting: the post settings dialog and its menu item (`settings/`: who can see changed in place on a top-level post or branch root and read-only on other replies, who can reply and quote saved as the stock gates). Reading: the adapter (`adapt/`: private views as stock post views and feed items, the author merge, reply hydration, local links and hashtags, embed views and self-labels built from the record), the merge core shared by the Following merge and the profile Posts and Replies merges, its cursor, the owner's Likes tab with liked private posts (`feed/likes-merge.ts`: the owner's like records from their repo, private subjects read through prism, merged in like order with a floor so stock items never wait on pages of public likes), paging through prism's short or empty pages (`feed/paging.ts`), and the profile feeds (`feed/`), private threads with the readers' gate check and the four `ppost` screens (`thread/`), the Private tab (`profile/`), the post query and pasted-link resolver (`links.ts`, whose batched read starts the authors' profile and PDS lookups with `getPosts`), and quoted private posts resolved inside the page fetch (`quotes/`: the persisted quote cache, collecting a page's unhydrated private quotes, and one batched read per page with a two-second deadline, wired into the feed wrappers, the thread query, both Saved lists and the notification subjects). Display (`render/`): the lock (alone, 16px, 14px in a quote's row, at the right end of the post meta row on every rendering but the thread anchor, quotes included, `PrivateHeaderLock` in `PrivateBadge.tsx`) and the anchor's mark, the border helper (uncalled since v2 round 2), the audience label and the anchor's private details, the private quote (with its loading placeholder) and the stand-in, and `controls.ts`, which says what a private post's controls, menu and links leave out. The Public \| Private folder tabs and their per-account mode stores (`tabs/`), used by Notifications (`notifications/`: the tabs and the Private view), the Notifications settings screen (`notifications/NotificationSettingsTabs.tsx` and `settings-mode.ts`: the tabs and the Private settings, disabled until prism serves private notification preferences) and Saved (`saved/`: the tabs and the private bookmarks list); private bookmarks through prism (`api/bookmarks.ts`, with the bookmark press guard `refusesPrivateBookmark`). Following prism's features (2H): the hooks `usePrismFeature` and `usePrismFeatureForWrite` (`features-hooks.ts`), served counts, viewer state, threadgates and audiences read by the adapter into the post facts (with the audience pin of a move), the served gate path of the thread and the press guard, `caughtUp` after a move or a compose (`api/request-record.ts`), repost items of private posts in the merges (`feed/merge-core.ts` `itemKey`), and thread mutes with prism (`api/thread-mute.ts`: private roots on prism, a public root's mute mirrored and re-synced). The 2H screens: the likes, reposts and quotes lists of a private post (`api/interactions.ts`, the stock list components on the `ppost` screens), private thread read-more and continuation and private branches under a public anchor (`thread/fetch.ts`, `thread/replies.ts`, `thread/continuation.ts`), the Private notifications list with the stock rows, its unread counts, the corner lock on a private row (`notifications/page.ts`, `query.ts`, `PrivateNotificationsList.tsx`, `PrivateAuthorRow.tsx`), the Private tab's badge (`tabs/FolderTabs.tsx`), and the list's refresh on re-pressing the Private tab or the selected pill, on switching to Private with something unread, and from the stock "Refresh" pill offered by prism's unread count (`notifications/refresh.ts`), private results merged into the search's Top and Latest (`search/query.ts`, `merge.ts`, `results.ts`, `PrivateSearchNote.tsx`), the post shadow's finder for those lists (`cache-finders.ts`), and the branch walk through prism's thread view (`api/reply-anchor.ts`). |

Modules that import `@atproto/oauth-client-browser` at runtime are `.web.ts`
files with a plain `.ts` sibling exporting the same names for native, where
OAuth is not available yet (`OAUTH_AVAILABLE = false`).

## Switches

`switches.ts` holds every switch, with what it guards. Phase 1 adds
`HORIZON_SIGN_OUT` (Horizon's sign-out sequence in place of the reducer's
push side effect), `IN_PLACE_SIGN_IN` (the in-place sign-in window) and
`SIGN_IN_TABS` (the sign-in description naming both ways). Phase 2 adds
`PRIVATE_POSTING`, `PRIVATE_READING`, `PRIVATE_POST_DISPLAY`,
`PRIVATE_POST_LINKS`, `PRIVATE_NOTIFICATIONS_SWITCH`,
`MEMBERSHIP_PROBE_FALLBACK`, `MEMBERSHIP_QUERY` (the probe asks
`getMembership` first; off, the Phase 2 probe with no features, so every
family but `private` reads as absent), `COMPOSER_AUDIENCE_MENU` (the footer
drop-down in place of the stock interaction pill, and the gate records of a
private compose), `PRIVATE_SAVED_SWITCH` (Saved's Public \| Private tabs
and its private list) and `PRIVATE_SEARCH_SWITCH` (private results in the
search's Top and Latest tabs; off, the stock results); `PRIVATE_POST_DISPLAY` and `PRIVATE_POST_LINKS` only
make sense with `PRIVATE_READING` on. `GROUPED_NOTIFICATIONS_FALLBACK`
guards the grouped notifications query's fallback
(`notifications/grouped-fallback.ts`, hooked in
`state/queries/notifications/grouped/index.ts`); off, a failed grouped
request reaches the screen as in Bluesky. `SPOILER_TAGS` guards spoiler
tags; off, `resolveRT` and the private write produce stock text and facets,
`RichText` renders as stock with the markers visible, the counter reads the
stored length, the button is absent, the editor command does not listen,
the reply preview is the stock `Text`, the video card shows the stock text,
and local detection does not parse markers. Not switched: the private facet
union's spoiler features and their pass-through in the record adapter,
which with the switch off only keep data that stock renders as plain text.
`OTHER_APP_SPOILERS` guards spoilers from other apps (change list item 2),
effective only with `SPOILER_TAGS` on (`otherAppSpoilersAvailable`): off,
the Content and media row is gone, the sync does not read the record, and
`useOtherAppSpoilers` (the `RichText` hook), the reply preview and the
video card text return the post's text unchanged, so its markers show as
typed. Not switched: the `reading` field kept on write, and the marking of
post texts, which only feeds this.
`MEDIA_SPOILERS` guards the per-item media spoilers: off, no checkbox or
badge and no flag is written (a CW's media are not flagged either), every
media scope renders only its children, so no cover, autoplay hold, lightbox
filter or compact blur applies.
`CONTENT_WARNINGS` guards whole-post content warnings, and is effective
only with `SPOILER_TAGS` on (`contentWarningsOn`): off, no toggle or line,
stock or spoiler text, no CW label, and a CW span renders as a plain
spoiler ("Spoiler", "[spoiler]") with media pills reading "Spoiler", the
CW line has no "CW:" prefix, and the labels UI shows the raw label value. Not
switched: the schema additions, the
adapter's pass-through of the flag and `#contentWarning`, and the
structural local detection of a keep-mode CW, which is gated on
`SPOILER_TAGS` so a CW body read without facets stays hidden.
Phase 3 adds `BACKDROPS` (the backdrop layer, the transparent shell root,
the transparent web `contentStyle` and navigation-theme background, the
reading surface, the split-view background, the rail and nav cards and the
Appearance sections; off, every hook returns its stock value: `t.atoms.bg`
roots and `contentStyle`, the input navigation theme, `RailCard` as a
fragment or the stock view, `ReadingSurface`, `BackdropLayer` and
`HorizonAppearanceSections` render nothing, `horizonOpaque` is `undefined`,
and sync does not run), `COMPACT_FRAME_WINDOWS` (below 800px the Home header,
the sticky headers, the bottom bar and the drawer paint the backdrop inside
themselves, as the device's phone frame style picks: all of them with
Bars, the bars bare with a shade under each item (web; native keeps the
glass) and the drawer under the theme's glass, a slim band along the
bars' edges with Edges, the top headers only with Header, bare with their
shades as with Bars and the bottom bar stock, or the drawer and the inset
reading card with Gutter (Buttons, the button lenses, was removed in the
round 2 list; a stored `buttons` reads as Bars); effective only with
`BACKDROPS` on; off, `FrameWindow` and `BarShade` render
nothing, `BarSlot` renders the slot's children only, `useBarTextShade` is
undefined, the inner Home header row is sticky and the Home tab bar paints
`t.atoms.bg`, so compact screens are stock) and `APPEARANCE_SYNC` (reading and writing the
appearance record; Horizon code only; off, the device copy only).
Change list 2's account theme settings follow both: with `BACKDROPS` or
`APPEARANCE_SYNC` off, `useSaveThemePref` saves nothing and
`ThemePrefsSync` applies nothing, so the stock Appearance settings are
device-only as in Bluesky. The composer's hover hints are not switched
(the stock tooltip's `takesFocus` prop, default true, is the only stock
change).
The change list adds `MEDIA_GRID` (the profile Media tab as a grid; off,
`isMediaGridFeed` is false, so the Profile feed section passes the stock
`isVideoFeed` and `PostFeed` draws the stock list).
Phase 3, batch B adds `INTERACTION_SETTINGS_ROW` (the main "Interaction
settings" row; off, the row is gone and the Moderation screen's row is the
only way in), `PRIVATE_POSTING_DEFAULTS` (the Interaction settings screen's
"Public posts" heading and "Private posts" section, the posting defaults
record and the composer starting from it; off, the screen is stock, the
composer starts Public with Everyone, and the Audiences Settings row comes
back) and `PRIVATE_NOTIFICATION_SETTINGS` (the Notifications settings
screen's Public \| Private tabs; off, the stock screen). The settings hooks
read them through `InteractionSettingsItem`, `PublicPostsHeading`,
`PrivatePostsSection`, `AudiencesSettingsItem`, `usePrivateComposeDefaults`
(`defaults/compose.ts`, called by `usePrivateComposeSession`),
`NotificationSettingsTabs` and `usePrivateNotificationSettingsMode`; the
App views rename is in Horizon's own strings (`routing/AppViewSwitcher.tsx`)
and is not switched.
`BACKDROP_LOOK` (`backdrops/look.ts`) and `SHOW_FRAME_STYLE_PICKER`
(`backdrops/frame-style.ts`, true: the "Phone frame" picker) are
constants that choose a variant, not switches. The hooks read `BACKDROPS` through `useActiveBackdrop`
(`useShellBackdrop`, `ReadingSurface`, `BackdropLayer`, `RailCard`,
`FrameWindow`, `BarShade`, `BarSlot`, `useBarTextShade`,
`useInsetReadingGutter`), `horizonContentStyle`,
`horizonNavTheme` and `horizonOpaque` (`nav.ts`), and
`HorizonAppearanceSections`; `FrameWindow`, the shades
(`barShadesOn`), `BackdropLayer` (`fixedLayerDrawn`),
`horizonInnerHeaderSticky` and `horizonTabBarBg` (`frame.ts`) read
`COMPACT_FRAME_WINDOWS` too; `AppearanceSync` and `sync.ts` read both
`BACKDROPS` and `APPEARANCE_SYNC`. `AuthCallbackScreen` paints `t.atoms.bg`
itself (it has no `Layout.Screen`).

The delete guard in `src/state/queries/post.ts` is not switched: the stock
line would delete `app.bsky.feed.post` at a private post's rkey. The route
registrations are not switched either.

Each reading hook calls a helper that reads its switch: `withPrivateKey`,
`withPrivateTimeline` and `horizonFeedApi` (feeds), `isPrivateRead` (the post
query, the thread, the private quote; the page fetches' quote resolution reads `PRIVATE_READING` itself), `isPrivatePostLink` (pasted links),
`postSegment` and `postThreadRouteName` (links and "View post"),
`hidesBlueskyShare` (Embed post and Send via chat), `useShowPrivateTab` (the
profile tab), `isPrivateBookmarkArgs` and `findPrivateBookmarkPosts` (the
bookmark mutation and the post shadow; nothing reaches them until prism
answers `private.bookmarks` in this run, because `refusesPrivateBookmark` in
the stock `usePostBookmark` refuses a private post's bookmark press, from the
button or the menu item, with a toast first), `muteThreadOnPrism` and
`mirrorThreadMute` (the thread mute mutations; the guard is `isPrivateRead`),
`fetchPrivateLikesPage`, `fetchPrivateRepostedByPage` and
`fetchPrivateQuotesPage` (the stock list queries; the guard is
`isPrivateRead`), `withPrivateBranches` and `fetchOtherReplies` (the thread
and other-replies queries; `PRIVATE_READING` inside), and
`findHorizonPrivatePosts` (the post shadow). `toShareUrl`'s guard tests for a `ppost` path,
which only exists while `PRIVATE_POST_LINKS` is on.

Display hooks call the helpers in `private/render/controls.ts`, which read
`PRIVATE_POST_DISPLAY`: `isPrivateDisplay` (the thread stand-in, who can
reply, the menu's public-only items, and Who 1's private settings dialog),
`privateControlsFor` (counts, by the post's `countsServed` fact),
`hidesPrivateStatsRow` (the stats row), `hideThreadMute` (by
`private.interactions` answered in this run), `hidesGateControls` (who can
reply on the anchor, hide reply for everyone; back once prism applies the
gates of a private root) and `hidesDetachQuote` (detach quote of a private
quoted post),
`proxiesPostLinks` (link proxying), `isPrivateBadgeHref` (the lock at the
right end of the post meta row, through `PrivateHeaderLock`), and
`threadRepliesCount` (thread reply lines). `privatePostStyle` in
`render/styles.ts` (the border) has no callers since v2 round 2: its six
hooks were taken out with the border. The drafts list's lock reads
`PRIVATE_POSTING` through `composer/drafts.ts` (`isPrivateDraft`).
The composer hooks read `PRIVATE_POSTING` and `COMPOSER_AUDIENCE_MENU` through
`composer/state.ts`, `composer/interaction.ts` (`hidesStockInteractionPill`),
`composer/blockers.ts` (`privateAssetTypes`) and the pieces in
`composer/VisibilityControl.tsx` (the Public | Private control in the
footer, and the audience drop-down in the pills row where the stock
interaction pill sits). The web player's non-HLS hook reads
`PRIVATE_READING` through `video/playback.ts` (`playsAsDirectSource`). The
video service constant is not switched: its value is the stock one. The
reply and quote press guard (`guardPrivateInteraction`) and the post menu's
private settings item and dialog read `PRIVATE_POST_DISPLAY`. The
notifications hooks read `PRIVATE_NOTIFICATIONS_SWITCH` through
`notifications/mode.ts` and, for the badge, `usePrivateOnlyUnreadCount`; a
notification row's lock (`PrivateAuthorRow`), link proxying and reply guard
read `PRIVATE_POST_DISPLAY`; the search hooks read `PRIVATE_SEARCH_SWITCH`
through `usePrivateSearchResults`; and the Saved hooks `PRIVATE_SAVED_SWITCH` through
`saved/mode.ts`. The spoiler hooks read `SPOILER_TAGS` through
`rendersSpoilers` (`RichText`), `resolvesSpoilers` (`resolveRT`),
`composeGraphemeLength` (the composer's Publish check and counter),
`SpoilerButton` (the footer button), `useSpoilerWrapCommand` (the web
editor), `coversReplyToSpoilers` (the reply preview) and `spoilerSafeText`
(the video grid card). The 2J hooks read `MEDIA_SPOILERS` and
`CONTENT_WARNINGS` through `media-spoilers/switches-read.ts`:
`withMediaSpoilers`, `withContentWarningLabel` and `resolveComposeRT` (the
public `post()` and the private write), `composeGraphemeLength` (the
counter), `ImageSpoilerCheckbox`, `VideoSpoilerCheckbox`, the two badges,
`ContentWarningButton` and `ContentWarningField` (the composer),
`MediaSpoilerScope` (the image and video embeds; the cells, the lightbox
call and the autoplay hold read only what it provides), `hasMediaSpoilers`
and `mediaSpoilerCardBlur` (the notification thumbnails, the video cards,
the DM share preview), `MediaSpoilerPill`, `useReplyToMediaCovered` (the
reply preview's images), `visibleSpoilerText` (CW spans in the text
renderer and the video card text), `cwLineEndOf` and
`rendersContentWarningLine` (the CW line's prefix; the post sites' calls to
`withContentWarningRecord` only mark the text), and
`horizonGlobalLabelStrings` and `horizonLabelStrings` (the self-label's
name). The store
calls (`useComposeSpoilerSession`, `useComposeSpoilers`,
`bindRestoredVideoSpoiler`, `applyDraftSpoilers`, `recordDraftSpoilers`)
and the video key's context hold state that stays empty while the switches
are off.

## Server support

`private/server-support.ts` is not a switch table. prism's support is read
at run time, per account, from the feature families its membership query
answers (`routing/features.ts`, 2H design 4): `privateFacetsServed`
(`private.embeds`), `privateBookmarksServed`, `privateGatesServed`,
`privateInteractionsServed`, `privateNotificationsServed`,
`privatePagingServed`, `privateSearchServed` and `threadAudienceServed`,
each with `{forWrite: true}` for a decision that writes (this run's answer
only; a list read from the device never unlocks a write). A field prism
serves on a view (counts, viewer state, threadgate, audience, repost reason,
embed) is used when present, whatever the list says. Without a list (a
prism without the membership query, or never answered) only `private` is
served. A change of the list for the current account invalidates every
query once.

The constants that remain name a dependency no feature family covers;
flipping one moves a private feature from its interim behaviour to its
intended one. On (kryphocron-lexicons 0.3.1 and locus): `PRIVATE_VIDEO`
(K-6, A-11), `PRIVATE_GALLERY` (K-7), `PRIVATE_LANGS_LABELS` (K-1),
`PRIVATE_QUOTE_WITH_MEDIA` (K-2), `PRIVATE_MEDIA_EXTRAS` (K-4),
`PRIVATE_AUDIENCE_CHANGE` (A-9, A-13, A-1). Off: `AUDIENCE_EDIT` (A-4).

`private.mediaFilters` (P-30, `privateMediaFiltersServed`) unlocks the
profile Media and Videos merges (change list item 4, `feed/legacy.ts`,
`feed/author-merge.ts` with `media` and `video`); without it those tabs
are public-only.

What each family unlocks: `private.interactions` the likes, reposts and
quotes lists of a private post (`api/interactions.ts`, through the stock
list queries) and thread mutes; `private.paging` the author-feed filter,
replies past a private thread's first read and private branches under a
public post (`thread/replies.ts`); `private.notifications` the Private
notifications list, its unread counts and mark-seen
(`notifications/page.ts`, `query.ts`); `private.search` private results in
the search's Top and Latest tabs (`search/`); `private.threadAudience` the
move warning without its interim line.

## Hook rules

A hook is any edit to a file that came from Bluesky.

1. A hook is an import plus a single call, value, guard or component. Logic
   stays in `src/horizon/`.
2. Every hook carries a marker on the line above it:
   - TypeScript and JavaScript: `// HORIZON: <why>`
   - inside JSX: `{/* HORIZON: <why> */}`
   - HTML and Markdown: `<!-- HORIZON: <why> -->`
3. Prefer guarding Bluesky's code with a switch from `switches.ts` over
   deleting it, so imports stay used and an upstream merge sees one line.
   Where code must go, the imports only it used go in the same hook.
4. Bluesky's types are not widened. Horizon data travelling with a Bluesky
   object lives in a side store keyed by URI or DID.
5. A Bluesky file is never forked into a Horizon copy.
6. New user-facing text goes through Lingui.

Hooks must keep `pnpm typecheck`, `pnpm lint` and `pnpm test` passing.

## Hook ledger

From `horizon-ts/`:

```
git grep -n "HORIZON:"
```

Matches under `src/horizon/` are this file and are not hooks. Add the list
below to that output for the complete ledger.

### Hooks without markers

| Hook | Why it has no marker |
|---|---|
| Deleted `assets/kawaii.png`, `assets/kawaii_smol.png` | Community artwork not covered by MIT (`ASSETS.md`). Deleted files carry no marker. |
| Deleted `assets/illustrations/illustration-mobile.png`, `illustration-mobile-dark.png`, `README.md` | Commissioned illustration not covered by MIT (`ASSETS.md`). |
| `package.json`: `"@atproto/oauth-client-browser": "0.5.4"` | JSON has no comments. The OAuth library, pinned exactly like the other `@atproto/*` packages. |
| `pnpm-lock.yaml` | Follows `package.json`. |

New files that are not hooks (Horizon's own, outside `src/horizon/` because
they must be served from the site root): `public/oauth-client-metadata.json`
(the production OAuth client document) and
`public/oauth-client-metadata-dev.json` (the hosted development document).
A unit test keeps each equal to the document built in
`session/oauth-metadata.ts`. `scripts/horizon-preview-pages.js` (Horizon's
own, beside Bluesky's build scripts) turns a preview build's `dist/` into a
Cloudflare Pages upload: the preview's client document, `_redirects`,
`_headers`, no source maps; a unit test keeps its document equal to
`createPreviewClientMetadata`.

### Literal copies of the product name

`branding/product.json` is the name's one source. These files cannot import
it and carry the name literally; a rename updates them too.

- `public/index.html`: `<title>`, the meta description, the `<noscript>` text.
