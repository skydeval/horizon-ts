/*
 * The private writers (2K design 4.0, PA-9): one per route, chosen once at a
 * write's entry (PA-20).
 *
 * - A **repo writer**, by the repo route, never blocked: post deletes (the
 *   delete guard and a compose rollback) and audience edits and deletes. The
 *   locus one is today's `deletePostPrivate`; the stock one writes with
 *   `com.atproto.repo.deleteRecord` and `putRecord`.
 * - A **posting writer**, by the posting route: a compose's posts, a change
 *   of audience and an audience create. The locus one wraps today's
 *   procedures unchanged (D-0.10). The encode one (the client encoder, then
 *   stock writes) comes in 2K-3; until then `checking`, `none` and `encode`
 *   all refuse before any write.
 *
 * Every raw write of `tools.kryphocron.*` on repo route `stock` checks for
 * locus's refusal (PA-5): on a match the PDS is recorded as a kryphocron host
 * for the run and {@link PrivateKryphocronHostError} is thrown; a post delete
 * is retried through the locus writer by its caller.
 */

import {type Client, type LexMap} from '@atproto/lex'
import {AtUri, type AtUriString, type DidString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'

import {kryphocron} from '#/horizon/lexicons'
import {type PostPrivate} from '#/horizon/lexicons/kryphocron'
import {AUDIENCE_COLLECTION, PP_COLLECTION} from '#/horizon/private/uri'
import {
  clientDid,
  getWriteRoute,
  isKryphocronRefusal,
  markKryphocronHost,
  type PrivateWriteRoute,
  type RepoRoute,
} from '#/horizon/routing/write-route'
import {com} from '#/lexicons'

/**
 * The account's posting route is `checking` or `none` (or `encode` before
 * 2K-3): nothing was written.
 */
export class PrivateRouteUnavailableError extends Error {
  constructor() {
    super(
      t`Private posting isn’t available for your account right now. Nothing was posted.`,
    )
    this.name = 'PrivateRouteUnavailableError'
  }
}

/**
 * The PDS refused a raw kryphocron write with locus's answer (PA-5): it has
 * its own procedures, and the routes now say so.
 */
export class PrivateKryphocronHostError extends Error {
  constructor() {
    super(t`Your server has its own way to post privately. Try again.`)
    this.name = 'PrivateKryphocronHostError'
  }
}

/**
 * Audience edit and delete through locus's procedures wait on A-4
 * (`AUDIENCE_EDIT`); nothing offers them until then.
 */
export class AudienceEditUnavailableError extends Error {
  constructor() {
    super('Audience edit and delete are not available on this server')
    this.name = 'AudienceEditUnavailableError'
  }
}

/**
 * The procedure a private post is written with on the locus route: its own
 * thread or branch, or a participation in another account's.
 */
export type PostProcedure =
  typeof kryphocron.createPostPrivate | typeof kryphocron.participatePrivate

/**
 * Writes that never wait on the posting route.
 */
export type RepoWriter = {
  route: RepoRoute
  /** Delete a private post. `swapCid` is for Delete them (8.2). */
  deletePost(uri: string, swapCid?: string): Promise<void>
  /** Replace an audience record, always with a swap (PA-24). */
  updateAudienceRecord(
    uri: string,
    record: LexMap,
    swapCid: string,
  ): Promise<{cid: string}>
  deleteAudience(uri: string): Promise<void>
}

/**
 * New private writes.
 */
export type PostingWriter = {
  route: PrivateWriteRoute
  /**
   * Write one post of a compose at `rkey`. The caller reads its stored CID
   * back and handles failures (2K-3 widens this to the whole compose for the
   * encode route).
   */
  createPost(post: {
    procedure: PostProcedure
    rkey: string
    record: PostPrivate
  }): Promise<void>
  /** Point a post at another audience; answers the new record CID. */
  changeAudience(
    uri: string,
    swapCid: string | undefined,
    audienceUri: string,
  ): Promise<{cid: string}>
  createAudience(record: LexMap): Promise<{uri: string}>
}

/**
 * A raw write on repo route `stock`, with PA-5's check.
 */
async function rawWrite<T>(did: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (!isKryphocronRefusal(error)) throw error
    markKryphocronHost(did)
    throw new PrivateKryphocronHostError()
  }
}

