/*
 * The private write path: publishing a private compose (one post or a
 * thread) with its reply and quote limits, deleting a private post, and
 * what follows each write.
 *
 * A private compose never falls through to a public post. Each call takes
 * its writers once, at entry, by the account's routes (2K design PA-9,
 * PA-20): a compose goes through the posting writer, which refuses before
 * any work while the posting route is `checking` or `none`; deletes and the
 * rollback go through the repo writer, which every route has.
 *
 * On the locus route each post's record is validated locally before it is
 * sent, written through the kryphocron procedure with a client-chosen rkey,
 * and its stored CID read back with `getRecord` (written before aurora
 * answered the record's CID, A-1; the read is kept, as it confirms the
 * record is stored). A reply's audience and procedure come from its anchor
 * (`reply-anchor.ts`). A thread is written one post at a time, because each
 * reply needs the previous post's CID; a failure removes whatever was
 * written, so a failed private compose leaves nothing posted. The composer
 * waits for it (D-0.10).
 *
 * On posting route `encode` (2K design 4.2, 4.11) the compose goes to the
 * outbox (`private/outbox.ts`, PA-28): it is captured at press, with no
 * network call, and posted in the background; a failure deletes nothing and
 * stays on the device in Unsent. The steps both routes share are in
 * `compose.ts`.
 *
 * Logs name URIs, key names and failure classes only, never private text or
 * an encoder's or server's message.
 */

import {type TID} from '@atproto/common-web'
import {type Client, XrpcResponseError} from '@atproto/lex'
import {AtUri} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'

