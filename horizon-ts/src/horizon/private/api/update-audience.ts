/*
 * Changing who can see a private post (7.8.1): an edit of the post record's
 * `audienceList` through `updatePostPrivate` (aurora A-9), never a delete and
 * re-create, so the URI, replies and interactions stay.
 *
 * aurora accepts the change on a top-level private post and on a branch root
 * (a private post whose `reply.parent` is not private, A-13); every other
 * reply's audience is its anchor's. The change applies downthread: replies
 * written later name the anchor's current audience (`reply-anchor.ts`), and
 * prism reads existing ones by it (P-21, P-22).
 *
 * The change goes through the posting writer (2K design 4.5): on posting
 * route `locus` it is `updatePostPrivate`, as before; on `encode` it is
 * offered from 2K-8 (`ENCODE_AUDIENCE_CHANGE`); on `checking` and `none` it is
 * neither offered nor written.
 */

import {type Client, XrpcResponseError} from '@atproto/lex'
import {AtUri} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'

import {
  assertOwnAudienceExists,
  type AudienceClients,
  findOrCreateStandingAudience,
  PrivateAudienceMissingError,
  PrivateAudienceUnpickedError,
} from '#/horizon/private/api/audiences'
import {
  type PlacementFields,
  readOwnPrivateRecord,
} from '#/horizon/private/api/reply-anchor'
import {requestRecordCaughtUp} from '#/horizon/private/api/request-record'
import {
  type PostingWriter,
  postingWriterFor,
  PrivateAudienceChangeUnavailableError,
} from '#/horizon/private/api/writer'
import {type ComposeAudience} from '#/horizon/private/composer/state'
import {ENCODE_AUDIENCE_CHANGE} from '#/horizon/private/server-support'
import {applyPrivatePostAudience} from '#/horizon/private/store'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {
  clientDid,
  getWriteRoute,
  type PrivateWriteRoute,
  type RepoRoute,
} from '#/horizon/routing/write-route'

/**
 * Whether "Who can see" is offered on posting route `route` (8.1): on
 * `locus` as before, on `encode` only with `ENCODE_AUDIENCE_CHANGE`, never on
 * `checking` or `none`.
 */
export function audienceChangeOffered(route: PrivateWriteRoute): boolean {
  if (route === 'locus') return true
  if (route === 'encode') return ENCODE_AUDIENCE_CHANGE
  return false
}

/**
 * A swap conflict: the error name `InvalidSwap` at any status on the stock
 * repo route (a stock PDS answers 400), 409 on locus.
 */
function isSwapConflict(error: unknown, repoRoute: RepoRoute): boolean {
  if (!(error instanceof XrpcResponseError)) return false
  return repoRoute === 'stock'
    ? error.error === 'InvalidSwap'
    : error.status === 409
}

/**
 * The post's record changed since its settings were opened (a swap
 * conflict); nothing was written.
 */
export class PrivatePostChangedError extends Error {
  constructor() {
    super(
      t`This post changed since you opened its settings. Close and try again.`,
    )
    this.name = 'PrivatePostChangedError'
  }
}

/**
 * Whether a private post's audience can be changed: a top-level post, or a
 * branch root (its parent is not a private post).
 */
export function canChangePostAudience(fields: {
  isReply: boolean
  parentUri: string | undefined
}): boolean {
  if (!fields.isReply) return true
  return !!fields.parentUri && !isPrivatePostUri(fields.parentUri)
}

/**
 * The author's own private post as stored on their PDS: its current record
 * CID (the swap for a change) and the fields that decide whether its audience
 * can change. `undefined` when the read fails; the caller falls back to the
 * view.
 */
export async function readOwnPostForSettings(
  pdsClient: Client,
  postUri: string,
): Promise<{cid: string; fields: PlacementFields} | undefined> {
  const {host, rkey} = new AtUri(postUri)
  const own = await readOwnPrivateRecord(pdsClient, host, rkey)
  return own === 'absent' ? undefined : own
}

/**
 * The audience URI a choice names, resolved as the composer resolves it
 * (4.7): a standing mode found or created, or a list checked against the
 * account's audiences.
 */
async function resolveAudience(
  queryClient: QueryClient,
  clients: AudienceClients,
  audience: ComposeAudience,
  writer: PostingWriter,
): Promise<string> {
  if (audience.kind === 'mode') {
    return findOrCreateStandingAudience(
      queryClient,
      clients,
      audience.mode,
      writer,
    )
  }
  if (audience.kind === 'list') {
    await assertOwnAudienceExists(queryClient, clients, audience.uri)
    return audience.uri
  }
  if (audience.kind === 'unpicked') throw new PrivateAudienceUnpickedError()
  throw new PrivateAudienceMissingError()
}

/**
 * Change who can see the current account's private post `postUri` to
 * `audience`, swapping on `swapCid` (the record CID the settings were opened
 * with). Asks prism to reindex the post (waiting up to three seconds for
 * whether it caught up, 2H design 5.7) and updates its facts, pinning the
 * new audience, and pending entry, so every label changes at once and does
 * not flip back. Returns the new audience, record CID and `caughtUp`. Throws
 * {@link PrivatePostChangedError} on a swap mismatch, and on the stock repo
 * route without a swap CID (PA-24: a `putRecord` without one could re-create
 * a deleted post); `PrivateRouteUnavailableError` before any read or write
 * on posting route `checking` or `none`, and
 * `PrivateAudienceChangeUnavailableError` on `encode` while
 * `ENCODE_AUDIENCE_CHANGE` is off; any other failure as it comes.
 */
export async function changePrivatePostAudience({
  queryClient,
  clients,
  postUri,
  swapCid,
  audience,
}: {
  queryClient: QueryClient
  clients: AudienceClients
  postUri: string
  swapCid: string | undefined
  audience: ComposeAudience
}): Promise<{audienceUri: string; cid: string; caughtUp: boolean}> {
  // The writer, once (PA-20).
  const routes = getWriteRoute(clientDid(clients.pdsClient) ?? clients.did)
  const writer = postingWriterFor(
    routes.postingRoute,
    clients.pdsClient,
    clients.did,
  )
  /*
   * Posting route `encode` before 2K-8: refused here, before a standing
   * audience could be created for it.
   */
  if (!audienceChangeOffered(routes.postingRoute)) {
    throw new PrivateAudienceChangeUnavailableError()
  }
  if (routes.repoRoute === 'stock' && !swapCid) {
    throw new PrivatePostChangedError()
  }
  const audienceUri = await resolveAudience(
    queryClient,
    clients,
    audience,
    writer,
  )
  let res: {cid: string}
  try {
    res = await writer.changeAudience(postUri, swapCid, audienceUri)
  } catch (error) {
    if (isSwapConflict(error, routes.repoRoute)) {
      throw new PrivatePostChangedError()
    }
    throw error
  }
  applyPrivatePostAudience(postUri, audienceUri, res.cid)
  const caughtUp = await requestRecordCaughtUp(clients.prismClient, postUri)
  return {audienceUri, cid: res.cid, caughtUp}
}
