/*
 * Lens posts whose `viewer.embeddingDisabled` nobody checked (2026-10-25).
 * A member's lens post that skips the public-view pass carries prism's view,
 * and prism knows a post's postgate only where it stores it. Such a post
 * shows Quote as allowed. Stock does not check the postgate again when
 * quoting from a post's button: `openComposer` puts the post's view in the
 * link cache (`precacheResolveLinkQuery`), and the send reads it from there.
 * So `openComposer` marks the cached entry stale for a URI held here, and
 * the send reads the post from the AppView again (`resolveLink`), which
 * refuses with stock's "This post's author has disabled quote posts." when
 * the author did. Public post URIs only; at most {@link HELD_MAX}, oldest
 * dropped first.
 */

const HELD_MAX = 2000

const held = new Set<string>()

/** `uri`'s lens view carried no `embeddingDisabled`. */
export function noteEmbeddingUnchecked(uri: string) {
  held.delete(uri)
  held.add(uri)
  if (held.size > HELD_MAX) {
    const oldest = held.values().next().value
    if (oldest !== undefined) held.delete(oldest)
  }
}

/** `uri`'s view came from the AppView after all: the flag is known. */
export function noteEmbeddingChecked(uri: string) {
  held.delete(uri)
}

/** Whether quoting `uri` must read its postgate again at send. */
export function isEmbeddingUnchecked(uri: string): boolean {
  return held.has(uri)
}

/** Tests: forget every URI. */
export function resetEmbeddingUnchecked() {
  held.clear()
}
