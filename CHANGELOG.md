# Changelog

All notable changes to Horizon, in the spirit of [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/), grouped by development
phase, newest first. Horizon has no released version yet.

## [Unreleased]

Phase 6, optimisation, branding and tweaks, is under way.

### Added

- **Patch notes** at nearhorizon.app/patch-notes and in Settings → About:
  what each release brings, sorted into new Horizon features, features from
  Bluesky's app, and fixes. The Android download page shows the latest
  release's notes.
- **The moderation inbox,** from Bluesky's app: your reports and moderation
  decisions about your account, in Settings → Moderation.
- **Saved images keep the same file name** every time, and Android saves
  them to a Horizon album.
- **Spoiler and content warning buttons in the Android app's composer,**
  as on the web.
- **Push notifications in the Android app,** from Horizon's own push
  service. It only tells your phone to check; the app fetches your
  notifications with your own sign-in, so your push settings, mutes and
  blocks apply. DMs and private notifications are checked about every 15
  minutes, and whenever something else wakes the phone.
- **Android downloads at [nearhorizon.app/download](https://nearhorizon.app/download),**
  with update checks through Obtainium.
- **A switch to turn Bluesky's moderation off.** Adults can turn off "Use
  Bluesky's moderation"; takedowns, your country's legal labelers,
  self-labels and the labelers you subscribe to all stay.
- **Age checks in the Android app, only where a state law requires them.**
  In those US states the app asks Google Play for the user's age range. Web
  and everywhere else never check, and Horizon never asks for ID, a selfie
  or a birthdate itself.
- **Link cards in Discord and other chat apps,** with the author, text,
  quote, media and counts. A private post's link always shows a plain
  "Private post" card.
- **Descriptions for your avatar and banner,** added in Edit Profile and read
  out by screen readers. They use the open
  [atproto-profile-alt](https://github.com/skydeval/atproto-profile-alt)
  format, so any app can show them.
- **Thread Lens shows your labelers' labels,** and **restored accounts appear
  in search.**

### Changed

- **Horizon's own look:** a sun-and-hills logo, the "Horizon" wordmark, new
  favicons and a meadow welcome screen replace Bluesky's butterfly and
  clouds. Icons throughout now come from Phosphor Icons.
- **Share links open Horizon** instead of bsky.app.
- **Sharper backdrop swatches,** and the Gutter phone frame is now **Sides**.
- **Audience lists are private:** only you see who is on them.
- **A private post's settings button shows who can see it** as well as who
  can interact.
- **Quieter screens:** no Trending on Discover, no "Suggested for you" on
  profiles, no "Liked by …" row under posts (on trial), and no badge on reply,
  quote and mention notification avatars.
- **"AppViews"** is written as one word.
- **Merged Bluesky's social-app up to 1.136.0,** including profile links,
  which never preview payment or support links.

### Fixed

- **Videos in the Following feed no longer go black partway through,** and
  the feed no longer flashes and reloads while you scroll.
- **Only your own country's legal labelers apply on web.**
- **Signing in with a handle works when it's typed or pasted loosely.**
- **Notifications on web:** pills no longer go blank or slide under the
  header, and the bell no longer vanishes in Firefox for Android.
- **Quotes:** restored quotes survive a refresh, and quotes of deleted posts
  say "Deleted" at once.
- **Private replies from some people no longer vanish.**
- **Threads open faster on web,** and Thread Lens no longer warns on nearly
  every thread that posts may be missing.
- **The centre column no longer jumps** when posts load or the lightbox opens.
- **Menus on web** no longer lock scrolling, and Enter fires an item once.

## Phase 5: Pronouns and plural systems (2026-10-23 – 2026-10-26)

Pronouns and plural systems for every account, members and fronters on
posts, system accounts, and posting or acting as another of your accounts.

### Added

- **Pronouns beside every name,** on posts, profiles and hover cards, falling
  back to Bluesky's pronouns field.
- **Plural systems on profiles:** a system badge opens the member list, and a
  front indicator shows who is fronting.
- **Fronters on posts:** a post can record which members wrote it and shows
  their names, each with a dot in the member's colour.
- **Editing pronouns and a system** in Edit Profile, with a Plurality tab, a
  member editor with accessible emoji and colour pickers, and a front
  switcher.
- **Posting as:** post from another of your accounts, or choose which members
  wrote a post, from the composer's avatar.
- **Act as:** long-press like or follow, or use "Like as…", "Repost as…" or
  "Follow as…", to act from another account without switching.
- **System accounts:** list the other accounts in your system, each proved by
  signing in as it.

### Changed

- **Pronouns and systems still show** when Horizon's server can't answer.
- **Fronters read as a list:** "Wren, Sparrow & Robin".
- **Posting as** sits where the composer's avatar was, reads clearly to
  screen readers, and offers only your system accounts.

### Fixed

- **The front switcher is always reachable** on your own profile.
- **The account menu no longer crashes the app on web**, and adding a system
  account no longer goes blank.
- **A private draft never comes back Public by mistake.**

### Removed

- **Bluesky's device and session analytics headers.**

## Phase 4: Thread Lens (2026-10-23)

A public thread keeps its whole shape around posts hidden by blocks or
deleted, with a labelled placeholder in each gap, for every signed-in reader.

### Added

- **Thread Lens** keeps a thread's shape when blocks or deletions cut it,
  with labelled placeholders such as "Post from someone you've blocked" or
  "Deleted post". No placeholder names the hidden author.
- **A Thread Lens toggle** in a thread's options and in Settings > Thread
  preferences.
- **A composer note** when someone higher up the thread has blocked you.

### Changed

- **Thread Lens opens faster.**

### Fixed

- **The toggle is per account**, and a list block names its list.

## Refract (2026-10-23)

Restored accounts: accounts Bluesky's AppView no longer serves can appear in
Horizon and be replied to.

### Added

- **Restored accounts look like any other account** in profiles, feeds,
  threads and quotes. Horizon members can also like, repost, quote and follow
  them.

### Fixed

- **A restored profile no longer flashes "Account has been suspended"**, and
  your reposts of restored posts show on your profile.

## Phase 3: Backdrops and themes (2026-10-19 – 2026-10-23)

Backdrops behind the app on every screen size, with light, dim and dark as
glass over them, and appearance that follows the account.

### Added

- **Backdrops:** pride flags, materials, nature, skies, colour blobs, calm,
  seasonal, space, gems and aesthetics, or a custom solid, two-tone or striped
  colour with faint patterns and presets.
- **Glass themes:** with a backdrop, the side cards are frosted and keep their
  text readable. On phones the header, tab bar and drawer show the backdrop.
- **Backdrop softness** for dim and dark, and optional **film grain** on web.
- **Your appearance can follow your account,** saved privately and synced,
  saved publicly, or kept on this device only.
- **Hover hints on the composer toolbar** on web.

### Changed

- **"App servers" became "App views"** in Settings.
- **"Phone frame" shows only on small or touch screens.**

### Fixed

- **Long pinned-feed lists, Notifications and the desktop rails** display
  properly with a backdrop.

### Removed

- **The nine solid backdrops,** now covered by custom colours; saved choices
  carry over.

## Phase 2: Private posting (2026-10-18 – 2026-10-23)

Horizon members write and read private posts, limited to an audience they
choose, beside public ones across the app, with spoiler tags, media spoilers
and content warnings for everyone.

### Added

- **Private posts (kryphocron).** Members get **Public | Private** in the
  composer, and only the audience you choose sees a private post. Replies in
  a private conversation stay private.
- **One drop-down for who can see, reply and quote,** which can also change a
  private post's settings later.
- **Private posts everywhere:** with images, video and link cards, in
  Following, a profile's Private tab, threads, search and Saved, each with a
  lock, and with likes, reposts, quotes and bookmarks.
- **Public | Private tabs** on Notifications, Saved and notification settings.
- **Audiences and posting defaults** in Settings under "Interaction settings".
- **Private posting from any server,** not only Horizon's.
- **Private posts feel instant;** one that fails waits in **Unsent** to retry,
  edit or discard.
- **Replies across a block are refused,** without saying who blocked whom.
- **Spoiler tags** for everyone: `||secret||` or `>!secret!<` covers text
  until pressed, including spoilers written in other apps.
- **Media spoilers and content warnings** cover images, video and text until
  revealed.
- **The profile Media tab is a grid.**

### Changed

- **A private post reads "Private · <audience>",** and the Everyone audience
  is called "Horizon members".

### Fixed

- **Sign-in no longer hangs** when another Horizon tab is open.
- **Refused uploads explain themselves.**
- **Quoted private posts keep their spoilers and content warnings.**
- **YouTube embeds play on web.**

## Phase 1: Login and server wiring (2026-10-14)

OAuth sign-in beside the password sign-in, signup on any server, and the two
AppViews Horizon talks to: Horizon's own, always connected, and a public one.

### Added

- **OAuth sign-in on web,** beside password sign-in.
- **Signup with a server picker:** Horizon's server, Bluesky, or any other.
- **App servers in Settings:** Horizon's own and a public AppView.

### Changed

- **Signing out also ends the session at the server.**

### Fixed

- **Password-only screens and failed OAuth sign-ins** recover cleanly.

## Phase 0: Foundations (2026-10-13 – 2026-10-14)

Bluesky's social-app as Horizon's base, with Bluesky's telemetry and age
assurance switched off.

### Added

- **Horizon is built on Bluesky's social-app** (MIT).

### Changed

- **Bluesky's beta features are on,** and Settings no longer shows "Send
  error report".

### Removed

- **Usage metrics and error reporting to Bluesky,** and **Bluesky's age
  assurance**.
- **Artwork not covered by Bluesky's MIT license.**
