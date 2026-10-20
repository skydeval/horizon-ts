/*
 * The compose session: the composer owns the visibility record
 * (`state.ts`) for its lifetime and starts it from a member's private
 * posting defaults (`defaults/`). Kept apart from `state.ts` so that module,
 * which the write path and the drafts table read, imports no query or
 * session module.
 */

import {useLayoutEffect} from 'react'

import {
  applyLateComposeDefaults,
  initialComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
  startComposeVisibility,
  useIsPrivateCompose,
} from '#/horizon/private/composer/state'
import {usePrivateComposeDefaults} from '#/horizon/private/defaults/compose'
import {PRIVATE_POSTING} from '#/horizon/switches'

/**
 * Owns the record for the composer's lifetime: sets it up on mount and resets
 * it to Public on unmount. Called once in `ComposePost`. Returns whether the
 * compose is private, re-rendering the composer when that changes. A
 * member's private posting defaults apply when the session starts and when
 * they arrive later, until the record is set otherwise (a choice in the
 * control, a restored draft). `quote` is the post the composer opened
 * quoting: a member's quote starts as that post is (`state.ts`).
 */
export function usePrivateComposeSession(
  replyTo: {uri: string} | undefined,
  quote?: {uri: string},
): boolean {
  const replyToUri = replyTo?.uri
  const quoteUri = quote?.uri
  const defaults = usePrivateComposeDefaults()
  useLayoutEffect(() => {
    if (!PRIVATE_POSTING) return
    startComposeVisibility(initialComposeVisibility(replyToUri))
    return () => setComposeVisibility(PUBLIC_COMPOSE)
  }, [replyToUri, quoteUri])
  useLayoutEffect(() => {
    if (!PRIVATE_POSTING) return
    applyLateComposeDefaults(replyToUri, defaults, quoteUri)
  }, [replyToUri, defaults, quoteUri])
  return useIsPrivateCompose()
}
