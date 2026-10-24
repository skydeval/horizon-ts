## @bsky/sdk Patch

### Preference ids from an app-set source, per client

The sdk mints ids for saved feeds and muted words on its own TID clock
(`dist/tid.js`), one clock id for the whole page. The mints are in
`dist/actions/preferences.js`: `getPreferences` (the v1 to v2 saved-feed
migration, and the default Following feed it writes into an account with no
saved feeds), `addSavedFeeds`, `addMutedWord`, `updateMutedWord`, and the
legacy muted-word id backfill that `addMutedWord`, `updateMutedWord` and
`removeMutedWord` run. When one page uses several accounts, those ids carry
the same clock id into each account's preferences, which links the accounts
for anyone who reads them.

The patch adds `setTidSource(source)`, exported from the package root, and
passes the action's `client` to every `nextTid` call. When a source is set,
`nextTid(client)` returns what the source returns for that client, and uses
the built-in clock only when it returns `undefined`. Horizon sets the source
in `src/horizon/tid-clock/sdk-ids.ts`, from both app entries, to mint on the
client's own account's clock (Phase 5 design, Appendix A).

`src/horizon/tid-clock/__tests__/next-tid-test.ts` checks that no `nextTid()`
without a client, and no other TID clock, is left in the installed sdk, so an
upgrade that adds a mint fails the guard.

**TODO: Remove if upstream lets the caller supply preference ids.**
