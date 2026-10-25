# Horizon

Horizon is an [atproto](https://atproto.com) client built on Bluesky's open
source app, [social-app](https://github.com/bluesky-social/social-app). It
keeps everything the Bluesky app does (feeds, DMs, video, custom feeds,
search, moderation) and adds features for a small network of accounts
served by Horizon's own AppView, **prism**. It is meant to live at
`nearhorizon.app`.

Anyone can sign in to Horizon with an account on any PDS. Some features
work for every reader. Others, such as audience-limited posts, are for
members of the Horizon network.

## What it adds

- **Sign in with OAuth or a password**, against any PDS, with a switcher
  for which public AppView you read from.
- **Kryphocron posts** (labelled "Private" in the app): posts shown only to
  the audience you choose.
- **Spoilers and content warnings**: `||inline spoilers||`, per-image
  spoiler blur, and Mastodon-style content warnings.
- **Backdrops and glass themes**: gradient backdrops behind the app, with
  light, dim and dark glass, and a choice of where your appearance is saved.
- **Thread Lens**: a thread view that keeps the shape of a conversation
  when blocks or deletions cut it, with labelled placeholders.
- **Hidden replies** on kryphocron threads, behind the same "Show more
  replies" row Bluesky uses.
- **Reply blocks**: Horizon won't send a kryphocron reply across a block
  with the person you're replying to, or with the thread's original poster.
- **Restored accounts (Refract)**: accounts that Bluesky's AppView no
  longer serves, shown when a community that prism's operator trusts still
  hosts them.
- **Pronouns and plural systems**: pronouns beside every name, plural
  system profiles with members and front, posts that show which members
  wrote them, and posting as another signed-in account or as members.
- **Planned**: polls and fundraisers.

## Status

**Early development, pre-alpha.** Nothing is released. The web app runs
for a handful of testers. Features change often, and stored settings may be
reset without migration. Native iOS and Android builds are not a near-term
goal: web comes first.

## Repository layout

| Path | What it holds |
|---|---|
| `horizon-ts/` | The app: a git subtree of Bluesky's social-app, merged from upstream from time to time |
| `horizon-ts/src/horizon/` | Horizon's own code. Changes to Bluesky's files are small hooks marked `HORIZON:` |
| `docs/` | Documentation: overview and architecture |
| `CHANGELOG.md` | What has changed so far |

## Read more

- [Overview](docs/overview.md): what Horizon is, who gets what, and the
  vocabulary.
- [Architecture](docs/architecture.md): the servers Horizon talks to and how
  calls are routed.

## Credits and licenses

- Horizon is built on Bluesky's
  [social-app](https://github.com/bluesky-social/social-app), which is MIT
  licensed (`horizon-ts/LICENSE`). Some of Bluesky's assets are not covered
  by that license; `horizon-ts/ASSETS.md` lists them, and Horizon replaces
  them before release.
- Horizon adapts code from the
  [Witchsky](https://tangled.org/jollywhoppers.com/witchsky.app) client,
  under the MIT license.
- Kryphocron posts are encoded with `kryphocron-web`, an unmodified
  WebAssembly build of the [kryphocron](https://github.com/skydeval/kryphocron)
  encoder, under the Mozilla Public License 2.0
  (`horizon-ts/licenses/MPL-2.0.txt`).
- `horizon-ts/NOTICE.md` collects every third-party notice (fonts, icons,
  flags, the encoder, Bluesky and Witchsky). If you redistribute Horizon,
  those notices travel with it.
