/*
 * The anchor of a reply to a private post, for the composer's locked label:
 * the thread root, or the branch root when the thread's root is public
 * (`api/reply-anchor.ts`). Publishing places the reply again, fresh; this
 * read only labels the audience the reply will name.
 */

import {useQuery} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {
  placePrivateReply,
  PrivateParentBusyError,
} from '#/horizon/private/api/reply-anchor'
import {
  keepOverData,
  PRIVATE_RETRY,
  PrivateSuspectMissError,
} from '#/horizon/private/api/transient'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'

/**
 * The reply's anchor and the audience it names now, or `undefined` while it
 * loads, when it cannot be found, or for a reply to a public post.
 */
export function useReplyAnchor(
  replyToUri: string | undefined,
): {uri: string; audienceUri: string} | undefined {
  const enabled = !!replyToUri && isPrivatePostUri(replyToUri)
  const {data} = useQuery({
    queryKey: ['horizon-private-reply-anchor', replyToUri],
    enabled,
    staleTime: STALE.SECONDS.THIRTY,
    // Retried while prism is busy, never over a kept label (busy design 5).
    ...PRIVATE_RETRY,
    queryFn: context =>
      keepOverData(context, async () => {
        const clients = getCurrentClients()
        if (!clients || !replyToUri) return null
        try {
          const place = await placePrivateReply(
            {
              did: clients.did,
              pdsClient: clients.pdsClient,
              prismClient: clients.prismClient,
            },
            replyToUri,
          )
          return {uri: place.anchor.uri, audienceUri: place.anchor.audienceUri}
        } catch (error) {
          /*
           * A post prism left out says nothing yet (busy design 6): the label
           * keeps what it showed, and with nothing it is read again through
           * the throttle, as a suspect miss is. The reply itself is placed
           * again at publish time.
           */
          if (error instanceof PrivateParentBusyError) {
            throw new PrivateSuspectMissError()
          }
          throw error
        }
      }),
  })
  return enabled ? (data ?? undefined) : undefined
}
