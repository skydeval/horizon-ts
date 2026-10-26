# Changelog

All notable changes to Horizon, in the spirit of [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/), grouped by development
phase, newest first. Horizon has no released version yet.

Convention: new entries go under `## [Unreleased]` and move into a phase when
that phase closes. Entries say what changed for users; they carry no tracker
references.

## [Unreleased]

Work since Phase 4 closed. Phase 5, pronouns and plural systems, is built on
web and waiting on its live checks.

### Added

- **Pronouns beside every name**, for everyone, signed in or out, member or
  not: muted after the handle on post author lines (in feeds, threads, quotes
  and notifications), and below the name on the profile and the hover card.
  Several sets are joined with a middle dot ("she/her · they/them"), as typed,
  and the account chooses to show all of them or the first only. An account
  with no pronouns record shows Bluesky's short pronouns field instead. Until
  Horizon knows an account's answer it shows nothing, rather than guess. Other
  accounts' pronouns and systems are read from prism in batches, warmed as
  each page arrives, so readers' browsers never contact the authors' servers;
  your own come from your own PDS.
- **Plural systems on profiles.** A system badge under the handle (the
  system's name, or its collective noun, or "Plural system", with the member
  count) opens the member list: each member's avatar, emoji, colour, name,
  pronouns, roles, member types, age presentation, proxy note and description,
  with those in front marked. A front indicator beside it shows who is
  fronting, their statuses and the comment, or "Nobody fronting". With one
  member fronting, the profile header shows that member's name, avatar, banner
  and pronouns in place of the account's. The handle, badges and verification
  always stay the account's, and the web hover card is always headed with the
  account.
- **Fronters on posts.** A post can record which members wrote it, and then
  shows their names with a dot in each member's colour (and, for one member,
  that member's avatar and pronouns), in feeds, threads, quotes,
  notifications, Thread Lens, restored posts and private posts; the handle
  stays the account's. A post that records no one shows the account, and a
  post never shows whoever happens to be fronting later. Names are looked up
  live, so a renamed member never keeps an old name on old posts. Screen
  readers hear the names in words. On private posts, fronters show once prism
  serves them.
- **Editing pronouns and a system, in Edit Profile.** A pronouns field under
  the description: one row per set, preset chips (she/her, he/him, they/them
  and more), and "Show all" or "Show first only", and "Show no pronouns". A
  new Plurality tab: "Set up a plural system", the system's name, description,
  collective noun and member count, and its members, with Add member. The
  member editor covers display name, pronouns, description, emoji, colour,
  roles, member types, age presentation, proxy, avatar and banner, with
  suggested roles (host, protector, caretaker, memory holder) and member types
  (fronter, co-fronter, non-fronter) as chips, and any value can be typed.
  "Remove plural system" asks first. A front switcher (from the front
  indicator, "Set front" on your own profile, the Plurality tab or the
  composer) picks members, gives each a status, and sets the state and a
  comment. A new member's id is a random TID, written create-only, never
  derived from its name. The member list's Edit opens Edit Profile on the
  Plurality tab.
- **Pronoun limits** follow the updated lexicons, for accounts and members
  alike: up to 10 sets, 12 forms per set, and 24 characters (240 bytes) per
  form.
- **The member editor's emoji and colour pickers.** Emoji come from the
  composer's picker on web and the system picker on iOS and Android. Colour
  has an accessible preset radio group (arrow keys move between presets), the
  browser's colour picker on web, and hue, saturation and lightness sliders.
  Every control has a name and state, changes are announced, and focus is
  handled throughout.
- **Member images:** a member's avatar and banner may be WebP. When the image
  CDN can't serve one, your own members' images fall back to your own PDS, and
  anyone else's member shows the account's own image; another author's PDS is
  never asked.
- **Posting as.** With more than one signed-in account, or a system, the
  composer's avatar becomes a Posting as control ("Posting as @handle, change
  account or members"): "Post from" any signed-in account without switching (a
  toast confirms "Posted as" that account), and "Members of" the chosen
  account, ticking up to 20 members (none means the account itself; it starts
  on the members fronting), plus "Edit front…". After a public post with
  members chosen, they become fronting; if that fails, the post still goes,
  with "Posted. The front couldn't be updated." and Try again. The rules for
  switching accounts keep each account's things its own:
  - Public or Private never changes on a switch.
  - A private post needs an audience picked from the new account's audiences;
    Post stays disabled until one is chosen, with the note "Choose an audience
    for @handle. Audiences belong to the account that posts."
  - Audiences, lists and reply and quote settings belong to the posting
    account, and a list owned by another account is refused at publish.
  - Members never carry over from one account to another, and a private post
    never changes the public front.
  - Post holds until the new account's settings, front and members have
    loaded, and stays blocked with Try again if a read fails.
  - Reply checks run for the posting account, a video attached keeps the post
    on the current account, and drafts keep their account.
- **Act as.** With more than one account signed in, long-press like or follow
  (a half-second hold on web), or choose "Like as…" or "Repost as…" in the
  post menu or "Follow as…" in the profile menu, to open "Choose an account to
  act as": a list of your other accounts. Each row shows that account's own
  state (Liked, Reposted, Following, "Can't see this post", "Blocked") and
  toggles it, undo included. Repost has no long press, because on native that
  already quotes, and Follow as is on the profile header and menu only. The
  record goes into that account's own repo, and your current account's like,
  counts and follow button don't move. A private post can be liked or reposted
  as another account only when prism serves it to that account.
- **System accounts.** In Edit Profile's Plurality tab, a "System accounts"
  section keeps a list of the other accounts in your system. Add one by its
  handle and prove it's yours by signing in as it, in a pop-up window or with
  an app password (an installed phone web app offers the app password only).
  The sign-in doesn't add the account to the account switcher or change the
  account you're browsing as. The list is private on prism, readable only by
  you and synced across your devices; the sign-in stays on the device, with
  "Sign in on this device" on another one. Remove puts a row back if prism
  can't be reached. Signed in as a registered account, its own Plurality tab
  says whether some account can post as it, with "Leave every system".
  Status changes are announced to screen readers on every platform. The
  `SYSTEM_ACCOUNTS` switch is on.
- **Thread Lens shows your labelers' labels:** it sends your chosen labelers
  to prism, takes their labels from its answer and merges them with the public
  AppView's, without repeats. A labeler's hide makes the post a placeholder.
- **Restored accounts in search:** they appear in the search typeahead and in
  People results: an exact handle first, other matches after Bluesky's own.
  Bluesky's results never wait for them.
- **The public design page says what visitor viewer state shares:** for
  readers who aren't members, prism asks microcosm's public Constellation
  service about the reader's own likes, reposts and follows on restored posts,
  which sends the reader's DID there.
- **Public docs.** The repository's `README.md` and `docs/` give an overview
  of Horizon, its architecture, and a design page for each feature, built or
  planned; the pronouns and plural systems page says it is built.

### Changed

- **Horizon's own logo.** The sun-and-hills mark, the "Horizon" wordmark,
  the favicons and the web app manifest replace Bluesky's butterfly and
  logotype wherever the app draws them, including the web loading splash.
- **Threads open faster on a fresh load (web):** the browser connects to
  Horizon's server ahead of the first thread while Thread Lens is on. The
  Thread Lens timing log also says where a read's time goes.
