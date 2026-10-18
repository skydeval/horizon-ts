# Changelog

All notable changes to Horizon are recorded here, in the style of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Horizon has no
released version yet; everything so far is under `[Unreleased]`.

## [Unreleased]

### Added

- **The Horizon client's base.** Bluesky's social-app (1.135.0, commit
  `0cda84abe`) is imported with its full history into `horizon-ts/` as a git
  subtree. Bluesky's repository is a fetch-only `upstream` remote, and its
  updates are merged with
  `git subtree pull --prefix=horizon-ts upstream main` once for every
  Bluesky release.
- **`.gitignore`** for internal docs and local tooling (`docs/internal`,
  `.chainlink`, `.claude`).
- **The umbrella design for the Horizon client** (internal,
  `docs/internal/design/design.md`), drafted as `design-v1.md` and taken
  through a six-pass adversarial review that ended clean (reviews in
  `docs/internal/review/`). It sets what the client is, who gets
  which features, how Horizon code sits beside Bluesky's so upstream keeps
  merging, and the build order: foundations, login and server wiring,
  private posting, backdrops, Thread Lens, pronouns and plural systems,
  polls, then release on web.
- **Recon on running Horizon's own link-card service** (internal,
  `docs/internal/recon/cardyb-hosting.md`).
- **Recon on hosting a LibreTranslate instance** (internal,
  `docs/internal/recon/libretranslate-hosting.md`). Not adopted: posts
  translate in place through the browser where it can, and through Google
  Translate otherwise.
- **This changelog.**
- **Phase 0, foundations** (design: internal,
  `docs/internal/design/phase-0-foundations.md`).
  - `horizon-ts/src/horizon/` holds Horizon's own code: fixed switches
    (`switches.ts`), the local feature-flag table (`flags/`), a no-op metrics
    client (`telemetry/`) and the product name (`branding/product.json`).
    Its `README.md` sets the hook rules and keeps the hook ledger; every edit
    to a Bluesky file is marked `HORIZON:` and listed by
    `git grep -n "HORIZON:"`.
  - The product name is Horizon in page titles, the web page template and the
    app config.
  - `NOTICE.md` records that Horizon is built on Bluesky's social-app (MIT).
- **Phase 1, login and server wiring** (design: internal,
  `docs/internal/design/phase-1-login-and-wiring.md`).
  - **OAuth sign-in on web**, beside the password sign-in: the sign-in form
    has two tabs, OAuth (default) and Password, and remembers the last one.
    OAuth is a public client with PKCE and DPoP-bound tokens, through
    `@atproto/oauth-client-browser` 0.5.4, with its callback at
    `/auth/web/callback`.
  - **The OAuth client document** at `public/oauth-client-metadata.json`, for
    `https://nearhorizon.app/oauth-client-metadata.json`, built from one
    source and checked by a unit test; a development document beside it for
    local development against aurora-locus.
  - **OAuth sessions** that resume, refresh, sign out with revocation where
    the server offers it, end cleanly when the server ends them, and stay
    consistent across tabs. An ended account opens a sign-in window in place
    when switched to. Account operations that need the password (app
    passwords, deactivating or deleting the account, email and 2FA, handle)
    ask for it and switch the session to a password session.
  - **Signup with a server picker**: Horizon's server first, then Bluesky,
    then any server. Servers that offer OAuth account creation use it; others
    use the password signup with the server preselected.
  - **App servers** in Settings (and under the OAuth tab when signed out):
    Horizon's network (prism) is always connected; the public AppView is
    Bluesky's by default and can be changed.
  - **Network membership** is asked of prism at every sign-in, resume and
    app start, with a notice while a new account is being set up.
  - `NOTICE.md` credits the Witchsky client (MIT), whose code Horizon adapts
    for parts of the above.
  - **An OAuth sign-in must return the account that was asked for.** Horizon
    resolves the handle before leaving for the server and refuses a sign-in
    that comes back as a different account, with an error naming both. A
    sign-in cancelled at the server says so.
  - `scripts/silonew-dev.sh`, which runs the web dev server on a build host
    for testing through an SSH tunnel at `http://127.0.0.1:8081`.