import {type PostOpts} from '#/lib/api/index'
import {isNetworkError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {type PostPrivate} from '#/horizon/lexicons/kryphocron'
import {getComposeSpoilers} from '#/horizon/media-spoilers/compose-store'
import {toPostView} from '#/horizon/private/adapt/post-view'
import {
  type AudienceClients,
  PrivateAudienceUnpickedError,
} from '#/horizon/private/api/audiences'
import {
  asThreadParent,
  authorView,
  buildComposedPosts,
  confirmInBackground,
  confirmNow,
  invalidateAuthorPrivateFeeds,
  pendingEmbedView,
  planFirstPost,
  PrivateGatesNotSavedError,
  quoteViewFromCache,
  readRecordState,
  resolveComposePosts,
} from '#/horizon/private/api/compose'
import {
  deleteGates,
  gatesForNewPost,
  type GateWrite,
  PrivateGateWriteError,
  writeGatesForNewPost,
} from '#/horizon/private/api/gates'
import {
  PrivateParentBusyError,
  PrivateParentUnavailableError,
  PrivateReplyRefusedError,
} from '#/horizon/private/api/reply-anchor'
import {
  PrivateReplyBlockedError,
  PrivateReplyCheckError,
  recheckReplyBlock,
  REPLY_BLOCK_TIMING,
  type ReplyBlockCheck,
} from '#/horizon/private/api/reply-block'
import {
  requestRecordCaughtUp,
  requestRecordQuietly,
} from '#/horizon/private/api/request-record'
import {validatePrivateRecord} from '#/horizon/private/api/validate'
import {
  locusRepoWriter,
  postingWriterFor,
  PrivateKryphocronHostError,
  PrivateRouteUnavailableError,
  type RepoWriter,
  repoWriterFor,
} from '#/horizon/private/api/writer'
import {getComposeVisibility} from '#/horizon/private/composer/state'
import {pressEncodeCompose} from '#/horizon/private/outbox'
import {PRIVATE_LANGS_LABELS} from '#/horizon/private/server-support'
import {
  addPendingPost,
  forgetPrivatePost,
  PENDING_TTL_MS,
  setPendingBatch,
} from '#/horizon/private/store'
import {PP_COLLECTION} from '#/horizon/private/uri'
import {getPrismClient} from '#/horizon/routing/prism'
import {clientDid, getWriteRoute} from '#/horizon/routing/write-route'
import {spoilerWriteMode} from '#/horizon/spoilers/write'
import {nextTid} from '#/horizon/tid-clock'
import {type app} from '#/lexicons'

export {requestRecordQuietly}
export {
  PrivateParentBusyError,
  PrivateParentUnavailableError,
  PrivateReplyRefusedError,
}
export {
  CONFIRM_AT_MS,
  PrivateEncodeError,
  PrivateGatesNotSavedError,
  stopPrivateConfirmations,
} from '#/horizon/private/api/compose'
export {invalidateAuthorPrivateFeeds}

/**
 * A private thread failed part-way and some of it could not be removed.
 */
export class PrivateThreadPartlyPostedError extends Error {
  constructor(readonly remaining: string[]) {
    super(
      t`Some of your private thread may have been posted and could not be removed. Check your profile’s Private tab.`,
    )
    this.name = 'PrivateThreadPartlyPostedError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether aurora refused a reply's placement:
 *
 * - `participatePrivate` answers every refusal with one 403;
 * - `createPostPrivate` answers a reply outside the writer's own thread or
 *   branch, or under an audience other than its anchor's current one, with
 *   one fixed 400 `InvalidRequest` naming `participatePrivate` (A-12, A-13).
 *   Its other 400s (a missing audience, a malformed `reply`) keep their own
 *   messages and are not refusals of the placement.
 */
export function isReplyRefusal(error: unknown, isReply: boolean): boolean {
  if (!isReply || !(error instanceof XrpcResponseError)) return false
  if (error.status === 403) return true
  if (error.status !== 400 || error.error !== 'InvalidRequest') return false
  const body = error.body
  const message =
    isObject(body) && typeof body.message === 'string'
      ? body.message
      : error.message
  return message.includes('participatePrivate')
}

/**
 * Delete what a failed private compose wrote, newest first, through the repo
 * writer the compose took at its entry (PA-20), never one read again here.
 * Returns the URIs that may remain.
 */
async function rollBack(
  writer: RepoWriter,
  pdsClient: Client,
  written: string[],
): Promise<string[]> {
  const remaining: string[] = []
  for (const uri of [...written].reverse()) {
    try {
      await deleteThrough(writer, pdsClient, uri)
    } catch {
      remaining.push(uri)
    }
  }
  return remaining
}

/**
 * Write the compose's reply and quote limits before its posts (4.5 step 0,
 * after the media uploads: D2-151). `writes` is the compose's
 * `gatesForNewPost`, taken once by the caller, which needs to know whether
 * any gate is written.
 * A failure has written no post; the gates already created are deleted, and
 * any that cannot be are logged by URI.
 */
async function writeComposeGates(
  opts: PostOpts,
  did: string,
  writes: GateWrite[],
): Promise<string[]> {
  if (writes.length === 0) return []
  opts.onStateChange?.(t`Saving reply and quote settings...`)
  try {
    return await writeGatesForNewPost(opts.pdsClient, did, writes)
  } catch (error) {
    if (!(error instanceof PrivateGateWriteError)) throw error
    if (error.remaining.length > 0) {
      logger.error('private compose: gate records could not be removed', {
        uris: error.remaining,
      })
    }
    if (isNetworkError(error.failure)) {
      throw new Error(
        t`Post failed to upload. Please check your Internet connection and try again.`,
      )
    }
    throw new PrivateGatesNotSavedError()
  }
}

/**
 * Publish a private compose. Takes the stock `PostOpts` and returns the
 * stock `{uris}`; every client comes from `opts`.
 *
 * On posting route `encode` the compose is handed to the outbox at once
 * (2K design PA-28): what it needs is captured before this function's first
 * await, nothing touches the network, and `{uris}` is returned with the
 * posts pending in phase `sending`.
 */
export async function postPrivate(
  queryClient: QueryClient,
  opts: PostOpts,
): Promise<{uris: string[]}> {
  // No audience chosen: refused before any capture, Unsent entry or send (P5R7-L1).
  if (getComposeVisibility().audience.kind === 'unpicked') {
    throw new PrivateAudienceUnpickedError()
  }
  const did = opts.pdsClient.assertDid
  /*
   * Both writers, once (PA-20): a route that changes during the compose does
   * not move it, and its rollback deletes through the same repo writer. On
   * posting route `checking` or `none` this throws before anything is
   * resolved, uploaded or written.
   */
  const routes = getWriteRoute(did)
  if (routes.postingRoute === 'encode') {
    return pressEncodeCompose(queryClient, opts, routes)
  }
  if (routes.postingRoute !== 'locus') throw new PrivateRouteUnavailableError()
  return postThroughLocus(queryClient, opts, routes)
}

/**
 * The locus route (D-0.10): the composer waits for the procedures, and a
 * failure rolls back what was written.
 */
async function postThroughLocus(
  queryClient: QueryClient,
  opts: PostOpts,
  routes: ReturnType<typeof getWriteRoute>,
): Promise<{uris: string[]}> {
  const thread = opts.thread
  /*
   * The media spoiler flags and content warnings, captured before the first
   * await (2J design, 4.6).
   */
  const composeSpoilers = getComposeSpoilers()
  const spoilerMode = spoilerWriteMode(true)
  const did = opts.pdsClient.assertDid
  const postingWriter = postingWriterFor(
    routes.postingRoute,
    opts.pdsClient,
    did,
  )
  const repoWriter = repoWriterFor(routes.repoRoute, opts.pdsClient)
  // The composer's audience, read before the first await.
  const {audience} = getComposeVisibility()
  opts.onStateChange?.(t`Processing...`)

  const prism = getPrismClient(opts.pdsClient)
  const clients: AudienceClients = {
    did,
    pdsClient: opts.pdsClient,
    prismClient: prism,
  }

  const plan = await planFirstPost(
    queryClient,
    clients,
    opts,
    audience,
    postingWriter,
  )

  /*
   * Every post's text and embed, resolved before any gate or post is
   * written: every blob of the compose (images, gallery items, video
   * captions, GIF and link-card thumbnails) is uploaded here, so a failed
   * upload has written nothing and rolls nothing back.
   */
  const resolved = await resolveComposePosts(
    queryClient,
    opts,
    thread.posts,
    composeSpoilers,
    spoilerMode,
    opts.onStateChange,
  )

  /*
   * The reply block check again when uploads made the plan's verdict stale
   * (PR2-L1): a refusal leaves the composer open with its text, nothing
   * written. A fresh verdict reads nothing, so a text reply waits no longer.
   */
  const blockClients = {did, appviewClient: opts.appviewClient}
  const firstCheck = await recheckReplyBlock(blockClients, plan.blockCheck)

  /*
   * The rkeys are chosen client-side, so the whole compose's URIs are known
   * before anything is written, and the reply and quote limits (4.14) are
   * written before any post: a private post is never published without the
   * limits its author chose.
   */
  let tid: TID | undefined
  const rkeys = thread.posts.map(() => {
    tid = nextTid(did, tid)
    return tid.toString()
  })
  const postUris = rkeys.map(rkey => `at://${did}/${PP_COLLECTION}/${rkey}`)

  // As stock: at most three languages, from the composer's choice (K-1).
  const langs =
    PRIVATE_LANGS_LABELS && opts.langs?.length
      ? opts.langs.slice(0, 3)
      : undefined
  const composed = buildComposedPosts({
    posts: thread.posts,
    resolved,
    audienceUri: plan.audienceUri,
    langs,
    composeSpoilers,
  })

  const gateWrites = gatesForNewPost({
    threadgate: thread.threadgate,
    postgate: thread.postgate,
    postUris,
    isReply: !!opts.replyTo,
  })
  /*
   * The block check once more before the first post write (RB-13, PR6-L1,
   * PR7-L1). A forced read starts beside the gate writes only when the
   * verdict turns older than `prePostFreshMs` while they are in flight (at
   * once when it already is), so a fast reply adds no round trip. Its
   * refusal is taken inside the `try` below,
   * whose `catch` deletes the gates.
   */
  const gatesDone = writeComposeGates(opts, did, gateWrites)
  const forcedRead: {
    result?: Promise<PromiseSettledResult<ReplyBlockCheck | undefined>>
  } = {}
  let forcedTimer: ReturnType<typeof setTimeout> | undefined
  if (gateWrites.length > 0 && firstCheck) {
    const startForced = () => {
      // Settled at once, so a refusal is never an unhandled rejection.
      forcedRead.result = recheckReplyBlock(blockClients, firstCheck, {
        force: true,
      }).then(
        value => ({status: 'fulfilled' as const, value}),
        (reason: unknown) => ({status: 'rejected' as const, reason}),
      )
    }
    const delay =
      firstCheck.checkedAt + REPLY_BLOCK_TIMING.prePostFreshMs - Date.now()
    if (delay <= 0) startForced()
    else forcedTimer = setTimeout(startForced, delay)
  }
  const [gatesResult] = await Promise.allSettled([gatesDone])
  // The gates finished first: no forced read.
  clearTimeout(forcedTimer)
  const forcedResult = forcedRead.result ? await forcedRead.result : undefined
  if (gatesResult.status === 'rejected') {
    /*
     * Nothing to delete: the gate write's own failure path removed what it
     * created. A block refusal wins (PR7-N5); a check that could not be made
     * does not replace the gates' own error.
     */
    if (
      forcedResult?.status === 'rejected' &&
      forcedResult.reason instanceof PrivateReplyBlockedError
    ) {
      throw forcedResult.reason
    }
    throw gatesResult.reason
  }
  const gateUris = gatesResult.value

  const uris: string[] = []
  /** Posts known or possibly written, for rollback. */
  const written: string[] = []
  const views = new Map<string, app.bsky.feed.defs.PostView>()
  if (plan.parentView) views.set(plan.parentView.uri, plan.parentView)

  let reply = plan.reply
  /** Whether prism caught up with the compose's last post (5.7). */
  let lastCaughtUp: Promise<boolean> | undefined

  try {
    if (forcedResult?.status === 'rejected') throw forcedResult.reason
    /*
     * Measured from the forced read's start when one ran (PR8-L1): the gate
     * writes have no deadline, so a slow gate can outlast even that verdict.
     */
    await recheckReplyBlock(
      blockClients,
      forcedResult ? forcedResult.value : firstCheck,
      {freshMs: REPLY_BLOCK_TIMING.prePostFreshMs},
    )
    for (const [index, draft] of thread.posts.entries()) {
      const rkey = rkeys[index]
      const uri = postUris[index]
      const withReply = reply ? {reply} : {}
      const record: PostPrivate = validatePrivateRecord({
        ...composed[index],
        ...withReply,
      })

      opts.onStateChange?.(t`Posting privately...`)
      let cid: string | undefined
      try {
        await postingWriter.createPost({
          procedure: plan.procedure,
          rkey,
          record,
        })
        const stored = await readRecordState(opts.pdsClient, did, rkey)
        if (stored.state !== 'present' || !stored.cid) {
          throw new Error('getRecord did not return the stored private post')
        }
        cid = stored.cid
      } catch (error) {
        /*
         * An error does not mean nothing was stored: aurora commits before
         * it reconciles blobs or checks the commit size, and a response can
         * be lost. Ask for the record before deciding.
         */
        const after = await readRecordState(opts.pdsClient, did, rkey)
        if (after.state !== 'absent') written.push(uri)
        if (isReplyRefusal(error, !!reply)) {
          throw new PrivateReplyRefusedError()
        }
        throw error
      }
      written.push(uri)
      uris.push(uri)
      if (index === thread.posts.length - 1) {
        lastCaughtUp = requestRecordCaughtUp(prism, uri)
      } else {
        requestRecordQuietly(prism, uri)
      }

      const postView = toPostView(
        {
          uri,
          cid,
          author: authorView(queryClient, did),
          record,
          indexedAt: record.createdAt,
          labels: [],
        },
        {
          embed: pendingEmbedView(
            record,
            did,
            quoteViewFromCache(queryClient, draft.embed.quote?.uri),
          ),
          isPending: true,
        },
      )
      if (postView) {
        views.set(uri, postView)
        const parent = reply ? views.get(reply.parent.uri) : undefined
        const root = reply ? views.get(reply.root.uri) : undefined
        const parentRef = asThreadParent(parent)
        const rootRef = asThreadParent(root)
        addPendingPost({
          uri,
          cid,
          did,
          record,
          audienceUri: plan.audienceUri,
          postView,
          feedItem:
            parentRef && rootRef
              ? {post: postView, reply: {root: rootRef, parent: parentRef}}
              : {post: postView},
          createdAt: record.createdAt,
          expiresAt: Date.now() + PENDING_TTL_MS,
        })
      }

      /*
       * Later posts reply to this one, under the same audience and through
       * the same procedure: a reply under another account's audience stays
       * a participation.
       */
      reply = {root: reply?.root ?? {uri, cid}, parent: {uri, cid}}
    }
  } catch (error) {
    const remaining = [
      ...(await rollBack(repoWriter, opts.pdsClient, written)),
      ...(await deleteGates(opts.pdsClient, gateUris)),
    ]
    if (remaining.length > 0) {
      logger.error('private thread could not be fully removed', {
        uris: remaining,
      })
      // A refusal comes before any post is written: only gates remain.
      if (
        error instanceof PrivateReplyBlockedError ||
        error instanceof PrivateReplyCheckError
      ) {
        throw error
      }
      throw new PrivateThreadPartlyPostedError(remaining)
    }
    if (isNetworkError(error)) {
      throw new Error(
        t`Post failed to upload. Please check your Internet connection and try again.`,
      )
    }
    throw error
  }

  setPendingBatch(uris)
  confirmInBackground(prism, uris)
  // Never rejects; on `true` the posts read at once, before the schedule.
  void lastCaughtUp?.then(caughtUp => {
    if (caughtUp) confirmNow(prism, uris)
  })
  invalidateAuthorPrivateFeeds(queryClient, did)
  return {uris}
}

/**
 * Delete a private post through `writer`. If the delete fails, `getRecord`
 * decides: a post already gone counts as deleted; otherwise the error is
 * rethrown. A stock delete that a kryphocron host refused (PA-5, which has
 * already moved the routes) is retried once through `deletePostPrivate`.
 * Then prism is told, and the post's pending entry and facts are forgotten.
 */
async function deleteThrough(
  writer: RepoWriter,
  pdsClient: Client,
  uri: string,
): Promise<void> {
  const {host, rkey} = new AtUri(uri)
  try {
    await writer.deletePost(uri)
  } catch (error) {
    if (error instanceof PrivateKryphocronHostError) {
      return deleteThrough(locusRepoWriter(pdsClient), pdsClient, uri)
    }
    const {state} = await readRecordState(pdsClient, host, rkey)
    if (state !== 'absent') throw error
  }
  requestRecordQuietly(getPrismClient(pdsClient), uri)
  forgetPrivatePost(uri)
}

/**
 * Delete a private post (4.4) through the repo writer of the account's repo
 * route: `deletePostPrivate` on locus, `deleteRecord` on any other PDS.
 * Never depends on the posting route, membership, prism or the encoder.
 */
export async function deletePrivatePost(
  pdsClient: Client,
  uri: string,
): Promise<void> {
  const {repoRoute} = getWriteRoute(clientDid(pdsClient))
  await deleteThrough(repoWriterFor(repoRoute, pdsClient), pdsClient, uri)
}
