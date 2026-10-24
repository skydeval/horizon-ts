/*
 * The compose session: the composer owns the visibility record
 * (`state.ts`) for its lifetime and starts it from a member's private
 * posting defaults (`defaults/`). Kept apart from `state.ts` so that module,
 * which the write path and the drafts table read, imports no query or
 * session module.
 */

import {useLayoutEffect} from 'react'

import {type ComposerOptsPostRef} from '#/state/shell/composer'
import {
  applyLateComposeDefaults,
  type ComposeAudience,
  initialComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeReplyRef,
  setComposeVisibility,
  startComposeVisibility,
  useComposeAudience,
  useIsPrivateCompose,
} from '#/horizon/private/composer/state'
import {usePrivateComposeDefaults} from '#/horizon/private/defaults/compose'
import {useWriteRoute, type WriteRoutes} from '#/horizon/routing/write-route'
import {PRIVATE_POSTING} from '#/horizon/switches'

/**
 * Owns the record for the composer's lifetime: sets it up on mount and resets
 * it to Public on unmount. Called once in `ComposePost`. Returns whether the
 * compose is private, its audience and the account's routes (`audience` and
 * `postingRoute`, for the composer's `privateComposeAllows`, 2K design
 * PA-26), re-rendering the composer when any of them changes. A
 * member's private posting defaults apply when the session starts and when
 * they arrive later, until the record is set otherwise (a choice in the
 * control, a restored draft). `quote` is the post the composer opened
 * quoting: a member's quote starts as that post is (`state.ts`).
 */
export function usePrivateComposeSession(
  replyTo: ComposerOptsPostRef | {uri: string} | undefined,
  quote?: {uri: string},
): {
  isPrivate: boolean
  audience: ComposeAudience
  postingRoute: WriteRoutes
} {
  const replyToUri = replyTo?.uri
  const quoteUri = quote?.uri
  const defaults = usePrivateComposeDefaults()
  useLayoutEffect(() => {
    if (!PRIVATE_POSTING) return
    startComposeVisibility(initialComposeVisibility(replyToUri))
    return () => setComposeVisibility(PUBLIC_COMPOSE)
  }, [replyToUri, quoteUri])
  useLayoutEffect(() => {
    setComposeReplyRef(
      replyTo && 'cid' in replyTo && 'author' in replyTo ? replyTo : undefined,
    )
    return () => setComposeReplyRef(undefined)
  }, [replyTo])
  useLayoutEffect(() => {
    if (!PRIVATE_POSTING) return
    applyLateComposeDefaults(replyToUri, defaults, quoteUri)
  }, [replyToUri, defaults, quoteUri])
  const isPrivate = useIsPrivateCompose()
  const audience = useComposeAudience()
  const postingRoute = useWriteRoute()
  return {isPrivate, audience, postingRoute}
}
