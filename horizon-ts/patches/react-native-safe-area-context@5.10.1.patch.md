# react-native-safe-area-context@5.10.1.patch

## Web: report window insets, not insets clamped to the provider view

5.8+ changed `NativeSafeAreaProvider.web` to measure the provider's DOM node
(`getBoundingClientRect`, re-read by a `ResizeObserver`) and report
`top: max(0, envTop - rect.top)` and
`bottom: max(0, envBottom - (innerHeight - rect.bottom))`. 5.7 reported the
`env(safe-area-inset-*)` values as they are.

The app's `SafeAreaProvider` (`App.web.tsx`) wraps the whole document, and the
web app scrolls the window. So the provider's `rect.top` is `-scrollY`, and
every re-read while the page is scrolled (the page growing as a list loads,
the lightbox's scrollbar lock changing the width, a window resize) sets the top
inset to the scroll offset and the bottom inset to the content below the fold.
`Layout.Screen` pads its top by `useSafeAreaInsets().top`, so the centre column
dropped by the scroll offset with empty space above it, and every inset
consumer re-rendered on each re-read.

The patch sets `canMeasureProviderElement` to `false` (src + lib/module +
lib/commonjs), so web is window-based again, as in 5.7. Native is untouched.
Tested by `src/horizon/backdrops/__tests__/safe-area-scroll-test.tsx`.

Upstream bsky (also on 5.10.1) has the same code path. Drop this patch once
the library stops clamping to the provider for a window-scrolled provider, or
once upstream works around it.
