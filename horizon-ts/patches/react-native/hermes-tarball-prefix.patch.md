# hermes-tarball-prefix

Horizon patch (native Android app, 2026-10-28).

Building React Native from source (`buildReactNativeFromSource: true`)
downloads Hermes's source tarball and unpacks it into `sdks/hermes`, dropping
the tarball's top folder. The unpack step only drops a folder named
`facebook-hermes-<SHA>`, but the tarball's folder is now `meta-hermes-<SHA>`.
Nothing was dropped, so CMake found no `CMakeLists.txt` in `sdks/hermes` and
`configureBuildForHermes` failed.

The patch drops either prefix. Remove it once upstream handles the new name.
