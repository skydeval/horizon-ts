/*
 * What the composer's drop-down reads and writes as (Phase 5 design 8.2,
 * PA-13, PA-14, B-28): the posting account's DID and clients when it is not
 * the current account, so its reply lists, audiences, new lists and saved
 * defaults are that account's, never the current account's. With the
 * current account posting, every caller keeps its stock behaviour.
 */

import {type Client} from '@atproto/lex'
import {useQuery} from '@tanstack/react-query'

import {accumulate} from '#/lib/async/accumulate'
import {STALE} from '#/state/queries'
import {useMyListsQuery} from '#/state/queries/my-lists'
import {app} from '#/lexicons'
import {isPostingAsOther, usePostingState} from './compose-store'
import {peekTemporaryClient} from './temp-client'

/** Another account the compose posts from, with its clients. */
export type PostingAccount = {
  did: string
  handle: string | undefined
  pdsClient: Client
  appviewClient: Client
}

/**
 * The posting account when it is not the current account and its
 * temporary client is held, else `undefined` (the current account).
 */
export function usePostingAccount(): PostingAccount | undefined {
  const s = usePostingState()
  if (!isPostingAsOther(s) || !s.did) return undefined
  const clients = peekTemporaryClient(s.did)
  if (!clients) return undefined
  return {
    did: s.did,
    handle: s.handle,
    pdsClient: clients.pdsClient,
    appviewClient: clients.appviewClient,
  }
}

/**
 * The curate lists the reply settings offer: the posting account's (read
 * with its own clients) when another account posts, else the stock
 * `useMyListsQuery('curate')`.
 */
export function usePostingCurateLists() {
  const stock = useMyListsQuery('curate')
  const other = usePostingAccount()
  const otherDid = other?.did
  const otherClient = other?.appviewClient
  const query = useQuery<app.bsky.graph.defs.ListView[]>({
    staleTime: STALE.MINUTES.ONE,
    queryKey: ['horizon-posting-lists', otherDid],
    async queryFn() {
      if (!otherDid || !otherClient) return []
      const lists = await accumulate(cursor =>
        otherClient
          .call(app.bsky.graph.getLists, {
            actor: otherDid as app.bsky.graph.getLists.$Params['actor'],
            cursor,
            limit: 50,
          })
          .then(data => ({cursor: data.cursor, items: data.lists})),
      )
      return lists.filter(
        list => list.purpose === 'app.bsky.graph.defs#curatelist',
      )
    },
    enabled: !!otherDid && !!otherClient,
  })
  return other ? query : stock
}
