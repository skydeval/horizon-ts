# src/horizon

All of Horizon's own code. Bluesky's code lives everywhere else in this tree
and is merged from upstream once for every Bluesky release, so Horizon keeps
its logic here and touches Bluesky's files only through small, marked hooks.

| Path | What it is |
|---|---|
| `index.ts` | Side-effect-free barrel: re-exports branding and switches. |
| `switches.ts` | Fixed booleans that hooks guard on. Flipping one restores Bluesky's behaviour at that hook. |
| `flags/` | The local feature-flag table that replaces Bluesky's GrowthBook fetch. |
| `telemetry/` | The no-op metrics client. |
| `branding/` | The product name. `product.json` is its one source. |

## Hook rules

A hook is any edit to a file that came from Bluesky.

1. A hook is an import plus a single call, value, guard or component. Logic
   stays in `src/horizon/`.
2. Every hook carries a marker on the line above it:
   - TypeScript and JavaScript: `// HORIZON: <why>`
   - inside JSX: `{/* HORIZON: <why> */}`
   - HTML and Markdown: `<!-- HORIZON: <why> -->`
3. Prefer guarding Bluesky's code with a switch from `switches.ts` over
   deleting it, so imports stay used and an upstream merge sees one line.
   Where code must go, the imports only it used go in the same hook.
4. Bluesky's types are not widened. Horizon data travelling with a Bluesky
   object lives in a side store keyed by URI or DID.
5. A Bluesky file is never forked into a Horizon copy.
6. New user-facing text goes through Lingui.

Hooks must keep `pnpm typecheck`, `pnpm lint` and `pnpm test` passing.

## Hook ledger

From `horizon-ts/`:

```
git grep -n "HORIZON:"
```

Matches under `src/horizon/` are this file and are not hooks. Add the list
below to that output for the complete ledger.

### Hooks without markers

| Hook | Why it has no marker |
|---|---|
| Deleted `assets/kawaii.png`, `assets/kawaii_smol.png` | Community artwork not covered by MIT (`ASSETS.md`). Deleted files carry no marker. |
| Deleted `assets/illustrations/illustration-mobile.png`, `illustration-mobile-dark.png`, `README.md` | Commissioned illustration not covered by MIT (`ASSETS.md`). |

### Literal copies of the product name

`branding/product.json` is the name's one source. These files cannot import
it and carry the name literally; a rename updates them too.

- `public/index.html`: `<title>`, the meta description, the `<noscript>` text.