- **Pronouns and plural systems no longer need Horizon's server.** When it
  can't answer, other people's pronouns, systems, fronters and members are
  read straight from their own repo, and Bluesky's pronouns field still
  shows for accounts that have no Horizon pronouns.
- **New icons.** Every UI icon is now from Phosphor Icons (MIT): Bold
  outlines, and Fill for selected and filled states, under the same names,
  so nothing that uses an icon changed.
- **Fronters read as a list:** "Wren", "Wren & Sparrow", "Wren, Sparrow &
  Robin", in place of the trailing `&` marker first built ("Wren, Sparrow&").
- **The Posting as control sits exactly where the composer's avatar was,** at
  the same size beside the text, with its chevron as a corner badge and a
  visible focus ring.
- **The Posting as menu reads as choices:** accounts are a labelled radio
  group and members a labelled group of checkboxes, each with its checked
  state for screen readers, and members now show in the native menu too.
- **Posting as and Act as offer your system accounts, not every signed-in
  account.** They list the current account and the accounts on its system
  list only. A listed account that needs a sign-in on this device shows a
  sign-in entry, which opens it over the composer; Act as reads each row's
  state only when you reach it. A draft written as an account that isn't on
  the list, or that needs a sign-in here, says so, and removing the account
  you're posting as holds Post, then switches back to you. With the
  `SYSTEM_ACCOUNTS` switch off, they offer the current account only.
- **No "Suggested for you" on profile pages.** Neither the row of suggested
  accounts among a profile's posts nor the panel that opens under the header
  after Follow shows, and the suggestions aren't requested
  (`PROFILE_SUGGESTED_FOLLOWS`). The home feed's suggestions are unchanged.
- **No "Liked by …" row under posts, on trial.** Bluesky's "social proofing"
  beta is off in Horizon's flag table, in feeds and on a thread's main post,
  so posts show the like count only.
- **"AppViews", written as one word.** The Settings row and dialog read
  "AppViews", with "Horizon AppView" and "Public AppView" inside and an
  "AppView address" field; the sign-in form's quiet button reads "AppView",
  and the errors follow suit. The Settings row has a computer icon.
- **Members skip the second read on posts prism fully describes.** Your muted
  accounts and subscribed mute lists are kept on the device (read with your
  own session, never sent to prism, refreshed on sign-in, on app open, every
  10 minutes and when you mute or unmute, and cleared on sign-out) and applied
  to the lens's posts. On such a post, Quote is checked again at send.
- **Bluesky's social-app is merged up to its 1.136.0 work** (upstream
  `0cda84abe..4e4ad9c5f`, 186 commits): Expo SDK 58, React Native 0.88, React
  19.3 and Jest 30, Node 24.22.1 (the silonew scripts follow), and Bluesky's
  own changes, among them Notifications v2 work, the moderation inbox, tablet
  layouts, and profile links. Every Horizon hook is re-applied in upstream's
  new shapes: the removed artwork stays removed, media spoilers sit on the
  rebuilt image gallery, the Media grid keeps its columns, the notifications
  screen keeps its Private view, the nav card wraps the restructured left nav,
  and the email 2FA dialog keeps its password gate. Notification rows now use
  the stock post controls, which carry the private reply limits. In the flag
  table, Bluesky's Atmosphere screen stays off and profile links are on, as
  Bluesky's public default.