/**
 * Today's locus procedures. The audience edit and delete throw before any
 * write while `AUDIENCE_EDIT` is off (A-4).
 */
export function locusRepoWriter(pdsClient: Client): RepoWriter {
  return {
    route: 'locus',
    async deletePost(uri) {
      const {host, rkey} = new AtUri(uri)
      await pdsClient.call(kryphocron.deletePostPrivate, {
        repo: host as DidString,
        rkey,
      })
    },
    updateAudienceRecord() {
      return Promise.reject(new AudienceEditUnavailableError())
    },
    deleteAudience() {
      return Promise.reject(new AudienceEditUnavailableError())
    },
  }
}

/**
 * Stock repo writes on the account's own PDS (4.4, 4.7).
 */
export function stockRepoWriter(pdsClient: Client): RepoWriter {
  return {
    route: 'stock',
    async deletePost(uri, swapCid) {
      const {host, rkey} = new AtUri(uri)
      await rawWrite(host, () =>
        pdsClient.call(com.atproto.repo.deleteRecord, {
          repo: host,
          collection: PP_COLLECTION,
          rkey,
          ...(swapCid ? {swapRecord: swapCid} : {}),
        }),
      )
    },
    async updateAudienceRecord(uri, record, swapCid) {
      const {host, rkey} = new AtUri(uri)
      const res = await rawWrite(host, () =>
        pdsClient.call(com.atproto.repo.putRecord, {
          repo: host,
          collection: AUDIENCE_COLLECTION,
          rkey,
          record,
          swapRecord: swapCid,
        }),
      )
      return {cid: res.cid}
    },
    async deleteAudience(uri) {
      const {host, rkey} = new AtUri(uri)
      await rawWrite(host, () =>
        pdsClient.call(com.atproto.repo.deleteRecord, {
          repo: host,
          collection: AUDIENCE_COLLECTION,
          rkey,
        }),
      )
    },
  }
}

/**
 * Today's locus procedures, unchanged (D-0.10).
 */
export function locusPostingWriter(
  pdsClient: Client,
  did: string,
): PostingWriter {
  return {
    route: 'locus',
    async createPost({procedure, rkey, record}) {
      await pdsClient.call(procedure, {repo: did as DidString, rkey, record})
    },
    async changeAudience(uri, swapCid, audienceUri) {
      const res = await pdsClient.call(kryphocron.updatePostPrivate, {
        repo: did as DidString,
        rkey: new AtUri(uri).rkey,
        audienceList: audienceUri as AtUriString,
        ...(swapCid ? {swapRecord: swapCid} : {}),
      })
      return {cid: res.cid}
    },
    async createAudience(record) {
      const res = await pdsClient.call(kryphocron.manageAudience, {
        repo: did as DidString,
        record,
      })
      return {uri: res.uri}
    },
  }
}

/**
 * The repo writer of `route`. Always a writer: a delete never depends on
 * prism, membership or the encoder.
 */
export function repoWriterFor(route: RepoRoute, pdsClient: Client): RepoWriter {
  return route === 'locus'
    ? locusRepoWriter(pdsClient)
    : stockRepoWriter(pdsClient)
}

/**
 * The posting writer of `route`; throws {@link PrivateRouteUnavailableError}
 * before any write on `checking` and `none`, and on `encode` until its writer
 * lands (2K-3).
 */
export function postingWriterFor(
  route: PrivateWriteRoute,
  pdsClient: Client,
  did: string,
): PostingWriter {
  if (route === 'locus') return locusPostingWriter(pdsClient, did)
  throw new PrivateRouteUnavailableError()
}

/**
 * The repo writer for a write made with `pdsClient`, from its account's
 * route now.
 */
export function repoWriterForClient(pdsClient: Client): RepoWriter {
  return repoWriterFor(getWriteRoute(clientDid(pdsClient)).repoRoute, pdsClient)
}

/**
 * The posting writer for a write made with `pdsClient` as `did`, from its
 * account's route now; throws as {@link postingWriterFor} does.
 */
export function postingWriterForClient(
  pdsClient: Client,
  did: string,
): PostingWriter {
  return postingWriterFor(
    getWriteRoute(clientDid(pdsClient) ?? did).postingRoute,
    pdsClient,
    did,
  )
}