- **Phase 2, private posting** (design: internal,
  `docs/internal/design/phase-2-private-posting.md`, steps 2A to 2D, 2F-1
  to 2F-5, the v2 fix batch and its round 2 and round 3 fixes, 2G
  spoiler tags, and 2H, adopting what prism serves
  (`docs/internal/design/phase-2h-prism-features.md`, 2H-1 to 2H-9); the
  parts that wait on server support are switched off until it lands).
  - **Writing private posts.** Members get **Public | Private** in the
    composer, with an audience: Everyone, Followers, People you follow, a
    list, a new list, or Only me. A reply in a private conversation is
    Private and cannot be made public; it is visible to whoever can see the
    conversation's first post now, and the composer says who that is. A
    private reply to a public post starts a private branch under the
    audience its author picks, and replies in that branch follow the
    branch's first post. Private posts and private threads are written to
    the account's own server through the kryphocron procedures, checked
    locally before they are sent, and never fall through to a public post; a
    failed private thread removes whatever was written. Private posts carry their languages and content warnings,
    and readers' clients apply the warnings as for a public post.
  - **The composer.** The **Public | Private** control sits centred in the
    composer's footer, between the media tools and the language and
    character count, as in the old Horizon client (on a phone it takes its
    own centred row above). Bluesky's interaction button stays where it is,
    above the footer, but opens one drop-down for both modes in place of
    Bluesky's pop-up, for every account: who can see (Private), who can
    reply (Anyone, Nobody, your followers, people you follow, people you
    mention, your lists, and "New reply list..." made right there), whether
    quotes are allowed, and "Save these options for next time"; while
    Private, Who can see offers "New audience...". Its label is "Anyone can
    interact" or "Interaction limited" in both modes, with the audience shown
    inside under Who can see; only a private reply that starts a branch,
    which has no reply settings, is labelled with its audience.
  - **Reply and quote limits on private posts.** A private post's limits are
    written as Bluesky's own threadgate and postgate records naming the
    private post, before the post itself; if they cannot be saved, nothing is
    posted. Until prism applies them, readers' clients read them: an opened
    private post dims reply and quote for a reader who is not allowed, and
    pressing reply or quote elsewhere says "Replies to this post are
    limited." or "Quote posts of this post are turned off." Rules the client
    cannot decide (lists, mentions) let the reader through.
  - **Editing a private post's settings.** The author's post menu offers
    "Edit who can see and interact": the same drop-down. Who can see can be
    changed in place on a post that starts a conversation or a private
    branch, keeping its link, replies and interactions; the dialog warns
    first that replies from people outside the new audience, and the
    replies under them, will be hidden from others, while the author's own
    stay visible. Other replies show who can see read-only. Who can reply
    (for the thread's author) and who can quote are saved as the stock
    records.
  - **Media in private posts.** Private mode offers the full media picker: a
    video (or a GIF from the photo library) uploads through Bluesky's video
    service as for a public post and is written into the private post, five
    to ten images are written as a gallery, a quote can carry images, a
    gallery, a video or a link card, and images keep their aspect ratio and
    link cards their thumbnail.
  - **Deleting a private post** deletes the private record, never a public
    post that shares its key.
  - **Drafts saved Private come back Private**, with their audience, and
    show a small lock in the drafts list.
  - **Audiences** in Settings, for members: the account's audiences, the
    people on each list, and New list.
  - **Network membership is found with prism's public indexing off**: the
    membership check falls back to prism's private timeline when the public
    one answers "not implemented".
  - **Reading private posts.** For members, Following merges the private
    posts of the accounts they follow (and their own) with the public
    timeline by time, and the author's just-written private posts show at
    once. Profiles gain a **Private** tab between Posts and Replies; Posts
    also merges the profile's private posts (and its own private
    self-threads) the reader may view, Replies its private posts and
    replies, both by time, and a pinned private post shows first on Posts,
    once. Private lists keep loading through pages that come back empty
    while more remain. Private threads open at
    `/profile/<handle>/ppost/<rkey>` with their public parent; "View post"
    after posting privately opens them. A quoted private post shows for
    readers who may view it and as a "Private post" card for everyone else.
    It arrives with the post that quotes it, in feeds, profiles, threads,
    Saved and notifications: every private quote on a page is read in one
    request before the page shows (waiting at most two seconds), and quotes
    already seen paint at once from the device while they are read again.
    A quote that still has to load holds its card's space with a quiet
    placeholder. Membership is remembered per account, so private reads
    start at launch while it is checked again in the background; composing
    privately waits for that check. Authors' servers are remembered for six
    hours. A private GIF-style video plays as a GIF.
    A pasted private post link becomes a quote. Private post links are
    shared on `https://nearhorizon.app`, and Embed post and Send via chat
    are not offered for them.
  - **How private posts look.** Every private post carries a lock the size
    of the header row's other icons, alone, at the right end of its header
    row (its top right corner), in
    feeds, thread replies, profiles, Saved and quotes; the name, handle and
    time truncate before it. There is no border (a trial look). An opened
    private post shows the lock, **Private** and who can see it ("Visible to Your followers",
    "Visible to Book club", "Visible to Followers of @alice"), read from the
    audience record; a reply to a private post shows the same in the
    composer. Links and hashtags in private posts are linked (found on the
    device until prism serves them), and links open directly instead of
    through Bluesky's redirect. Images, link cards, quotes, videos and
    galleries in private posts are shown from the post itself until prism
    serves their views.
  - **Controls on private posts.** Like, repost and quote work as on any
    post. Counts and the stats row under an opened post show when prism
    serves them, and the reader's own like, repost, bookmark and thread
    mute show as prism has them. The bookmark button and the menu's save
    item save the post with prism once prism says it stores private
    bookmarks; before that, pressing them says "Saving private posts isn't
    available yet." and saves nothing. Mute thread on a private thread,
    Hide reply for everyone and Detach quote are offered once prism says it
    applies them; Report post is not offered. On an opened private post that
    starts its thread, the author's who-can-reply line opens the post's
    settings. Deleting from a private
    post's thread goes back as from a public one. A private post the reader
    may not view shows a "Private post" card in its thread instead of "Post
    not found", and reply lines in private threads connect replies to their
    replies.
  - **Public | Private notifications** for members: a pair of folder tabs
    above the notification pills. Private has its own All and Replies pills
    and says "Activity on private posts will show here." until prism serves
    private notifications. Public notifications load when Bluesky's grouped
    notifications fail (as they do for a like or repost of a private post):
    that page is read from the plain notification list and grouped on the
    device instead, with the same rows and pills.
  - **Public | Private on Saved** for members, as the same folder tabs,
    under the Saved header in the centre column. Private lists saved private
    posts and replies, saved and removed through prism instead of Bluesky;
    when prism does not serve private bookmarks it says "Saved private posts
    will show here."
  - **Following what prism serves** (step 2H). Membership is
    asked of prism's own membership query, which also enrolls a new account,
    and prism's answer says which private features it serves; Horizon
    remembers that per account and turns each feature on or off from it, so
    a prism that gains or loses a feature is followed without a new release
    (the old check stays for a prism without the query). A feature list
    remembered from the last launch lets reading start at once, but nothing
    that writes uses it until prism answers again. With prism serving them:
    counts and the reader's state on private posts; private bookmarks;
    reply and quote limits applied by prism (the device's own check stays
    for a private branch under a public post); the profile's Posts tab
    filtered by prism; who can see read from prism, so a reply in a moved
    thread names its thread's audience, and a move made in Horizon holds
    against older answers for a minute; a moved or new post read back at
    once when prism says it has caught up; reposts of private posts by
    members shown as repost rows in Following and on profiles; and Mute
    thread on private threads, with a public thread's mute also sent to
    prism so private replies under it stop notifying (and brought back in
    line when Horizon sees the two disagree).
  - **Private activity, lists and search** (step 2H, second half), each
    while prism serves it. Liked by, Reposted by and Quotes on a private
    post list the members who did so (members only: prism neither counts
    nor lists anyone else), with public quotes shown as the public AppView
    has them. A private thread with more replies than one read brings shows
    "Show more replies" and "read more" rows that load the rest. Opening a
    public post shows the private replies under it that the reader may see,
    with their lock, for Top first under the post, for Newest and Oldest in
    time order among the public replies. The Private notifications view
    lists replies, quotes and mentions in private posts and members' likes,
    reposts, replies and quotes of the reader's private posts, with the
    stock rows (a lock in the corner of a private post's row, its links
    opened directly, and its reply button checking the post's reply
    limits); the Private tab shows prism's unread count, the notifications
    badge adds the private replies, quotes and mentions the public count
    cannot hold, and opening the view marks them seen. Search lists private
    posts the reader may see among the public results in Top and Latest
    (Latest by time, Top one private result after every two public ones),
    searching words and the author (`from:`, the author filter, Me); other
    filters apply to public results only, with a note. When recent private
    posts hold no match, "Search older posts" looks further back, up to a
    year. Moving a post's audience no longer carries the "until the server
    fully supports this" line, and a branch root's warning says the
    author's own replies inside it are checked too. Placing a reply deep in
    a private branch reads the branch in one request instead of one per
    level.
  - **Spoiler tags** (design: internal,
    `docs/internal/design/phase-2-spoilers.md`, step 2G), for everyone.
    Write `||secret||`, or select text and press the composer's spoiler
    button (web), and the text is covered until the reader presses it, in
    feeds, threads, quotes, notifications, Saved, search, the video feed and
    the reply preview; the video grid shows "[spoiler]" in its place. A
    spoiler on lines of its own is a closed drawer under the line above,
    opened by an arrow (or a "Spoiler" row when nothing comes before it).
    Public posts keep the `||` markers in their text, so other apps show
    them as written, and carry the spoilers as facets
    (`app.nearhorizon.richtext.facet`) so links and mentions inside stay
    linked everywhere. Private posts are written the same way until prism
    serves facets, then without the markers, which then no longer count
    toward the 300 characters. `\|` writes a literal pipe. A cover hides the
    text from view only: it is still in the post, in translations, in
    "Copy post text" and in muted-word matching. Posts from other apps that
    happen to contain `||` are shown as written.
    - **Reddit-style spoilers:** `>!secret!<` also works. It is published as
      `||secret||`, so every post carries one syntax.
    - **Hover hint:** on web, hovering a spoiler shows "Click to reveal", or
      "Click to hide" on an open drawer.
  - **Who can see and interact:** on web, the drop-down stays open while
    you choose, in every section, and closes on a click outside it or on its
    button. It no longer narrows when it grows tall enough to scroll.
  - **Media spoilers and content warnings** (design: internal,
    `docs/internal/design/phase-2j-media-spoilers-cw.md`, step 2J).
    - **Mark as spoiler:** the image alt text dialog and the video captions
      dialog have a "Mark as spoiler" checkbox, and a flagged thumbnail in
      the composer shows a "Spoiler" badge. The post records the flag on
      that image or video (`app.nearhorizon.spoiler`), public and private.
    - **Content warning** (web): a CW button in the composer's tools adds an
      optional line above the post ("cw blood"). The post is published as
      that line followed by the body as one hidden block, every image and
      video is flagged, and the post carries the `app.nearhorizon.cw`
      self-label. Other apps show the line, then the body between `||`
      markers. Spoilers already in the body are opened with the warning. The
      character count includes the line and the markers.
    - Drafts keep their spoiler flags and content warning on this device.
    - **Covers:** Horizon draws a flagged image or video under a heavy blur
      with a "Spoiler" pill, in feeds, threads, quotes, search, Saved and
      chats; one press (or Enter or Space) reveals it without opening the
      post, and on web hovering shows "Click to reveal". In a gallery each
      flagged image is covered on its own. A flagged video never plays on
      its own: the first press reveals it, the next plays it. The lightbox
      lists only the images already revealed. A covered image's alt text is
      not read out until it is revealed. Labelled media still show the
      moderation "Show" row first.
    - **Content warnings, shown:** a CW post shows its line with the drawer
      arrow, or a "Content warning" row when the line is empty; a one-line
      body with no line reads "Content warning" in place, and opens there.
      Every image and video of a CW post is covered with a "Content
      warning" pill; opening the text reveals no media, and the reverse. A
      post the CW post quotes is not covered unless it has its own flags or
      CW. Link cards and GIFs are never covered.
    - **Small previews:** notification thumbnails, the video cards and the
      reply preview's images of a post with spoiler media or a CW are
      blurred or left out (all of them), and sharing such a post into a
      chat shows "Media marked as spoiler" in place of its images. The video
      grid shows "[content warning]" in place of a CW's body.
    - **The line reads as a warning:** "CW: cw blood", set apart from the
      text, wherever the post shows (a line with only media too, and the
      video grid); screen readers hear "Content warning:". The stored text
      is unchanged. The post's labels list names the self-label "Content
      warning".

### Fixed

- After entering the password for a password-only screen (such as App
  passwords), the screen loads instead of keeping the error it hit under
  OAuth.
- A failed OAuth sign-in reopens the sign-in form on the OAuth tab, where its
  error is shown.

### Changed

- **Bluesky's feature flags are read from a local table** set to Bluesky's
  public defaults as of 2026-10-14, not fetched from Bluesky.
- **Bluesky's beta features are on by default:** social proofing on posts
  and threads, redesigned notifications, and keeping your place in the
  Following feed (native only).
- **The web build serves from the site root** (`/_expo/...`), so `dist/` is
  a plain static folder for Cloudflare.
- Settings no longer shows "Send error report".
- **Signing out also ends the session at the server**: OAuth grants are
  revoked where the server offers revocation, and password sessions are
  ended with the server (best effort).

### Removed

- **Usage metrics and error reporting to Bluesky.** No events are queued or
  sent, and Sentry stays off even if a DSN is set.
- **Age assurance**, for every session, signed in or out.
- **Artwork not covered by Bluesky's MIT license:** the kawaii logo artwork
  and the landing-screen illustration, with `ASSETS.md` updated to match.