- **Profile links (from upstream) never preview payment links.** A link on a
  payment or support host (PayPal, Cash App, Venmo, Ko-fi, Patreon, GitHub
  Sponsors, Stripe, Bluesky's own list of support sites and others) is never
  sent to the link-card service, so no title, favicon or reachability check is
  fetched for it, and a title filled in automatically is cleared. Typing in
  the link editor is debounced. Profile links were switched off in Horizon
  until this guard was built, because a payment page's title could be saved
  into the public profile record.

### Fixed

- **Threads appear sooner on the web.** The first replies draw at once and
  the rest follow straight after; a thread link opened before on this
  device no longer waits to look up the handle (the list is cleared on
  sign-out).
- **Threads no longer redraw themselves hundreds of times while loading.**
  On a fresh load the thread screen re-rendered continuously until the
  thread arrived, which also held the thread back.
- **A device clock that's off no longer slows threads.** The app's requests
  to Horizon's server were refused and retried when the device clock ran
  ahead; they now go by the server's clock. Opening a thread from a link
  also no longer waits on your account's server to look up the handle.
- **The Thread Lens timing log prints in production builds.** Turned on
  with `horizon:lensTiming`, its lines were stripped from every build but
  development.
- **The front switcher is always reachable on your own profile**, from the
  front indicator, "Set front", or a "Change front" fallback while the front
  loads or can't be read, and from the member list; focus returns to what
  opened it.
- **Opening the account menu no longer crashes the app on web** ("Oh no!",
  "doesn't have an indexed property setter for '0'"). Once a second account
  was signed in, its row in the left nav's account menu carried a style the
  menu passed on unflattened; every web menu item now flattens its style.
- **Adding a system account no longer goes blank after Next.** The dialog
  showed only its title once a handle was entered; it now shows the sign-in
  step. A step that ever loses its registration says "Something went wrong.
  Start again." and logs an error instead of going blank, and switching to
  an app password clears the pop-up's own messages.
- **Signing out in another tab no longer shows "session expired" here.** A
  session is treated as dead only on this window's own refresh or token
  failure, never on a deletion passed on from another window.
- **Signing out also ends the system accounts' sessions** on this device and
  clears the device's copy of the signed-out account's list.
- **Enter fires once** on the Posting as menu's items on web, where it used to
  fire twice.
- **Posting as and Act as no longer send this install's device and session
  ids** on the other account's AppView and chat requests, so those requests
  can't be tied to the current account by id.
- **A private draft never comes back Public by mistake.** It reopens Public
  only if this device recorded a Public save; otherwise it reopens Private
  with no audience picked, and Post stays disabled until one is chosen. A save
  records the visibility, audience and account when it starts, so closing the
  composer or switching accounts mid-save can't record a private draft as
  Public. Drafts saved before this open once as Private.
- **The centre column no longer drops by the scroll offset** when more posts
  load or the lightbox opens or closes. The safe-area library that came with
  the upstream merge measured its own position on web, so a scrolled window
  became a top inset; Horizon patches it to report the window's insets on web,
  as before.
- **The repost and quote menu on web no longer locks page scrolling.**
  Scrolling the page closes it, as do a click outside it and Escape.
- **Menu items on web fire once on Enter,** in every menu (the browser's
  key-up no longer presses an item a second time), so toggles in the audience
  menu no longer flip back.
- **Two accounts used in one page no longer share a record-key clock.** Each
  signed-in account mints record keys from its own clock id and counter, so
  posts and other records written from two accounts in one tab carry nothing a
  firehose reader could use to link them. A small patch of Bluesky's SDK lets
  Horizon supply those ids for the preferences the SDK writes itself (default
  saved feeds, the old feed-format migration, added saved feeds and muted
  words), so switching accounts can't carry one account's clock into another's
  preferences either; a test fails if an SDK upgrade drops the patch.

### Removed

- **Device and session analytics headers,** on every request: signed-in
  AppView and chat clients for every account, signed-out feeds, custom feeds
  and age assurance included.

## Phase 4: Thread Lens (2026-10-23)

A public thread keeps its whole shape around posts hidden by blocks or
deleted, with a labelled placeholder in each gap, for every signed-in reader.

Built on web, with its live checks passed; native is not yet verified.

### Added

- **Thread Lens** keeps the whole shape of a public thread. Where a post is
  hidden by a block or was deleted, the thread shows a quiet placeholder in
  its place, with the reply lines running through it, and keeps the posts
  above and below. The rows read "Post from someone you've blocked", "Blocked
  by <list name>" with "View list", "Post from someone who has blocked you",
  "Post hidden by a block", "Thread Lens couldn't check this post" with
  "Retry", "Deleted post", "Post not found", "Post couldn't be loaded" with
  "Retry", or "Post unavailable"; a private post shows its "Private post"
  stand-in, with "Open private post" for a member. No placeholder names or
  links to the hidden author. More of the thread loads in place from "Load
  earlier posts" and "Load more replies". Everything else works as on the
  stock thread, including hidden replies, which collapse as usual; private
  threads don't use the lens.
- **Who gets it, and where:** every signed-in reader, on by default for
  network members and off for everyone else, never signed out. The "Thread
  Lens" toggle sits at the bottom of a thread's options menu and in Settings >
  Thread preferences, after "Tree view", with the line "Show the conversation
  around posts from people you've blocked or who've blocked you, and around
  deleted posts. Hidden posts show as placeholders."
- **When the lens can't see everything:** an incomplete notice under the post,
  with "Try again", says "Thread Lens can't check every post right now, so
  some may be missing." or "Thread Lens can't see around blocks right now.
  This is the thread as it normally appears." If the lens fails, the stock
  thread shows with "Thread Lens is busy. Showing the thread as it normally
  appears." or "Thread Lens isn't available right now. Showing the thread as
  it normally appears."
- **The composer's note:** replying under a post whose author higher up has
  blocked you says "Someone earlier in this thread has blocked you, so they
  won't see your reply."

### Changed

- **Thread Lens opens faster:** prism is called directly instead of through
  your PDS, there is no handle lookup before the read, the post's public views
  are fetched alongside the lens read, and the read starts as your finger
  touches the post.

### Fixed

- **The Thread Lens toggle is per account on a device;** one account's choice
  no longer applies to every account.
- **The composer's blocked-you note shows when replying from a reply's own
  screen** whose chain of parents is cut, by looking through the other threads
  already loaded.
- **A list block found by the public AppView names its list,** "Blocked by
  <list name>" with "View list", instead of the plain row.

## Refract (2026-10-23)

Accounts that Bluesky's AppView no longer serves, but that a community prism's
operator trusts still hosts, can be viewed and used in Horizon like any other
account. Refract is prism's service for them, and this is Horizon's side of
it, a track of its own outside the numbered phases.

Built on web; reply references in other feeds, and notifications, are still
to come.

### Added

- **Restored accounts look like any other account.** For a signed-in reader
  whose prism serves it, such an account's profile, its posts in feeds,
  threads and quotes, and replies to it render normally, where they were "Post
  unavailable" or a suspended profile before. Nothing on screen marks an
  account as restored. Bluesky's read always goes first and is never held up;
  prism is asked only for what Bluesky didn't return.
- **What readers can do:** members can like, repost, quote, follow and reply;
  other signed-in readers can view and reply. Every write is an ordinary
  record in the reader's own repo. Signed-out readers don't get restored
  accounts.
- **Threads:** restored replies, and missing parents, are filled into stock
  threads and into Thread Lens's fallback to the stock thread. Replying to a
  restored post works even when Bluesky can't find it. While prism hasn't
  answered, a profile says "This profile can't be shown right now." and a
  reply "This post can't be replied to right now."
- **Reposts and Following:** reposts of restored posts show on every profile,
  and members' Following merges restored posts, including the reposts of them
  by accounts they follow.
- **The hosting community's moderation:** for network members, the community's
  labeler's labels apply to restored views as if they subscribed to it. Blocks
  are never weakened: Horizon never puts back a post or profile prism left
  out, applies the reader's own blocks on top, and refuses replies across a
  block.

### Fixed

- **A restored profile no longer flashes "Account has been suspended" or jumps
  back to the Posts tab** while scrolling on web (the hover card's prefetch
  and failed refetches kept Bluesky's takedown answer).
- **Your own reposts of restored posts show on your own profile.**
- **Restored posts no longer carry an "Archived" badge.**

## Phase 3: Backdrops and themes (2026-10-19 – 2026-10-23)

Backdrops behind the app on every screen size, with light, dim and dark as
glass over them, and appearance that follows the account. The change lists
from skydeval's live checks are part of this phase.

Steps 3A to 3F: desktop,
tablet and phone web, with the native pieces built but not yet verified, then
change lists 1 to 3 from skydeval's live checks.

### Added

- **Backdrops:** 1.0's 29 (None, 12 pride flags, 7 materials, 9 solids) in
  1.0's order, plus a Custom colour, drawn as one soft diagonal gradient from
  the top left to the bottom right of the window, behind the app, as 1.0
  looked. The renderer now honours angles, positions, opacity and tuning;
  1.0's spec as written (angled, hard-edged stripes with the bloom) can be
  tried by flipping one constant (`BACKDROP_LOOK`).
- **Themes are glass:** light, dim and dark stay the only themes. With a
  backdrop, the reading column stays opaque in the theme's background, and the
  left nav and each right-rail section (search, feeds, trending, the footer
  links) sit on a frosted card with 16px corners: the backdrop painted into
  the card under the theme's tint. The card is just opaque enough for the grey
  rail text to read at 4.5:1 over that backdrop, in every theme. At tablet
  width the collapsed icon nav gets the same card. Buttons and accents keep
  their colours. The Messages split view stays opaque.
- **Appearance > Backdrops,** after Dark theme: the selected backdrop's name
  (the hovered one's on web), a grid of swatches with a ring on the selected
  one, and a Custom chip. Custom opens the Custom Backdrop Color card: Solid
  or Two-tone (pink to cyan by default), each colour with a hex field, a
  swatch and R, G and B sliders, with the backdrop following the sliders
  before Apply; 10 preset slots (tap to load, long-press to save, "Hold to
  clear N"). Keyboard: Space or Enter selects a swatch; Enter loads a preset
  and Shift+Enter saves it; Enter twice clears one. In dim and dark the pale
  swatches are drawn stronger so they stay distinguishable.
- **Saved to your account:** the choice, the custom colours and the presets
  are a public record, `app.nearhorizon.actor.appearance/self`, in the
  account's own repo on any PDS, so they follow you to other devices. This
  device keeps a copy for an instant first paint. "Keep this device's own
  backdrop" keeps a device to itself. If the PDS refuses the record, the
  backdrop is kept on this device and a notice says so once.
- **Phones, below 800px:** the Home header with its feed tabs, the other
  screens' top bars, the bottom tab bar and the slide-out drawer are windows
  onto the same backdrop, lined up with each other as if one gradient sat
  behind the whole screen. The bars show the backdrop edge to edge with no
  glass, its colours as pure as in Gutter's margins (with the softness of dim
  and dark when it is on); each thing written on them (a tab icon, a header
  button, the back arrow, the title, a Home feed tab, the logo) sits on a
  small soft oblong of shade, just dark or light enough for it to read at 3:1
  over the part of the backdrop that bar shows. The drawer stays frosted,
  under the theme's tint. They stay lined up as the bars hide and show on
  scroll, as the drawer slides in, and on navigation. Posts stay on opaque
  ground. Bars inside dialogs stay as they were.
- **"Phone frame" (to compare, this device only):** Appearance offers four
  styles, with a line under the picker saying what the chosen one does.
  **Bars** (the default): the bare windows above. **Edges:** plain bars with a
  thin strip of backdrop along the top bar's bottom edge and the tab bar's top
  edge. **Gutter:** plain bars, and the reading column drawn as a card 8px in
  from each side with the backdrop in the margins. **Header:** only the top
  bars show the backdrop, bare as with Bars, each item on its shade; the tab
  bar is plain. The drawer is a window with every style. The picker goes away
  once one is chosen for everyone. Gutter replaces the earlier hidden "Reading
  card on small screens" toggle; a device that had it on starts on Gutter. The
  earlier **Buttons** style (plain bars with the tab icons, header buttons and
  compose button as small windows) is gone; a device that had it starts on
  Bars.
- **Backdrop softness:** dim and dark no longer lay a dark veil over the
  backdrop. They calm it instead: colours lose some saturation and come down a
  little in brightness, keeping their hue, so a backdrop reads as "not bright"
  rather than darkened. Appearance > "Backdrop softness" has a slider for dim
  (40 by default) and one for dark (50), from 0 (full colour) to 100; they
  apply on this device only, to the window backdrop, the cards and bars alike,
  and the cards' glass still keeps the grey rail text at 4.5:1 over the
  softened colours.
- **Smoother scrolling with a backdrop:** nothing is blurred live any more
  (the rail and nav cards paint the backdrop instead); the phone bars follow
  the page with one shared tracker that measures once per frame and moves each
  bar's backdrop without repainting it, only while something moves, and not
  for screens out of view; the full-screen backdrop is promoted to its own
  layer, and on phones it is not drawn at all where the bars paint their own
  (every style but Gutter); and a backdrop is worked out once per theme,
  softness and window size. The look is unchanged.
- **iOS and Android:** the bottom bar, the Home header and the drawer paint
  the backdrop the same way (under the theme's glass with Bars and Header,
  whose bare bars are web only for now). Built, not yet tried on a device.
- **Hover hints on the composer toolbar** (change list 2, item 1, web): the
  media, GIF, spoiler, content warning and emoji buttons say what they do when
  the mouse rests on them. The hint never takes focus from the editor.
- **More pride flags** (change list 2, item 2): Philly, Demisexual,
  Demiromantic, Aroace, Genderqueer, Genderfluid and Agender. The demi flags'
  chevron is a first stripe, as the intersex ring is.
- **New backdrops** (change list 2, items 3 to 5): Nature (Ocean, Forest,
  Desert, Sakura, Autumn, Moss), Skies (Dawn, Daylight, Golden Hour, Dusk,
  Twilight, Night, Aurora, and Time of Day, which shows the sky of the local
  hour and switches once when the hour changes, without a transition) and
  Color blobs (Peach, Lagoon, Berry, Citrus, Midnight). The Backdrops picker
  groups its swatches under Flags, Materials, Nature, Skies and Color blobs.
- **Film grain** (change list 2, item 6, web): an optional fine grain over the
  backdrop, off by default, per device. It is a small static image drawn once;
  nothing is filtered or redrawn as the page moves.
- **Quiet patterns** (change list 2, item 7): a custom one-tone backdrop can
  carry faint dots, a grid or diagonal lines, saved with the colour (and in
  presets) in the appearance record.
- **The theme follows the account** (change list 2, item 11): colour mode,
  dark theme, font and font size are saved to the account's
  `app.nearhorizon.actor.appearance` record when changed signed in, and
  applied on account switch like the backdrop. An account that never set them
  leaves the device's settings as they are; signed out, the device's own
  settings apply.
- **Nine more pride flags** (change list 3, items 7 and 8): Bigender,
  Transfeminine, Transmasculine, Graysexual, Grayromantic, Omnisexual,
  Polysexual, Abrosexual and Queer (the 2015 striped flag), striped like the
  rest with their colours locked.
- **More backdrops** (change list 3, items 1 to 5): Calm (Hush, Sand, Soft
  Sage, Still Water, Quiet Lilac, Calm Slate, Charcoal: very low contrast and
  low colour, for anyone sensitive to busy backgrounds), Seasonal (Spring
  Bloom, Summer Haze, Autumn, Winter Frost, and Follow the Season, which
  switches by the date, northern months unless "Southern hemisphere" is on),
  Space (Nebula, Galaxy, and Starfield, a fixed field of small stars drawn
  once), Gems (Amethyst, Emerald, Sapphire, Rose Quartz, Opal, Oil Slick,
  Holographic) and Aesthetics (Frutiger Aero, Vaporwave, Synthwave, Y2K,
  Cottagecore, Dark Academia, Pastel Goth, Retro 70s). Nothing in them moves
  or is redrawn as the page scrolls.
- **Custom stripes** (change list 3, item 10): the custom backdrop has a third
  kind, Stripes, beside Solid and Two-tone: 2 to 8 colours in your own order,
  added, removed and moved up or down, drawn like the flags. Saved with the
  account's appearance and in presets.
- **"Save my appearance"** in Appearance, after Backdrops, chooses where your
  backdrop and theme settings live: "Private, synced" ("Horizon keeps it for
  you and syncs it across your devices. It isn't in your public account.", for
  members, while prism offers it), "Public, in my account" ("Saved in your
  account's public data. Other apps can read it.") or "This device only" ("Not
  saved anywhere else. Your other devices keep their own."). An account with
  no record stays on "This device only" until it picks Public. Members with a
  public appearance record were moved once to "Private, synced", with a
  one-time note ("Your appearance is now private. …"), and the public record
  deleted.
- **Removed members keep their appearance.** When an account leaves the
  network, prism holds its private appearance for 7 days; the next sign-in on
  a device copies it there, switches to "This device only" and says so in a
  note, and prism's copy is then deleted.
- **A public preview build for Cloudflare Pages.** A `preview` OAuth client
  mode whose origin is set at build time (`EXPO_PUBLIC_OAUTH_CLIENT=preview`,
  `EXPO_PUBLIC_PREVIEW_ORIGIN`), with its own client document written into the
  build output, single-page routing and headers for Pages, private share links
  on the preview's own origin, and `scripts/preview-build.sh` (`build`,
  `deploy`, `info`) for silonew.

### Changed

- **Settings: "App views".** The "App servers" row and dialog are now "App
  views", in the atproto ecosystem's terms: Horizon's own app view (prism,
  always connected) and the public app view. The sign-in form's quiet button
  reads "App view".
- **App views: the Horizon app view card is described briefly** (change list
  item 1): "Always connected. Powers Horizon's features.", without its
  address. It stays greyed out and cannot be switched.
- **"Phone frame" in Appearance shows only where it applies** (change list
  item 3): below 800px or on a touch-first device, following window resizes
  live. A desktop window hides it; the saved choice is kept either way.
- **"Keep this device's own backdrop" is now "Keep this device's own
  appearance"** (change list 2, item 11): it keeps the theme settings on this
  device too.- **Autumn is russet and gold** on a light parchment, like the
  other seasons, in place of its dark purple.

### Fixed

- **With a backdrop, a long pinned-feeds list shows in full on desktop.** The
  feeds card no longer scrolls inside itself (it had its own vertical and
  horizontal scrollbars and was cut off mid-item); every rail card sizes to
  its content, and a right rail taller than the window scrolls as a whole.
- **With a backdrop, Notifications has no opaque band across the top of the
  window.** Its header's background and fade cover only the centre column (or
  the Gutter card on phones), so the backdrop shows beside it.
- **Turning a backdrop on or off no longer moves the desktop rails** (change
  list 2, item 10). The rail and nav cards grow outward around their content
  instead of padding it inward, so the avatar, the nav items, the search box,
  the feeds and the trending list stay where they are with or without a
  backdrop.

### Removed

- **The nine solid backdrops** (Slate, Mist, Red, Orange, Yellow, Green, Blue,
  Indigo, Violet; change list 2, item 9). Custom one-tone covers any colour. A
  saved solid, in the account's record or on the device, reads as a custom
  one-tone of the same colour, so nobody's backdrop changes.
- **Nature's Autumn,** so there is one Autumn; a saved Nature Autumn reads as
  the seasonal one.
- **The "Keep this device's own appearance" toggle.** "This device only" under
  "Save my appearance" replaces it, and a stored opt-out is ignored.

## Phase 2: Private posting (2026-10-18 – 2026-10-23)

Network members write and read private posts, limited to an audience they
choose, beside public ones across the app, with spoiler tags, media spoilers
and content warnings for everyone. Private-post work done during Phase 3's
live checks is listed here, by subject.

The parts that wait on server support are switched off until it lands.

### Added

- **Writing private posts.** Members get **Public | Private** in the composer,
  with an audience: Everyone, Followers, People you follow, a list, a new
  list, or Only me. A reply in a private conversation is Private and cannot be
  made public; it is visible to whoever can see the conversation's first post
  now, and the composer says who that is. A private reply to a public post
  starts a private branch under the audience its author picks, and replies in
  that branch follow the branch's first post. Private posts and private
  threads are written to the account's own server through the kryphocron
  procedures, checked locally before they are sent, and never fall through to
  a public post; a failed private thread removes whatever was written. Private
  posts carry their languages and content warnings, and readers' clients apply
  the warnings as for a public post.
- **The composer.** The **Public | Private** control sits centred in the
  composer's footer, between the media tools and the language and character
  count, as in the old Horizon client (on a phone it takes its own centred row
  above). Bluesky's interaction button stays where it is, above the footer,
  but opens one drop-down for both modes in place of Bluesky's pop-up, for
  every account: who can see (Private), who can reply (Anyone, Nobody, your
  followers, people you follow, people you mention, your lists, and "New reply
  list..." made right there), whether quotes are allowed, and "Save these
  options for next time"; while Private, Who can see offers "New audience...".
  Its label is "Anyone can interact" or "Interaction limited" in both modes,
  with the audience shown inside under Who can see; only a private reply that
  starts a branch, which has no reply settings, is labelled with its audience.
- **Reply and quote limits on private posts.** A private post's limits are
  written as Bluesky's own threadgate and postgate records naming the private
  post, before the post itself; if they cannot be saved, nothing is posted.
  Until prism applies them, readers' clients read them: an opened private post
  dims reply and quote for a reader who is not allowed, and pressing reply or
  quote elsewhere says "Replies to this post are limited." or "Quote posts of
  this post are turned off." Rules the client cannot decide (lists, mentions)
  let the reader through.
- **Editing a private post's settings.** The author's post menu offers "Edit
  who can see and interact": the same drop-down. Who can see can be changed in
  place on a post that starts a conversation or a private branch, keeping its
  link, replies and interactions; the dialog warns first that replies from
  people outside the new audience, and the replies under them, will be hidden
  from others, while the author's own stay visible. Other replies show who can
  see read-only. Who can reply (for the thread's author) and who can quote are
  saved as the stock records.
- **Media in private posts.** Private mode offers the full media picker: a
  video (or a GIF from the photo library) uploads through Bluesky's video
  service as for a public post and is written into the private post, five to
  ten images are written as a gallery, a quote can carry images, a gallery, a
  video or a link card, and images keep their aspect ratio and link cards
  their thumbnail.
- **Deleting a private post** deletes the private record, never a public post
  that shares its key.
- **Drafts saved Private come back Private**, with their audience, and show a
  small lock in the drafts list.
- **Audiences** in Settings, for members: the account's audiences, the people
  on each list, and New list.
- **Network membership is found with prism's public indexing off**: the
  membership check falls back to prism's private timeline when the public one
  answers "not implemented".
- **Reading private posts.** For members, Following merges the private posts
  of the accounts they follow (and their own) with the public timeline by
  time, and the author's just-written private posts show at once. Profiles
  gain a **Private** tab between Posts and Replies; Posts also merges the
  profile's private posts (and its own private self-threads) the reader may
  view, Replies its private posts and replies, both by time, and a pinned
  private post shows first on Posts, once. Private lists keep loading through
  pages that come back empty while more remain. Private threads open at
  `/profile/<handle>/ppost/<rkey>` with their public parent; "View post" after
  posting privately opens them. A quoted private post shows for readers who
  may view it and as a "Private post" card for everyone else. It arrives with
  the post that quotes it, in feeds, profiles, threads, Saved and
  notifications: every private quote on a page is read in one request before
  the page shows (waiting at most two seconds), and quotes already seen paint
  at once from the device while they are read again. A quote that still has to
  load holds its card's space with a quiet placeholder. Membership is
  remembered per account, so private reads start at launch while it is checked
  again in the background; composing privately waits for that check. Authors'
  servers are remembered for six hours. A private GIF-style video plays as a
  GIF. A pasted private post link becomes a quote. Private post links are
  shared on `https://nearhorizon.app`, and Embed post and Send via chat are
  not offered for them.
- **How private posts look.** Every private post carries a lock the size of
  the header row's other icons, alone, at the right end of its header row (its
  top right corner), in feeds, thread replies, profiles, Saved and quotes; the
  name, handle and time truncate before it. There is no border (a trial look).
  An opened private post shows the lock, **Private** and who can see it
  ("Visible to Your followers", "Visible to Book club", "Visible to Followers
  of @alice"), read from the audience record; a reply to a private post shows
  the same in the composer. Links and hashtags in private posts are linked
  (found on the device until prism serves them), and links open directly
  instead of through Bluesky's redirect. Images, link cards, quotes, videos
  and galleries in private posts are shown from the post itself until prism
  serves their views.
- **Controls on private posts.** Like, repost and quote work as on any post.
  Counts and the stats row under an opened post show when prism serves them,
  and the reader's own like, repost, bookmark and thread mute show as prism
  has them. The bookmark button and the menu's save item save the post with
  prism once prism says it stores private bookmarks; before that, pressing
  them says "Saving private posts isn't available yet." and saves nothing.
  Mute thread on a private thread, Hide reply for everyone and Detach quote
  are offered once prism says it applies them; Report post is not offered. On
  an opened private post that starts its thread, the author's who-can-reply
  line opens the post's settings. Deleting from a private post's thread goes
  back as from a public one. A private post the reader may not view shows a
  "Private post" card in its thread instead of "Post not found", and reply
  lines in private threads connect replies to their replies.
- **Public | Private notifications** for members: a pair of folder tabs above
  the notification pills. Private has its own All and Replies pills and says
  "Activity on private posts will show here." until prism serves private
  notifications. Public notifications load when Bluesky's grouped
  notifications fail (as they do for a like or repost of a private post): that
  page is read from the plain notification list and grouped on the device
  instead, with the same rows and pills.
- **Public | Private on Saved** for members, as the same folder tabs, under
  the Saved header in the centre column. Private lists saved private posts and
  replies, saved and removed through prism instead of Bluesky; when prism does
  not serve private bookmarks it says "Saved private posts will show here."
- **Following what prism serves** (step 2H). Membership is asked of prism's
  own membership query, which also enrolls a new account, and prism's answer
  says which private features it serves; Horizon remembers that per account
  and turns each feature on or off from it, so a prism that gains or loses a
  feature is followed without a new release (the old check stays for a prism
  without the query). A feature list remembered from the last launch lets
  reading start at once, but nothing that writes uses it until prism answers
  again. With prism serving them: counts and the reader's state on private
  posts; private bookmarks; reply and quote limits applied by prism (the
  device's own check stays for a private branch under a public post); the
  profile's Posts tab filtered by prism; who can see read from prism, so a
  reply in a moved thread names its thread's audience, and a move made in
  Horizon holds against older answers for a minute; a moved or new post read
  back at once when prism says it has caught up; reposts of private posts by
  members shown as repost rows in Following and on profiles; and Mute thread
  on private threads, with a public thread's mute also sent to prism so
  private replies under it stop notifying (and brought back in line when
  Horizon sees the two disagree).
- **Private activity, lists and search** (step 2H, second half), each while
  prism serves it. Liked by, Reposted by and Quotes on a private post list the
  members who did so (members only: prism neither counts nor lists anyone
  else), with public quotes shown as the public AppView has them. A private
  thread with more replies than one read brings shows "Show more replies" and
  "read more" rows that load the rest. Opening a public post shows the private
  replies under it that the reader may see, with their lock, for Top first
  under the post, for Newest and Oldest in time order among the public
  replies. The Private notifications view lists replies, quotes and mentions
  in private posts and members' likes, reposts, replies and quotes of the
  reader's private posts, with the stock rows (a lock in the corner of a
  private post's row, its links opened directly, and its reply button checking
  the post's reply limits); the Private tab shows prism's unread count, the
  notifications badge adds the private replies, quotes and mentions the public
  count cannot hold, and opening the view marks them seen. Search lists
  private posts the reader may see among the public results in Top and Latest
  (Latest by time, Top one private result after every two public ones),
  searching words and the author (`from:`, the author filter, Me); other
  filters apply to public results only, with a note. When recent private posts
  hold no match, "Search older posts" looks further back, up to a year. Moving
  a post's audience no longer carries the "until the server fully supports
  this" line, and a branch root's warning says the author's own replies inside
  it are checked too. Placing a reply deep in a private branch reads the
  branch in one request instead of one per level.
- **Spoiler tags**, for everyone. Write
  `||secret||`, or select text and press the composer's spoiler button (web),
  and the text is covered until the reader presses it, in feeds, threads,
  quotes, notifications, Saved, search, the video feed and the reply preview;
  the video grid shows "[spoiler]" in its place. A spoiler on lines of its own
  is a closed drawer under the line above, opened by an arrow (or a "Spoiler"
  row when nothing comes before it). Public posts keep the `||` markers in
  their text, so other apps show them as written, and carry the spoilers as
  facets (`app.nearhorizon.richtext.facet`) so links and mentions inside stay
  linked everywhere. Private posts are written the same way until prism serves
  facets, then without the markers, which then no longer count toward the 300
  characters. `\|` writes a literal pipe. A cover hides the text from view
  only: it is still in the post, in translations, in "Copy post text" and in
  muted-word matching. Posts from other apps that happen to contain `||` are
  shown as written.
  - **Reddit-style spoilers:** `>!secret!<` also works. It is published as
    `||secret||`, so every post carries one syntax.
  - **Hover hint:** on web, hovering a spoiler shows "Click to reveal", or
    "Click to hide" on an open drawer.
- **Who can see and interact:** on web, the drop-down stays open while you
  choose, in every section, and closes on a click outside it or on its button.
  It no longer narrows when it grows tall enough to scroll.
- **Media spoilers and content warnings.**
  - **Mark as spoiler:** the image alt text dialog and the video captions
    dialog have a "Mark as spoiler" checkbox, and a flagged thumbnail in the
    composer shows a "Spoiler" badge. The post records the flag on that image
    or video (`app.nearhorizon.spoiler`), public and private.
  - **Content warning** (web): a CW button in the composer's tools adds an
    optional line above the post ("cw blood"). The post is published as that
    line followed by the body as one hidden block, every image and video is
    flagged, and the post carries the `app.nearhorizon.cw` self-label. Other
    apps show the line, then the body between `||` markers. Spoilers already
    in the body are opened with the warning. The character count includes the
    line and the markers.
  - Drafts keep their spoiler flags and content warning on this device.
  - **Covers:** Horizon draws a flagged image or video under a heavy blur with
    a "Spoiler" pill, in feeds, threads, quotes, search, Saved and chats; one
    press (or Enter or Space) reveals it without opening the post, and on web
    hovering shows "Click to reveal". In a gallery each flagged image is
    covered on its own. A flagged video never plays on its own: the first
    press reveals it, the next plays it. The lightbox lists only the images
    already revealed. A covered image's alt text is not read out until it is
    revealed. Labelled media still show the moderation "Show" row first.
  - **Content warnings, shown:** a CW post shows its line with the drawer
    arrow, or a "Content warning" row when the line is empty; a one-line body
    with no line reads "Content warning" in place, and opens there. Every
    image and video of a CW post is covered with a "Content warning" pill;
    opening the text reveals no media, and the reverse. A post the CW post
    quotes is not covered unless it has its own flags or CW. Link cards and
    GIFs are never covered.
  - **Small previews:** notification thumbnails, the video cards and the reply
    preview's images of a post with spoiler media or a CW are blurred or left
    out (all of them), and sharing such a post into a chat shows "Media marked
    as spoiler" in place of its images. The video grid shows "[content
    warning]" in place of a CW's body.
  - **The line reads as a warning:** "CW: cw blood", set apart from the text,
    wherever the post shows (a line with only media too, and the video grid);
    screen readers hear "Content warning:". The stored text is unchanged. The
    post's labels list names the self-label "Content warning".
  - **Markers hug the body:** the `||` markers now sit straight around the
    body (`cw blood` then `||it was a lot||`), so other apps show an ordinary
    spoiler instead of `||` on lines of their own; posts written the earlier
    way still read as before.
- **Settings: "Interaction settings" is a main row,** between "Moderation and
  content filters" and "Notifications" (the Moderation screen's row still
  opens it). For members it has two sections. **Public posts:** the stock
  reply and quote defaults. **Private posts:** "New posts start as" Public or
  Private, "Default audience" (Everyone, Followers, People you follow, Only
  me, or one of your list audiences, with "New audience..."), a note that
  private posts share the reply and quote defaults above, and Audiences, moved
  here from its own Settings row. The composer opens a new post on these
  defaults, and each post can still change them; a reply to a public post
  starts Public with the default audience ready, and a reply to a private post
  stays private under its thread. A quote starts as the post it quotes:
  quoting a private post starts Private with the default audience (Everyone
  until you choose one), quoting a public post starts Public, whatever "New
  posts start as" says; either can still be switched. Until a default audience
  is chosen none is selected, and the screen says what applies meanwhile. The
  defaults follow you to other devices as a record in your own repo,
  `app.nearhorizon.actor.postingDefaults/self`, with a copy on this device for
  an instant start. Non-members see the stock screen and the composer always
  starts Public for them.
- **Settings > Notifications has Public | Private tabs** for members, the same
  folder tabs as the Notifications page, in the centre column under the
  screen's header. Public is the stock screen. Private lists likes, replies,
  mentions, quotes and reposts of private posts, shown disabled with "Private
  notification settings arrive with server support" until prism offers private
  notification preferences; nothing is stored meanwhile. Non-members see the
  stock screen.
- **Spoilers from other apps** (Phase 3 change list 1, item 2). A post with no
  spoiler facets, written in another app or before Horizon wrote facets, has
  its `||text||` drawn as covers and drawers, in the feed, threads, quotes,
  notifications, the reply preview, the video card text and the DM share
  preview. A strict rule keeps ordinary text alone: the markers hug the text
  (`||x||`, never `a || b`) and are not glued to a word outside them; a post
  with a backtick, `|||`, more than one spaced `||` or `&&`, an unpaired
  marker or more than 5 spoilers renders as stock. Settings > Content and
  media has "Cover ||spoilers|| from other apps", per account and on by
  default, kept in the account's `app.nearhorizon.actor.postingDefaults`
  record (`reading`); off, such posts render as stock. This reverses spoilers
  design S-3 as an opt-out.
- **The profile Likes tab shows liked private posts** (Phase 3 change list 1,
  item 5). For a member on their own Likes tab, the like records in their repo
  whose subject is a private post are read through prism (readable ones only)
  and merged with the stock items in like order; non-members see the stock
  tab.
- **The profile Media tab is a grid** (Phase 3 change list 1, item 6): square
  thumbnails, 3 to a row on phones and 4 from 800px, on web and native. A tap
  opens the post, a post with several images shows a stack mark, spoiler and
  CW media stay blurred with the compact covers, posts hidden by moderation
  are masked as on the Videos tab, and a private post carries the corner lock.
- **The profile Media and Videos tabs include private posts** (Phase 3 change
  list 1, item 4) the reader may see, merged by time like the Posts tab, while
  prism serves `private.mediaFilters` (its author feed's `posts_with_media`
  and `posts_with_video` filters, reposts left out); without it, and for
  non-members, the tabs are public-only.
- **Private posting from any PDS** (step 2K, web). Members whose account is on
  Bluesky's PDS or any other server can write private posts, replies, threads
  and audiences: the post is prepared in the browser and written to the
  member's own PDS, as a public post is. It needs confirmed network
  membership. Members on any server can delete their private posts, edit list
  audiences and delete audiences ("Delete <name>?", "Private posts shared with
  this audience will be visible only to you. This can't be undone."). Changing
  who can see an existing post stays hidden off aurora-locus for now, and the
  native apps say "Posting privately from your server isn't available in this
  app yet."
- **Private is offered only where it can be posted.** Where it can't, the
  Public | Private control shows Private greyed out, and choosing it keeps the
  post Public with the note "Private posting isn't available for your account
  yet." and the reason ("Horizon is still checking your account.", for
  example). The private posting defaults and the Audiences screen's New list
  show only while Private is offered.
- **Private posts feel instant, with Unsent.** Off aurora-locus, Post closes
  the composer at once and the post shows "Posting..." in the feed while it is
  sent in the background. A post that fails stays on the device, with a toast
  ("Your private post wasn't posted. It's saved on this device in Unsent." or
  "Only part of your private post was posted. Finish or delete it in
  Unsent."). Account settings gains a "Private posts" row, while there is
  anything in it, holding Unsent: each entry is "Not posted" or "Partly
  posted", with Retry, Edit, Discard, Finish posting, Delete what was posted,
  Check now and Remove from this device. Failures read in Horizon's own words,
  never a server's, and nothing is retried or deleted without you.
- `NOTICE.md` credits kryphocron-web (MPL-2.0), which private posting from any
  PDS uses, with its licence text.
- **Hidden replies on private threads.** A reply the original
  poster hid collapses under the stock "Show more replies" row, fetched in the
  background so it shows without a wait when pressed. The original poster sees
  it marked "Reply Hidden by You" and can choose "Show reply for everyone";
  others see it plainly, and its author still sees it in place. "Hide reply
  for everyone" is also offered on a private reply under a public post. The
  row appears only when something is behind it.
- **New private posts arrive at the top of Following** like public ones:
  on native they are staged above your place without moving it, with the Home
  dot and the pill; on web they light the new-posts button and the Home dot.
  Your own new private post is staged before prism serves it, and a staged
  post that is deleted drops out at the next check.
- **Replies across a block are refused.** A private
  reply is refused, with nothing written or uploaded, when you and the author
  being replied to, or you and the thread's owner (its original poster, or the
  author whose private reply started that branch), are blocked in either
  direction, directly or through a block list. It reads "You can't reply to
  this post." and stays in Unsent with Retry, Edit and Discard (on
  aurora-locus the composer stays open with the same text); it never says who
  blocked whom. A block with anyone else higher up the thread doesn't stop the
  reply. The check is made again just before the post is written, and if it
  can't be made, nothing is written either.
- **When prism is busy or behind.** A slow or catching-up
  prism no longer makes a member look like a non-member, and a re-indexing
  account stays a member. What is on screen stays. Your own private posts that
  prism hasn't served yet stay, labelled "Syncing", and are no longer dropped
  while your PDS still has them. Other people's private posts are hidden until
  prism serves them again, never shown from a cached copy, and feeds,
  notifications, search, Saved and the activity lists say "Catching up. Some
  private posts may take a moment to appear."; screens catch up once, without
  moving any list, when prism recovers. A reply prism can't place fails at
  once with "Couldn't reach the post you're replying to. Try again in a
  moment.", and goes to Unsent; replies to your own posts still work. Waits
  are capped (30 s for a thread or list, then "Couldn't load right now" with
  "Try again"; 2 s for a quote).
- **Private activity subscriptions**: the profile
  bell's dialog gains "Private posts" and "Private replies" toggles for
  members, under "Subscribe to account activity in private posts", saved to
  prism; the bell lights if any toggle is on, and Save closes the dialog at
  once. Off until prism serves them.

### Changed

- **A private post's video plays from its author's server**, never from
  Bluesky's video service, which can drop a video no public post uses. It
  shows its first frame until played, video cards without a thumbnail show a
  plain tile with a play icon, and a video that can't be loaded says so
  instead of showing a dead player. A quoted public post's video is unchanged.
  Safari and iOS may not play or seek it until Horizon's server answers range
  requests.
- **A private post's line reads "Private · <audience>"**, in place of "Visible
  to <audience>" (screen readers hear "Shared with <audience>"), and the
  Everyone audience is called "Horizon members" everywhere.
- **Private notification settings work:** Likes, Replies, Mentions, Quotes and
  Reposts each have "Show in Private notifications" and "Whose activity
  notifies you" ("Everyone" or "People I follow"), saved with prism, and the
  Private notifications list and its unread count follow them.
- **Private notifications refresh like public ones:** pressing the Private tab
  or pill again scrolls to the top and refreshes, switching to it refetches
  when something is unread, and the stock "Refresh" pill appears for new
  private notifications.
- **The Media grid's marks** (stack, play and the private lock) sit top right
  on a dark backing, so the lock shows on light images, and a dot separates
  the date from the private lock on a post's details line.

### Fixed

- **Sign-in no longer hangs when another tab holds the sign-in lock.** Signing
  in or switching accounts waits a bounded time, then says "Horizon is busy in
  another tab. Close other Horizon tabs or try again in a moment."; a launch
  waits for the lock and then resumes, a page being left lets the lock go, and
  the app's pages are no longer frozen in the browser's back/forward cache.
- **Uploads the server refuses read clearly:** a rate-limited upload says "The
  server is limiting uploads right now" with when to try again (from
  `Retry-After`, else "later"), and a 502/503/504 says the server couldn't
  take the upload, on public and private posts. A private post now uploads all
  its media before writing its reply and quote limits, so a failed upload
  writes nothing.
- **A quoted private post keeps its spoilers and content warning.** In a
  quote, alone or with media, and in a quote inside a quote, its spoilers are
  covered, its CW line reads as a warning with the body in a drawer, and its
  media are blurred as on the post itself, in the feed, threads, the quote
  screen, notifications and Saved.
- **Every post of a self-thread keeps its tile** in the Media grid; earlier
  posts could go missing.
- **Hidden replies on private threads:** the "Show more replies" row no longer
  opens nothing, the original poster can find a reply they hid after a reload,
  and a reply never shows twice.
- **YouTube embeds play on web.** The embed's frame is served from Horizon's
  own origin, because bsky.app refuses to be framed by other sites.

## Phase 1: Login and server wiring (2026-10-14)

OAuth sign-in beside the password sign-in, signup on any server, and the two
AppViews Horizon talks to: prism, always connected, and a public one.

### Added

- **OAuth sign-in on web**, beside the password sign-in: the sign-in form has
  two tabs, OAuth (default) and Password, and remembers the last one. OAuth is
  a public client with PKCE and DPoP-bound tokens, through
  `@atproto/oauth-client-browser` 0.5.4, with its callback at
  `/auth/web/callback`.
- **The OAuth client document** at `public/oauth-client-metadata.json`, for
  `https://nearhorizon.app/oauth-client-metadata.json`, built from one source
  and checked by a unit test; a development document beside it for local
  development against aurora-locus.
- **OAuth sessions** that resume, refresh, sign out with revocation where the
  server offers it, end cleanly when the server ends them, and stay consistent
  across tabs. An ended account opens a sign-in window in place when switched
  to. Account operations that need the password (app passwords, deactivating
  or deleting the account, email and 2FA, handle) ask for it and switch the
  session to a password session.
- **Signup with a server picker**: Horizon's server first, then Bluesky, then
  any server. Servers that offer OAuth account creation use it; others use the
  password signup with the server preselected.
- **App servers** in Settings (and under the OAuth tab when signed out):
  Horizon's network (prism) is always connected; the public AppView is
  Bluesky's by default and can be changed.
- **Network membership** is asked of prism at every sign-in, resume and app
  start, with a notice while a new account is being set up.
- `NOTICE.md` credits the Witchsky client (MIT), whose code Horizon adapts for
  parts of the above.
- **An OAuth sign-in must return the account that was asked for.** Horizon
  resolves the handle before leaving for the server and refuses a sign-in that
  comes back as a different account, with an error naming both. A sign-in
  cancelled at the server says so.
- `scripts/silonew-dev.sh`, which runs the web dev server on a build host for
  testing through an SSH tunnel at `http://127.0.0.1:8081`.

### Changed

- **Signing out also ends the session at the server**: OAuth grants are
  revoked where the server offers revocation, and password sessions are ended
  with the server (best effort).

### Fixed

- After entering the password for a password-only screen (such as App
  passwords), the screen loads instead of keeping the error it hit under
  OAuth.
- A failed OAuth sign-in reopens the sign-in form on the OAuth tab, where its
  error is shown.

## Phase 0: Foundations (2026-10-13 – 2026-10-14)

Bluesky's social-app imported as Horizon's base, with Horizon's own code in
its own folder, Bluesky's telemetry and age assurance switched off, and the
umbrella design that sets the build order.

### Added

- `horizon-ts/src/horizon/` holds Horizon's own code: fixed switches
  (`switches.ts`), the local feature-flag table (`flags/`), a no-op metrics
  client (`telemetry/`) and the product name (`branding/product.json`). Its
  `README.md` sets the hook rules and keeps the hook ledger; every edit to a
  Bluesky file is marked `HORIZON:` and listed by `git grep -n "HORIZON:"`.
- The product name is Horizon in page titles, the web page template and the
  app config.
- `NOTICE.md` records that Horizon is built on Bluesky's social-app (MIT).
- **The Horizon client's base.** Bluesky's social-app (1.135.0, commit
  `0cda84abe`) is imported with its full history into `horizon-ts/` as a git
  subtree. Bluesky's repository is a fetch-only `upstream` remote, and its
  updates are merged with `git subtree pull --prefix=horizon-ts upstream main`
  once for every Bluesky release.
- **`.gitignore`** for internal docs and local tooling (`docs/internal`,
  `.chainlink`, `.claude`).
- **The umbrella design for the Horizon client** (internal). It sets what
  the client is, who gets which
  features, how Horizon code sits beside Bluesky's so upstream keeps merging,
  and the build order: foundations, login and server wiring, private posting,
  backdrops, Thread Lens, pronouns and plural systems, polls, then release on
  web.
- **Recon on running Horizon's own link-card service** (internal).
- **Recon on hosting a LibreTranslate instance** (internal). Not adopted: posts
  translate in place through the browser where it can, and through Google
  Translate otherwise.
- **This changelog.**

### Changed

- **Bluesky's feature flags are read from a local table** set to Bluesky's
  public defaults as of 2026-10-14, not fetched from Bluesky.
- **Bluesky's beta features are on by default:** social proofing on posts and
  threads, redesigned notifications, and keeping your place in the Following
  feed (native only).
- **The web build serves from the site root** (`/_expo/...`), so `dist/` is a
  plain static folder for Cloudflare.
- Settings no longer shows "Send error report".

### Removed

- **Usage metrics and error reporting to Bluesky.** No events are queued or
  sent, and Sentry stays off even if a DSN is set.
- **Age assurance**, for every session, signed in or out.
- **Artwork not covered by Bluesky's MIT license:** the kawaii logo artwork
  and the landing-screen illustration, with `ASSETS.md` updated to match.

