## @bsky.app/video Patch

### Android: videos that stop and never start again

Three gaps in the Android player left a feed video frozen or black until the
reader scrolled away and back.

**Playback errors.** The player had no error handler, and `onError` was
declared but never sent. A failed segment fetch (a network handover) or a
decoder that could not start left a dead player showing its last frame, and
Play called `play()` on it without preparing it again. The patch prepares a
failed player again up to three times (after 1, 2 and 4 seconds), skipping
retries while the app is in the background, where the foreground recovery
prepares it. After that it sends `onError`, so the embed's error screen with
Retry shows. Play on a failed player prepares it first.

**Detached active videos.** A detached view releases its player, but stayed
the active view, so `updateActiveView` saw the same pick and did nothing:
coming back to a covered screen, or a row clipped by `removeClippedSubviews`
and drawn again, showed a black box. Now `removeView` forgets the active view
(telling JS it is inactive), a view attached or detached while nothing is
active schedules a re-pick 150 ms later, and a pick that is still active but
lost its player is started again.

**Rebuffering.** The loading state was set only at setup, so a slow segment
looked like a freeze. It now shows while the player buffers mid-play and
clears when it is ready.

**TODO: Remove if upstream handles player errors and detached active views.**
