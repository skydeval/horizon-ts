/*
 * The compose session: the composer owns the visibility record
 * (`state.ts`) for its lifetime and starts it from a member's private
 * posting defaults (`defaults/`). Kept apart from `state.ts` so that module,
 * which the write path and the drafts table read, imports no query or
 * session module.
 *
 * It also owns the "Posting as" record (`posting-as/`, Phase 5 design 8)
 * for the same lifetime, and hands the composer the posting account's
 * routes, handle and hold as values from subscriptions (PA-26, P5R7-N1).
 */

import {useLayoutEffect} from 'react'

import {type ComposerOptsPostRef} from '#/state/shell/composer'
import {usePostingAllows} from '#/horizon/posting-as/compose-store'
import {
  endPostingSession,
  startPostingSession,
} from '#/horizon/posting-as/gates'
import {usePostingHandle, usePostingRoutes} from '#/horizon/posting-as/routes'
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
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {type WriteRoutes} from '#/horizon/routing/write-route'
import {PRIVATE_POSTING} from '#/horizon/switches'

/**
 * Owns the record for the composer's lifetime: sets it up on mount and resets
 * it to Public on unmount. Called once in `ComposePost`. Returns whether the
 * compose is private, its audience and the **posting** account's routes
 * (`audience` and `postingRoute`, for the composer's `privateComposeAllows`,
 * 2K design PA-26; another account's mapped to `none` off `locus`, Phase 5
 * 8.5), the posting account's handle for the notes that name it, and
 * `postingAllows`, false while the posting account's hold is on (Phase 5
 * 8.2), re-rendering the composer when any of them changes. A member's
 * private posting defaults apply when the session starts and when they
 * arrive later, until the record is set otherwise (a choice in the control,
 * a restored draft, an account change). `quote` is the post the composer
 * opened quoting: a member's quote starts as that post is (`state.ts`).
 */
export function usePrivateComposeSession(
  replyTo: ComposerOptsPostRef | {uri: string} | undefined,
  quote?: {uri: string},
): {
  isPrivate: boolean
  audience: ComposeAudience
  postingRoute: WriteRoutes
  postingHandle: string | undefined
  postingAllows: boolean
} {
  const replyToUri = replyTo?.uri
  const quoteUri = quote?.uri
  const defaults = usePrivateComposeDefaults()
  useLayoutEffect(() => {
    // The posting account starts as the current one (Phase 5 8.1).
    const current = getCurrentClients()
    if (current) startPostingSession(current.did, current.handle)
    if (!PRIVATE_POSTING) return () => endPostingSession()
    startComposeVisibility(initialComposeVisibility(replyToUri))
    return () => {
      endPostingSession()
      setComposeVisibility(PUBLIC_COMPOSE)
    }
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
  const postingRoute = usePostingRoutes()
  const postingHandle = usePostingHandle()
  const postingAllows = usePostingAllows()
  return {isPrivate, audience, postingRoute, postingHandle, postingAllows}
}
