/*
 * The reply and quote press guard of the interim gate check (7.4.2, Ctl 7 and
 * Ctl 8). Feed rows, thread replies and lists render before any gate is read,
 * so a press on a private post evaluates its gates first and shows a toast
 * instead of opening the composer when the reader is not allowed. Where prism
 * applies the gates (`private.gates` and a private thread root, 2H design
 * 5.4) a reply press asks prism's own answer instead. Every failure goes
 * ahead (fail-open, O-27): the servers are the authority once they apply the
 * gates (P-18, A-10).
 */

import {t} from '@lingui/core/macro'

import {logger} from '#/logger'
import {STALE} from '#/state/queries'
import * as Toast from '#/components/Toast'
import {
  GATE_DEADLINE_MS,
  gatesServedForRoot,
  privateGateEvaluation,
  privateGatesQueryKey,
  rootUriOf,
  withGateDeadline,
} from '#/horizon/private/api/gates'
import {getPrivatePosts} from '#/horizon/private/api/reads'
import {isPrivateDisplay} from '#/horizon/private/render/controls'
import {getCurrentClients} from '#/horizon/routing/current-clients'

/**
 * The fields of a post view the guard reads.
 */
export type GuardedPost = {
  uri: string
  record: unknown
  viewer?: {replyDisabled?: boolean; embeddingDisabled?: boolean}
}

/**
 * Run `action` (open the reply or quote composer) unless the post's gates
 * disallow it for the reader. Returns nothing: the check runs in its own
 * promise and handles every failure, so the hook lines stay plain calls.
 *
 * `action` runs at once for a post that is not private, when the stock
 * viewer state already decides (the stock controls handle it), without a
 * query client, and for a quote where prism applies the gates (the adapter
 * then set `embeddingDisabled`; a view adapted before the feature was listed
 * reaches here, and prism has not disabled it). Otherwise after prism's
 * answer (a reply where prism applies the gates) or the interim evaluation,
 * on the deadline, or on a failure.
 */
export function guardPrivateInteraction(
  post: GuardedPost,
  kind: 'reply' | 'quote',
  action: () => void,
): void {
  const decided =
    kind === 'reply'
      ? post.viewer?.replyDisabled !== undefined
      : post.viewer?.embeddingDisabled !== undefined
  const clients = getCurrentClients()
  const queryClient = clients?.queryClient
  if (!isPrivateDisplay(post.uri) || decided || !clients || !queryClient) {
    action()
    return
  }
  const rootUri = rootUriOf(post.uri, post.record)
  const served = gatesServedForRoot(rootUri)
  if (served && kind === 'quote') {
    action()
    return
  }
  const run = async () => {
    let allowed = true
    try {
      if (served) {
        /*
         * prism sets `replyDisabled` only for a root read in the same
         * request, so the root is asked beside the post.
         */
        const views = await withGateDeadline(
          queryClient.fetchQuery({
            queryKey: [...privateGatesQueryKey(rootUri, post.uri), 'served'],
            staleTime: STALE.MINUTES.FIVE,
            queryFn: () =>
              getPrivatePosts(clients.prismClient, [rootUri, post.uri]),
          }),
          GATE_DEADLINE_MS,
        )
        const view = views.find(v => v.uri === post.uri) as
          {viewer?: {replyDisabled?: unknown}} | undefined
        allowed = view?.viewer?.replyDisabled !== true
      } else {
        const evaluation = await withGateDeadline(
          privateGateEvaluation(queryClient, rootUri, post.uri),
          GATE_DEADLINE_MS,
        )
        allowed =
          kind === 'reply'
            ? !evaluation.replyDisabled
            : !evaluation.embeddingDisabled
      }
    } catch (error) {
      logger.warn('private gates: check skipped', {safeMessage: error})
    }
    if (allowed) {
      action()
    } else {
      Toast.show(
        kind === 'reply'
          ? t`Replies to this post are limited.`
          : t`Quote posts of this post are turned off.`,
        {type: 'warning'},
      )
    }
  }
  void run()
}
