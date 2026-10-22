# kryphocron-web (vendored build)

Prebuilt browser package for encoding `tools.kryphocron.feed.postPrivate`
records in the client. Built from kryphocron's `wasm/` directory; Horizon's
build needs no Rust, clang, wasm-bindgen or binaryen.

## Provenance

| | |
|---|---|
| kryphocron tag | `v0.4.5` |
| kryphocron commit | `2721f264596a3be4eb72164458e09b6eb9397baf` |
| Source | `git archive v0.4.5` (a clean export of the tag, not a working tree) |
| Built | 2026-10-29 |
| rustc | 1.88.0 (6b00bc388 2025-06-23), with `rust-src` for `build.sh`'s rebuilt std |
| clang | Ubuntu clang 21.1.8 (zstd's C encoder, wasm32 target) |
| wasm-bindgen-cli | 0.2.129 (matches `wasm-bindgen` in `wasm/Cargo.lock`) |
| binaryen (wasm-opt) | version 132 |

| File | sha256 |
|---|---|
| `kryphocron_web_bg.wasm` (342,850 bytes) | `db1497a72c69f683279161650a31b97057af758ad866958020f5afad641e603a` |
| `kryphocron_web.js` | `0bf6406c8f929a93d885394b2db74b3e77457f3fb0a0863ae329a1e58bfab4bf` |
| `kryphocron_web.d.ts` | `c946dd45a8ee32ccd55a3aa03d6be8a51b7a0fa25e24781c3200e884ebb1cfb4` |
| `kryphocron_web_bg.wasm.d.ts` | `a45f5ba55a426757d55e69b7d478af4bd2402dc338bbca317fa927dda572a0c1` |

`kryphocron_web.js`, `kryphocron_web.d.ts`, `kryphocron_web_bg.wasm` and
`kryphocron_web_bg.wasm.d.ts` are exactly as wasm-bindgen and wasm-opt emitted
them. `package.json` is hand-written, because wasm-bindgen (unlike wasm-pack)
doesn't emit one.

## Build command

From a clean export of the tag, in its `wasm/` directory:

```sh
./build.sh web
```

which runs:

```sh
cargo build --release --target wasm32-unknown-unknown --locked
wasm-bindgen --target web --out-dir pkg-web \
  target/wasm32-unknown-unknown/release/kryphocron_web.wasm
wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  pkg-web/kryphocron_web_bg.wasm -o pkg-web/kryphocron_web_bg.wasm
```

The same tag's `./build.sh nodejs` build passed `wasm/test/smoke.mjs`
under Node 24.

## Usage

An ES module with an async default `init()`. Load it lazily when a private
post is written:

```ts
const { default: init, preparePrivatePost } = await import('…/vendor/kryphocron-web/kryphocron_web.js');
await init(); // fetches kryphocron_web_bg.wasm next to the .js
const fields = JSON.parse(
  preparePrivatePost(did, 'tools.kryphocron.feed.postPrivate', rkey,
    JSON.stringify({ text, facets, embed }), Math.floor(Date.now() / 1000)),
);
// Merge `fields` into the record and leave out text/facets/embed. Then write
// it at exactly this did + collection + rkey (createRecord with that rkey,
// or putRecord).
```

`init()` takes an explicit URL or `Response` if the bundler moves the
`.wasm`.

## JavaScript build for native

The Android app's engine (Hermes) has no WebAssembly, so it runs the same
`.wasm` converted to plain JavaScript (2026-10-28):

| File | What | sha256 |
|---|---|---|
| `kryphocron_web_bg.wasm2js.js` | the `.wasm` above as JavaScript, exporting `instantiate(imports)` | `fd256058abe74227ab4f1a98a65e3f67325d27d57a16e82aae337affbc0a0a83` |
| `kryphocron_web_native.js` | the glue, with its memory caches compared against the current buffer and the async init's web path removed | `5dbc349ba7e82735b19aec403f24029a0358dff5b0491bb87b8ccdfd98c258cc` |
| `kryphocron_web_bg.wasm2js.d.ts`, `kryphocron_web_native.d.ts` | their types | |

Both are generated; don't edit them. Made with binaryen `version_132` from
the `.wasm` above (sha256 `db1497a7…603a`):

```sh
B=~/android-tools/binaryen-version_132/bin
$B/wasm-opt kryphocron_web_bg.wasm \
  --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --llvm-nontrapping-fptoint-lowering --signext-lowering \
  --llvm-memory-copy-fill-lowering -o lowered.wasm
$B/wasm2js lowered.wasm -O2 -o kryphocron_web_bg.wasm.js
node scripts/kryphocron-native.mjs kryphocron_web_bg.wasm.js vendor/kryphocron-web
node scripts/kryphocron-native-check.mjs
```

wasm2js can't convert the saturating float-to-int instructions, hence the
lowering passes first. The glue change is needed because a WebAssembly
memory detaches its old buffer when it grows, which is what the stock glue
watches for; wasm2js's memory swaps in a new buffer instead.

`kryphocron-native-check.mjs` encodes 217 inputs on both builds with the
same deterministic randomness (plain text, emoji and other scripts, mentions
and links, images, quotes, bad inputs, and 200 posts up to 20,000 characters
that grow memory) and requires every output and error to be byte-identical.
It must pass before these files change.

## Refreshing for a new tag

On the build host, with the tools above installed:

```sh
git -C <kryphocron checkout> archive vX.Y.Z | tar -x -C /tmp/kryphocron-vX.Y.Z
cd /tmp/kryphocron-vX.Y.Z/wasm
./build.sh nodejs && node test/smoke.mjs   # sanity check
./build.sh web
sha256sum pkg-web/kryphocron_web_bg.wasm pkg-web/kryphocron_web.js
```

Then:
1. Copy the four files from `pkg-web/` over these.
2. Bump `version` in `package.json`.
3. Update this file's tables (tag, commit, tool versions, hashes).
4. Rebuild the JavaScript build for native (above) and run its check.

Make sure `wasm-bindgen-cli` matches the `wasm-bindgen` version in that
tag's `wasm/Cargo.lock`, or the glue and the module won't match.
