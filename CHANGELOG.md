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

### Changed

- **Bluesky's feature flags are read from a local table** set to Bluesky's
  public defaults as of 2026-10-14, not fetched from Bluesky.
- **Bluesky's beta features are on by default:** social proofing on posts
  and threads, redesigned notifications, and keeping your place in the
  Following feed (native only).
- **The web build serves from the site root** (`/_expo/...`), so `dist/` is
  a plain static folder for Cloudflare.
- Settings no longer shows "Send error report".

### Removed

- **Usage metrics and error reporting to Bluesky.** No events are queued or
  sent, and Sentry stays off even if a DSN is set.
- **Age assurance**, for every session, signed in or out.
- **Artwork not covered by Bluesky's MIT license:** the kawaii logo artwork
  and the landing-screen illustration, with `ASSETS.md` updated to match.
