<!-- HORIZON: Horizon's ui/ glyphs are Phosphor Icons (MIT), replacing Bluesky's licensed Central glyphs -->

**Rights holder: Phosphor Icons.**

The user-interface glyphs in [`ui/`](./ui/) are [Phosphor Icons](https://phosphoricons.com) (Bold for the outline styles, Fill for the filled ones), rescaled to the app's 24 and 64 unit grids. Phosphor is MIT licensed; its notice is in [`NOTICE.md`](../../NOTICE.md#phosphor-icons) and must travel with the app.

This notice covers the SVG files in `ui/`. It does not cover:

| Not covered here | Rights holder | See |
|---|---|---|
| `flags/` | @catamphetamine, MIT licensed | [`flags/README.md`](./flags/README.md) |
| `community/` | Third-party services | [`community/README.md`](./community/README.md) |
| `brands/` | Bluesky Social PBC, Apple Inc., and Google LLC | [`ASSETS.md`](../../ASSETS.md#3-bluesky-trademarks-and-brand-assets) and [`ASSETS.md`](../../ASSETS.md#5-third-party-trademarks) |

Adding an icon? Give the SVG its exact TypeScript export name, place it in the policy directory
that describes it, and run `pnpm icons:generate`. Names in `ui/` must include their style tokens,
for example `ArrowTop_Stroke2_Corner0_Rounded.svg`; codegen rejects bare or incomplete names. Each
file must be a single path. If it came from Phosphor, this notice already covers it. If it came
from anywhere else, add it to [`ASSETS.md`](../../ASSETS.md) so the notice does not go stale.
