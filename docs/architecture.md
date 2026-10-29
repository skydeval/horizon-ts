# Architecture

_Last updated: 2026-10-24_

This page covers the servers Horizon talks to, how each call finds its
server, and how Horizon's code sits inside Bluesky's app.

## The services

```
                 +------------------------------+
                 |  Horizon (web app)           |
                 +------------------------------+
                   |            |            |
       repo writes |   reads    |   reads    | kryphocron reads
       and proxied |            |            | (some direct)
       reads       v            |            v
          +----------------+    |    +---------------------+
          | Your PDS       |----+--->| prism               |
          | (any PDS)      | proxy    | Horizon's AppView   |
          +----------------+    |    +---------------------+
                   |            v
                   |    +---------------------+
                   +--->| Public AppView      |
                  proxy | (Bluesky's default) |
                        +---------------------+
```

| Service | What it does for Horizon |
|---|---|
| **Your PDS** | Sign-in, every write to your repository, and the proxy that forwards your reads to AppViews. Any atproto PDS works. |
| **prism** (`prism.nearhorizon.app`) | Horizon's AppView. Serves kryphocron posts to their audiences, membership, Thread Lens, restored accounts, private bookmarks, notifications and search, and every `app.nearhorizon.*` call. It does not index public posts. |
| **The public AppView** | Ordinary `app.bsky.*` reads: timelines, profiles, public threads. Bluesky's AppView by default; you can switch it. |
| **Bluesky's other services** | Chat, video upload, push notifications, custom feeds and labelers work as in Bluesky's app. One difference: an adult can turn Bluesky's own moderation labeler off in Moderation settings. Minors, and accounts whose age Horizon can't tell, keep it. Takedowns and the legal labelers for the user's country stay either way. |
| **locus** (`locus.nearhorizon.app`) | A PDS with kryphocron support. Accounts hosted there write kryphocron posts through locus's own procedures. Accounts elsewhere don't need it. |

### Two AppViews at once

Horizon is always connected to two AppViews:

- **prism is fixed.** Horizon's features always go to prism. In the AppView
  switcher it shows as a greyed row: "Always connected".
- **The public AppView is switchable.** It defaults to Bluesky's. The
  switcher (a row in Settings, or a button under the OAuth sign-in form) accepts
  any AppView whose `did:web` document lists a `#bsky_appview` service.
  Changing it reloads the app, so every client is rebuilt. OAuth accounts
  don't need to sign in again.

A member's Following feed is the public AppView's timeline merged by time
with prism's kryphocron timeline, whichever public AppView is chosen.

## How a call finds its server

One routing table in Horizon's code decides where each call goes:

| Call | Goes to |
|---|---|
| `app.nearhorizon.*` | prism |
| Anything whose subject is a kryphocron post (its thread, likes, reposts, quotes, bookmark) | prism |
| The kryphocron side of bookmarks, search and notifications | prism, merged with the public side in the client |
| Writing records (posts, likes, audiences, appearance) | your PDS |
| Custom feeds | Bluesky's AppView, as in Bluesky's app |
| Chat, video, push | Bluesky's services, as in Bluesky's app |
| Every other `app.bsky.*` read | the public AppView |

**Signed in**, most calls go to your PDS with an `atproto-proxy` header
naming the AppView. The PDS mints a short-lived service token for that one
method and forwards the call. Horizon holds no long-lived prism token.

For a few kryphocron and Refract reads Horizon calls prism directly, with a
per-method service token from your PDS that it keeps in memory for up to an
hour. This keeps reads fast, and keeps the text of your own kryphocron posts
from passing back through your PDS.

**Signed out**, Horizon calls the public AppView directly, and prism only
for its few public reads. Thread Lens and kryphocron reads are never made
signed out.

## Membership

Horizon asks prism, through your PDS, whether your account is a member and
which features prism serves (`app.nearhorizon.actor.getMembership`). The
answer is one of:

| State | What you see |
|---|---|
| unknown | the default experience, until prism answers |
| indexing | the default experience, plus a note that your account is being indexed |
| member | network features on |
| not a member | the default experience |

Features are switched on per account from prism's answer, not from a
version number. When prism adds a feature, Horizon turns on the matching
part of the interface. When prism doesn't list it, that part stays hidden or
uses a simpler interim behaviour.

When prism is busy or catching up, Horizon keeps your membership as it was
and handles the gap quietly.

## Inside the app

Horizon is a fork that wants to keep merging upstream. The rules that make
that work:

- **Horizon's code lives in `horizon-ts/src/horizon/`.** Folders there
  include `session/` and `auth/` (sign-in), `routing/` (the AppViews,
  membership, the routing table), `private/` (kryphocron posts), `spoilers/`
  and `media-spoilers/`, `backdrops/` and `appearance/`, `thread-lens/`,
  `refract/` and `lexicons/`.
- **Changes to Bluesky's files are hooks**: an import and one call, value,
  guard or component, with a `// HORIZON:` comment on the line above.
  `git grep -n "HORIZON:"` lists them all.
- **Switches.** Most hooks are guarded by a constant in
  `horizon-ts/src/horizon/switches.ts`. Turning one off restores Bluesky's behaviour at
  that hook.
- **Bluesky's types aren't widened.** Horizon data that travels with a
  Bluesky object, such as the audience of a kryphocron post, sits in a side
  store keyed by URI or DID.
- **Bluesky's components do the drawing.** A kryphocron post is converted
  into the shape Bluesky's post components expect, so it renders, moderates
  and interacts like any other post.
- **Upstream merges** come in with `git subtree pull` once per Bluesky
  release.

### Records Horizon uses

| Record or method | Where it lives | Used for |
|---|---|---|
| `tools.kryphocron.feed.postPrivate` | author's repo | a kryphocron post |
| `tools.kryphocron.policy.audience` | author's repo | who may read a kryphocron post |
| `app.bsky.feed.threadgate`, `app.bsky.feed.postgate` | author's repo | reply and quote limits and hidden replies, on public and kryphocron posts |
| `app.nearhorizon.actor.appearance` | your repo (if you choose public) | your backdrop and theme settings |
| `app.nearhorizon.actor.postingDefaults` | your repo | how new kryphocron posts start, and reading choices |
| `app.nearhorizon.richtext.facet` | inside post records | spoilers and content warnings |
| `app.nearhorizon.private.*`, `app.nearhorizon.threadLens.*` | prism | kryphocron reads, Thread Lens |

### Privacy in the client

- Bluesky's analytics and error reporting are switched off.
- Bluesky's age assurance is switched off too, with one narrow exception:
  the Android app, in US states whose app store laws require apps to act on
  the age a phone's app store reports. That's Texas now, Utah from
  31 December 2026 and Louisiana from 1 July 2027. There, Horizon asks
  Google Play for the user's age range. Under 13 can't use the app, under
  18 has adult content locked off, and nothing else changes. The state
  comes from the same rough location lookup the app already makes.
- It's built that way because of what the laws cover. They apply to apps
  from app stores, not websites, so web never checks, and nowhere else asks
  for a check. Horizon reads the store's answer instead of running Bluesky's
  own verification, so it never asks for ID, a selfie or a birthdate itself.
- Bluesky's feature flags are read from a local table, not fetched.
- Horizon's logs never include the text of a kryphocron post.
