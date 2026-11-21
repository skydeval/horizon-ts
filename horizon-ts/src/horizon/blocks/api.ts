/*
 * prism's block check, `app.nearhorizon.blocks.check`: the reader's block
 * state with up to 100 accounts, both ways, direct and through lists, from
 * prism's own index. Called straight at prism with a service token from the
 * reader's own PDS. Nothing an answer carries is logged here.
 */

import {type Client} from '@atproto/lex'
import {type AtUriString, type NsidString} from '@atproto/syntax'

import {networkAwareFetch} from '#/state/session/network'
import {PRISM_URL} from '#/horizon/routing/prism'
import {getDirectPrismToken} from '#/horizon/routing/prism-direct'
import {app} from '#/lexicons'
import {type BlockState} from './state'

export const BLOCKS_CHECK_LXM = 'app.nearhorizon.blocks.check' as NsidString

type Fetch = typeof fetch

/**
 * Whether the AppView still shows the list at `uri`. A list Bluesky's
 * moderation took down stays in its owner's repo, where prism reads it, but
 * the AppView answers "List not found" and no longer enforces it; nor does
 * Horizon. An answer that isn't a clear yes is treated as no: a block that
 * can't be confirmed never counts.
 */
export async function fetchListShown(
  appviewClient: Client,
  uri: string,
): Promise<boolean> {
  try {
    await appviewClient.call(app.bsky.graph.getList, {
      list: uri as AtUriString,
      limit: 1,
    })
    return true
  } catch {
    return false
  }
}

/** Ask prism for the reader's block state with `others` (at most 100). */
export async function fetchBlockStates(
  pdsClient: Client,
  others: string[],
  {fetchImpl = networkAwareFetch}: {fetchImpl?: Fetch} = {},
): Promise<BlockState[]> {
  if (others.length === 0) return []
  const url = new URL(`/xrpc/${BLOCKS_CHECK_LXM}`, PRISM_URL)
  const send = async (fresh: boolean) => {
    const token = await getDirectPrismToken(pdsClient, BLOCKS_CHECK_LXM, {
      fresh,
    })
    return fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({others}),
    })
  }
  let response = await send(false)
  if (response.status === 401) response = await send(true)
  if (!response.ok) throw new Error(`Block check failed: ${response.status}`)
  const body = (await response.json()) as {results?: unknown}
  if (!Array.isArray(body.results)) return []
  return body.results.filter(
    (entry): entry is BlockState =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as {did?: unknown}).did === 'string',
  )
}
