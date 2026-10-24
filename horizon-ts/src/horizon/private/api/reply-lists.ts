/*
 * Reply lists from the composer's drop-down (5.5): a Bluesky curate list
 * (`app.bsky.graph.list`, purpose `curatelist`) with its members, created in
 * one step so it can be checked as a reply rule at once. Reply rules name
 * curate lists in both visibilities.
 */

import {type Client} from '@atproto/lex'
import {type DidString, toDatetimeString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'
import {countGraphemes} from 'unicode-segmenter/grapheme'

import {
  AudienceNameInvalidError,
  normalizeMembers,
} from '#/horizon/private/api/audiences'
import {nextTid} from '#/horizon/tid-clock'
import {com} from '#/lexicons'

/** The stock list lexicon's name limit. */
const MAX_NAME_GRAPHEMES = 64
const MAX_NAME_LENGTH = 640

/** Writes per `applyWrites` call. */
export const REPLY_LIST_BATCH = 200

const LIST_COLLECTION = 'app.bsky.graph.list'
const LISTITEM_COLLECTION = 'app.bsky.graph.listitem'

/*
 * The stock `my-lists` query's key root, as `#/state/queries/my-lists`
 * builds it. Spelled out because importing that module pulls the session
 * into this non-React module.
 */
const MY_LISTS_RQKEY_ROOT = 'my-lists'

/**
 * The list was created, but a later batch of its members failed. The list is
 * usable and can be edited on its own page.
 */
export class ReplyListPartlyCreatedError extends Error {
  constructor(readonly uri: string) {
    super(t`The list was created, but some people could not be added.`)
    this.name = 'ReplyListPartlyCreatedError'
  }
}

type Create = {
  $type: 'com.atproto.repo.applyWrites#create'
  collection: string
  rkey: string
  value: Record<string, unknown>
}

/**
 * Create a curate list named `name` with `members` (de-duplicated, without
 * the author). The list and its first members go in one `applyWrites`, so the
 * list never exists without them; more than 199 members take further calls
 * of 200 writes. Returns the list's URI. Throws
 * {@link AudienceNameInvalidError} for a bad name, and
 * {@link ReplyListPartlyCreatedError} when a later batch fails.
 */
export async function createReplyList(
  queryClient: QueryClient,
  {pdsClient, did}: {pdsClient: Client; did: string},
  {name, members}: {name: string; members: readonly string[]},
): Promise<string> {
  const trimmed = name.trim()
  if (
    trimmed.length === 0 ||
    countGraphemes(trimmed) > MAX_NAME_GRAPHEMES ||
    trimmed.length > MAX_NAME_LENGTH
  ) {
    throw new AudienceNameInvalidError()
  }
  const now = toDatetimeString(new Date())
  let tid = nextTid(did)
  const listRkey = tid.toString()
  const uri = `at://${did}/${LIST_COLLECTION}/${listRkey}`
  const writes: Create[] = [
    {
      $type: 'com.atproto.repo.applyWrites#create',
      collection: LIST_COLLECTION,
      rkey: listRkey,
      value: {
        $type: LIST_COLLECTION,
        purpose: 'app.bsky.graph.defs#curatelist',
        name: trimmed,
        createdAt: now,
      },
    },
  ]
  for (const member of normalizeMembers(members, did)) {
    tid = nextTid(did, tid)
    writes.push({
      $type: 'com.atproto.repo.applyWrites#create',
      collection: LISTITEM_COLLECTION,
      rkey: tid.toString(),
      value: {
        $type: LISTITEM_COLLECTION,
        subject: member,
        list: uri,
        createdAt: now,
      },
    })
  }

  for (let i = 0; i < writes.length; i += REPLY_LIST_BATCH) {
    const batch = writes.slice(i, i + REPLY_LIST_BATCH)
    try {
      await pdsClient.call(com.atproto.repo.applyWrites, {
        repo: did as DidString,
        writes: batch as com.atproto.repo.applyWrites.$InputBody['writes'],
      })
    } catch (error) {
      if (i === 0) throw error
      void queryClient.invalidateQueries({queryKey: [MY_LISTS_RQKEY_ROOT]})
      throw new ReplyListPartlyCreatedError(uri)
    }
  }
  void queryClient.invalidateQueries({queryKey: [MY_LISTS_RQKEY_ROOT]})
  return uri
}
