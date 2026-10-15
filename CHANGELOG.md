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
