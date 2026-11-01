# Patch notes

What changed in each Horizon release, for the people who use it. The app's
Patch notes screen (Settings → About, and `nearhorizon.app/patch-notes`)
and the Android download page are built from these files.

One file per release, named `<version>-<build>.md`. From build 14 on, the
version's last part is the build number, so build 14 is `0.1.14-14.md`:

```md
---
version: 0.1.14
build: 14
date: 2026-11-02
---

An optional one-line summary.

## New in Horizon

- Something we built.

## From Bluesky

- Something that came in from Bluesky's app.

## Fixes

- Something that works properly now.
```

- Any section can be left out, but keep this order.
- Each item is one plain sentence or two: no links and no formatting.
- After adding or changing a file, run `node scripts/horizon-patch-notes.js generate`.
