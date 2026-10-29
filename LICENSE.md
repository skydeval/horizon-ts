# Licenses

Horizon is built on Bluesky's social-app, so this repository holds code
under two licenses.

## Bluesky's social-app: MIT

Everything under `horizon-ts/` that comes from Bluesky's
[social-app](https://github.com/bluesky-social/social-app) is under the MIT
license in [`horizon-ts/LICENSE`](horizon-ts/LICENSE). That includes the
small `HORIZON:` hooks Horizon adds inside those files. Some of Bluesky's
assets are not covered by that license; `horizon-ts/ASSETS.md` lists them.

## Horizon's own code: MPL-2.0

The code Horizon adds is under the Mozilla Public License 2.0, in
[`horizon-ts/licenses/MPL-2.0.txt`](horizon-ts/licenses/MPL-2.0.txt):

- `horizon-ts/src/horizon/`
- `horizon-ts/functions/horizon-geolocation.ts`,
  `horizon-ts/functions/api/v1/statuses/[id].ts`,
  `horizon-ts/functions/profile/[name]/post/[rkey].ts` and
  `horizon-ts/functions/profile/[name]/ppost/[rkey].ts`
- `horizon-ts/scripts/horizon-preview-pages.js`,
  `horizon-ts/scripts/kryphocron-native.mjs` and
  `horizon-ts/scripts/kryphocron-native-check.mjs`
- the patches Horizon adds under `horizon-ts/patches/`
- everything in this repository outside `horizon-ts/`

This Source Code Form is subject to the terms of the Mozilla Public License,
v. 2.0. If a copy of the MPL was not distributed with this file, You can
obtain one at https://mozilla.org/MPL/2.0/.

## Others

`horizon-ts/vendor/kryphocron-web/` is a build of
[kryphocron](https://github.com/skydeval/kryphocron), also under MPL-2.0.
[`horizon-ts/NOTICE.md`](horizon-ts/NOTICE.md) collects every third-party
notice: fonts, icons, flags, the encoder, Bluesky and Witchsky.
