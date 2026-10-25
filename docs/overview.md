# Horizon overview

_Last updated: 2026-10-24_

## What Horizon is

Horizon is a web client for atproto, the protocol behind Bluesky. It
starts from Bluesky's own app and changes as little of it as it can, so
that it keeps merging Bluesky's updates. Everything Bluesky's app does
still works: the home feed, custom feeds, search, DMs, video, push,
reporting, labelers and moderation settings.

On top of that, Horizon connects to **prism**, an AppView that serves
Horizon's own features. Some of these work for anyone who signs in. Others
are for members of the Horizon network.

Horizon is in early development.

## Who gets what

| Feature | Signed out | Signed in | Network member |
|---|---|---|---|
| Browse public content | yes | yes | yes |
| Backdrops and themes | yes, saved on the device | yes | yes |
| Spoilers and content warnings | read | read and write | read and write |
| Thread Lens | no | yes, off by default | yes, on by default |
| Restored accounts (Refract) | no | view and reply | view and interact |
| Read and write kryphocron posts | no | no | yes |
| Pronouns and plural systems (planned) | see | see and edit | see and edit |
| Polls (planned) | view | view | create and vote |

A feature that a reader doesn't have is left out of their interface, not
shown disabled.

**Membership** is decided by prism. After you sign in, Horizon asks prism
whether your account is a member and which features it serves. While prism
is still indexing a new member's account, Horizon shows the default
experience and a short note.

## Words used in these docs

- **PDS**: the server that hosts an account's repository. Horizon works
  with any PDS.
- **AppView**: a service that indexes the network and answers reads, such as
  feeds and threads. Bluesky runs one; prism is Horizon's.
- **prism**: Horizon's AppView, at `prism.nearhorizon.app`. It serves
  kryphocron posts, Thread Lens and Horizon's other features. It doesn't
  index ordinary public posts.
- **locus**: aurora-locus, a PDS with kryphocron support built in, at
  `locus.nearhorizon.app`. Members can be hosted there or anywhere else.
- **kryphocron**: a set of atproto record types (`tools.kryphocron.*`) for
  posts shown only to a chosen audience.
- **Kryphocron post**: a post written as a kryphocron record. The app labels
  these **Private**, with a lock icon.
- **Public post**: an ordinary `app.bsky.feed.post`.

## Where to go next

- [Architecture](architecture.md): the servers and how Horizon talks to them.
