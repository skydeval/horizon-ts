/*
 * The private write path: publishing a private compose (one post or a
 * thread) with its reply and quote limits, deleting a private post, and
 * what follows each write.
 *
 * A private compose never falls through to a public post. Each post's record
 * is validated locally before it is sent, written through the kryphocron
 * procedure with a client-chosen rkey, and its stored CID read back with
 * `getRecord` (written before aurora answered the record's CID, A-1; the
 * read is kept, as it confirms the record is stored). A reply's audience and
 * procedure come from its anchor (`reply-anchor.ts`). A thread is written one
 * post at a time, because each reply needs the previous post's CID; a failure
 * removes whatever was written, so a failed private compose leaves nothing
 * posted.
 *
 * Each call takes its writers once, at entry, by the account's routes (2K
 * design PA-9, PA-20): a compose goes through the posting writer, which
 * refuses before any work while the posting route is `checking` or `none`;
 * deletes and the rollback go through the repo writer, which every route has.
 *
 * On posting route `encode` (2K design 4.2) the posts are encoded in the
 * client before any gate or post is written (PA-12): each at its own rkey,
 * chosen first (PA-21), then checked as the encoded record it becomes
 * (PA-10). Each is written with stock `createRecord` on the account's own
 * PDS, whose answer carries the record CID, and confirmed through prism
 * directly (PA-7), so the post's text never passes the writer's PDS. Until
 * the outbox (2K-9) the composer waits for the writes, and a failure rolls
 * back what was written, as on locus.
 *
 * Logs name URIs, key names and failure classes only, never private text or
 * an encoder's or server's message.
 */

import {TID} from '@atproto/common-web'
import {type Client, XrpcResponseError} from '@atproto/lex'
import {AtUri, type DidString, toDatetimeString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'

import {type PostOpts, resolveEmbed, resolveReply} from '#/lib/api/index'
import {type ResolvedLink} from '#/lib/api/resolve'
import {isNetworkError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {RQKEY_ROOT as POST_FEED_RQKEY_ROOT} from '#/state/queries/post-feed'
import {RQKEY as profileQueryKey} from '#/state/queries/profile'
import {RQKEY_LINK} from '#/state/queries/resolve-link'
import {kryphocron} from '#/horizon/lexicons'
import {
  type PostPrivate,
  type PostPrivateEncoded,
} from '#/horizon/lexicons/kryphocron'
import {getComposeSpoilers} from '#/horizon/media-spoilers/compose-store'
import {
  contentWarningLabelValues,
  resolveComposeRT,
  withMediaSpoilers,
} from '#/horizon/media-spoilers/write'
import {embedViewFromRecord} from '#/horizon/private/adapt/embed-view'
import {toPostView} from '#/horizon/private/adapt/post-view'
import {
  toPrivateEmbed,
  toPrivateFacets,
  toPrivateSelfLabels,
} from '#/horizon/private/adapt/record'
import {
  assertOwnAudienceExists,
  type AudienceClients,
  findOrCreateStandingAudience,
  PrivateAudienceMissingError,
} from '#/horizon/private/api/audiences'
import {
  assembleEncodedRecord,
  encoderContentOf,
} from '#/horizon/private/api/encoded-record'
import {
  deleteGates,
  gatesForNewPost,
  PrivateGateWriteError,
  writeGatesForNewPost,
} from '#/horizon/private/api/gates'
import {getPrivatePosts} from '#/horizon/private/api/reads'
import {
  placePrivateReply,
  PrivateParentUnavailableError,
  PrivateReplyRefusedError,
  type StrongRef,
} from '#/horizon/private/api/reply-anchor'
import {
  requestRecordCaughtUp,
  requestRecordQuietly,
} from '#/horizon/private/api/request-record'
import {
  PrivatePostInvalidError,
  validateEncodedRecord,
  validatePrivateRecord,
} from '#/horizon/private/api/validate'
import {
  locusRepoWriter,
  type PostingWriter,
  postingWriterFor,
  type PostProcedure,
  PrivateKryphocronHostError,
  type RepoWriter,
  repoWriterFor,
} from '#/horizon/private/api/writer'
import {
  type ComposeAudience,
  getComposeVisibility,
} from '#/horizon/private/composer/state'
import {
  type EncodeFailureClass,
  type Encoder,
  loadEncoder,
  PrivateEncodeFailedError,
} from '#/horizon/private/encoder'
import {parseGenerationSecs} from '#/horizon/private/rotation/generation'
import {PRIVATE_LANGS_LABELS} from '#/horizon/private/server-support'
import {
  addPendingPost,
  confirmPendingPost,
  forgetPrivatePost,
  getPendingPost,
  PENDING_TTL_MS,
  setPendingBatch,
} from '#/horizon/private/store'
import {isPrivatePostUri, PP_COLLECTION} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {getPrismClient} from '#/horizon/routing/prism'
import {getDirectPrismClient} from '#/horizon/routing/prism-direct'
import {clientDid, getWriteRoute} from '#/horizon/routing/write-route'
import {resolveSpoilerRT, spoilerWriteMode} from '#/horizon/spoilers/write'
import {type app, com} from '#/lexicons'

export {requestRecordQuietly}
export {PrivateParentUnavailableError, PrivateReplyRefusedError}

/**
 * When prism is asked whether it serves a just-written post, in milliseconds
 * after the write.
 */
export const CONFIRM_AT_MS = [1_000, 2_000, 4_000, 8_000, 16_000]

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

/**
 * The reply and quote limits of a private compose could not be written, so
 * nothing was posted.
 */
export class PrivateGatesNotSavedError extends Error {
  constructor() {
    super(
      t`Your reply and quote settings couldn’t be saved, so nothing was posted. Try again.`,
    )
    this.name = 'PrivateGatesNotSavedError'
  }
}

/**
 * The encode route could not prepare the compose (2K design 4.9): the encoder
 * failed to load or to encode (its classes, PA-31), or the record it
 * assembled did not validate (`assembly`). Nothing was written; the encoder's
 * message is never kept.
 */
export class PrivateEncodeError extends Error {
  constructor(readonly failureClass: EncodeFailureClass | 'assembly') {
    super(t`Private posting isn’t available right now. Nothing was posted.`)
    this.name = 'PrivateEncodeError'
  }
}

/**
 * What the first post of a compose is written under, decided before any
 * write.
 */
type Plan = {
  audienceUri: string
  procedure: PostProcedure
  reply: {root: StrongRef; parent: StrongRef} | undefined
  /** The parent's view, when the parent is a private post. */
  parentView: app.bsky.feed.defs.PostView | undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decide the first post's audience, procedure and reply refs (4.7):
 *
 * - a reply to a private post sits in a thread or a branch: it names the
 *   anchor's current audience, whatever the composer shows, and is written
 *   with `createPostPrivate` when the anchor is the writer's, else with
 *   `participatePrivate` (`reply-anchor.ts`);
 * - anything else (a top-level post, or a private reply to a public post,
 *   which starts a branch) names the composer's `audience`, read by the
 *   caller before its first await, and is written with `createPostPrivate`,
 *   a branch root with the stock reply refs (the public parent and the
 *   public thread root).
 *
 * On the encode route the procedure is not used; the placement read is its
 * write-time check (PA-34).
 */
async function planFirstPost(
  queryClient: QueryClient,
  clients: AudienceClients,
  opts: PostOpts,
  audience: ComposeAudience,
  writer: PostingWriter,
): Promise<Plan> {
  const replyTo = opts.replyTo
  if (replyTo && isPrivatePostUri(replyTo)) {
    const place = await placePrivateReply(clients, replyTo)
    return {
      audienceUri: place.anchor.audienceUri,
      procedure:
        place.anchor.authorDid === clients.did
          ? kryphocron.createPostPrivate
          : kryphocron.participatePrivate,
      reply: place.reply,
      parentView: place.parentView,
    }
  }

  const audiencePromise = (async () => {
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
    // A parent audience without a private parent: nothing to inherit.
    throw new PrivateAudienceMissingError()
  })()
  const replyPromise = replyTo
    ? resolveReply(opts.appviewClient, replyTo)
    : Promise.resolve(undefined)
  const [audienceUri, reply] = await Promise.all([
    audiencePromise,
    replyPromise,
  ])
  return {
    audienceUri,
    procedure: kryphocron.createPostPrivate,
    reply: reply
      ? {
          root: {uri: reply.root.uri, cid: reply.root.cid},
          parent: {uri: reply.parent.uri, cid: reply.parent.cid},
        }
      : undefined,
    parentView: undefined,
  }
}

type RecordState = 'present' | 'absent' | 'unknown'

/**
 * Whether the record at `rkey` exists, read with `getRecord`. aurora answers
 * `RecordNotFound` for a missing record; any other failure is unknown.
 */
async function readRecordState(
  pdsClient: Client,
  did: string,
  rkey: string,
): Promise<{state: RecordState; cid?: string}> {
  try {
    const res = await pdsClient.call(com.atproto.repo.getRecord, {
      repo: did as DidString,
      collection: PP_COLLECTION,
      rkey,
    })
    return {state: 'present', cid: res.cid}
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return {state: 'absent'}
    }
    return {state: 'unknown'}
  }
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

function authorView(
  queryClient: QueryClient,
  did: string,
): app.bsky.actor.defs.ProfileViewBasic {
  const profile =
    queryClient.getQueryData<app.bsky.actor.defs.ProfileViewDetailed>(
      profileQueryKey(did),
    )
  if (profile && profile.did === did) {
    return {
      did: profile.did,
      handle: profile.handle,
      displayName: profile.displayName,
      avatar: profile.avatar,
      associated: profile.associated,
      viewer: profile.viewer,
      labels: profile.labels,
      createdAt: profile.createdAt,
      verification: profile.verification,
      status: profile.status,
      pronouns: profile.pronouns,
    }
  }
  const current = getCurrentClients()
  return {
    did: did as DidString,
    handle: (current?.did === did
      ? current.handle
      : 'handle.invalid') as app.bsky.actor.defs.ProfileViewBasic['handle'],
  }
}

function quoteViewFromCache(
  queryClient: QueryClient,
  quoteUrl: string | undefined,
): app.bsky.feed.defs.PostView | undefined {
  if (!quoteUrl) return undefined
  const resolved = queryClient.getQueryData<ResolvedLink>(RQKEY_LINK(quoteUrl))
  return resolved?.type === 'record' && resolved.kind === 'post'
    ? resolved.view
    : undefined
}

/**
 * The embed view of a just-written post, built by the client because prism
 * serves none (P-1): `embedViewFromRecord` with the author's own PDS and the
 * quote the composer resolved.
 */
function pendingEmbedView(
  record: PostPrivate,
  did: string,
  quoteView: app.bsky.feed.defs.PostView | undefined,
): app.bsky.feed.defs.PostView['embed'] {
  const current = getCurrentClients()
  return embedViewFromRecord(record, {
    authorDid: did,
    pdsUrl: current?.did === did ? current.pdsUrl : undefined,
    quoteViews: quoteView ? new Map([[quoteView.uri, quoteView]]) : undefined,
  })
}

function asThreadParent(
  view: app.bsky.feed.defs.PostView | undefined,
): app.bsky.feed.defs.ReplyRef['parent'] | undefined {
  return view ? {...view, $type: 'app.bsky.feed.defs#postView'} : undefined
}

const confirmationTimers = new Set<ReturnType<typeof setTimeout>>()

/**
 * Ask prism, in the background, whether it serves the just-written posts
 * yet; each one it returns stops being pending. Nothing is shown either way:
 * the posts exist on the PDS.
 */
function confirmInBackground(prism: Client, uris: string[]) {
  let remaining = [...uris]
  let previous = 0
  const attempt = (index: number) => {
    if (index >= CONFIRM_AT_MS.length || remaining.length === 0) return
    const delay = CONFIRM_AT_MS[index] - previous
    previous = CONFIRM_AT_MS[index]
    const timer = setTimeout(() => {
      confirmationTimers.delete(timer)
      getPrivatePosts(prism, remaining).then(
        posts => {
          const served = new Set<string>(posts.map(post => post.uri))
          served.forEach(uri => confirmPendingPost(uri))
          remaining = remaining.filter(uri => !served.has(uri))
          attempt(index + 1)
        },
        () => attempt(index + 1),
      )
    }, delay)
    confirmationTimers.add(timer)
  }
  attempt(0)
}

/**
 * One confirmation read now, of the compose's posts still pending: prism
 * answered `caughtUp` for the compose's last post (2H design 5.7).
 */
function confirmNow(prism: Client, uris: string[]) {
  const remaining = uris.filter(uri => !!getPendingPost(uri))
  if (remaining.length === 0) return
  getPrivatePosts(prism, remaining).then(
    posts => posts.forEach(post => confirmPendingPost(post.uri)),
    () => {},
  )
}

/**
 * Stop every background confirmation (tests).
 */
export function stopPrivateConfirmations() {
  confirmationTimers.forEach(timer => clearTimeout(timer))
  confirmationTimers.clear()
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
 * Resolve each post's text and embed, one post at a time (as stock, a post's
 * images upload together), before anything is written. The embed is the
 * stock `resolveEmbed`'s, which uploads every blob the post carries; the
 * video itself was uploaded through the video service while composing.
 */
async function resolveComposePosts(
  queryClient: QueryClient,
  opts: PostOpts,
  composeSpoilers: ReturnType<typeof getComposeSpoilers>,
) {
  const resolved: {
    rt: Awaited<ReturnType<typeof resolveSpoilerRT>>
    embed: Awaited<ReturnType<typeof resolveEmbed>>
  }[] = []
  for (const draft of opts.thread.posts) {
    const [rt, embed] = await Promise.all([
      resolveComposeRT(
        opts.appviewClient,
        draft,
        composeSpoilers,
        spoilerWriteMode(true),
      ) ??
        resolveSpoilerRT(
          opts.appviewClient,
          draft.richtext,
          spoilerWriteMode(true),
        ),
      resolveEmbed(
        opts.appviewClient,
        opts.chatClient,
        opts.pdsClient,
        queryClient,
        draft,
        opts.onStateChange,
      ),
    ])
    resolved.push({rt, embed})
  }
  return resolved
}

/**
 * Write the compose's reply and quote limits before its posts (4.5 step 0,
 * after the media uploads: D2-151).
 * A failure has written no post; the gates already created are deleted, and
 * any that cannot be are logged by URI.
 */
async function writeComposeGates(
  opts: PostOpts,
  did: string,
  postUris: string[],
): Promise<string[]> {
  const writes = gatesForNewPost({
    threadgate: opts.thread.threadgate,
    postgate: opts.thread.postgate,
    postUris,
    isReply: !!opts.replyTo,
  })
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
 * One post's plaintext record, not yet validated and without its reply refs:
 * a thread's later posts take their parent's CID only once the parent is
 * written.
 */
type ComposedPost = Record<string, unknown>

/**
 * One post of an encode-route compose, prepared before any write: its
 * plaintext record (for the author's pending view only, never written) and
 * the encoded record written at its rkey.
 */
type EncodedPost = {plain: PostPrivate; record: PostPrivateEncoded}

let unknownGenerationLogged = false

/**
 * An encoder failure as the compose reports it: logged by class only, with
 * 4.9's fixed text. A failure that is not the encoder's own (none is
 * expected) counts as `load`.
 */
function encodeFailure(error: unknown): PrivateEncodeError {
  const failureClass =
    error instanceof PrivateEncodeFailedError ? error.failureClass : 'load'
  logger.warn('encode: failed', {failureClass})
  return new PrivateEncodeError(failureClass)
}

/**
 * The encoded record a create writes, checked in the create form (PA-10). A
 * failure is a bug: logged with the key path only, and nothing is written.
 */
function checkEncodedRecord(record: unknown): PostPrivateEncoded {
  try {
    return validateEncodedRecord(record, 'create')
  } catch (error) {
    logger.error('encode: assembled record invalid', {
      path: error instanceof PrivatePostInvalidError ? error.path : undefined,
    })
    throw new PrivateEncodeError('assembly')
  }
}

/**
 * Encode every post of a compose locally (4.2 steps 4 and 5, PA-11), in
 * order, before any gate or post is written (PA-12): one encode per post at
 * its own rkey and the writer's DID (PA-21), with the device clock's seconds
 * (D-0.12). Each plaintext record is validated first (the first post with
 * its reply refs; a later post's are added at the write), and each encoded
 * record after.
 */
async function encodeComposePosts(
  did: string,
  rkeys: readonly string[],
  composed: readonly ComposedPost[],
  firstReply: Plan['reply'],
): Promise<EncodedPost[]> {
  let encoder: Encoder
  try {
    encoder = await loadEncoder()
  } catch (error) {
    throw encodeFailure(error)
  }
  const nowSecs = Math.floor(Date.now() / 1000)
  return composed.map((base, index) => {
    const reply = index === 0 ? firstReply : undefined
    const plain = validatePrivateRecord({...base, ...(reply ? {reply} : {})})
    let fields
    try {
      fields = encoder.encode({
        did,
        rkey: rkeys[index],
        content: encoderContentOf(plain),
        nowSecs,
      })
    } catch (error) {
      throw encodeFailure(error)
    }
    /*
     * prism decodes by the slug, not the mark, so a mark that does not parse
     * is written anyway; it only schedules the post's rotation (3.2).
     */
    if (
      !unknownGenerationLogged &&
      parseGenerationSecs(fields.encodedContentGeneration) === undefined
    ) {
      unknownGenerationLogged = true
      logger.warn('encode: unknown generation format')
    }
    const record = checkEncodedRecord(
      assembleEncodedRecord(
        {
          createdAt: plain.createdAt,
          audienceList: plain.audienceList,
          reply: plain.reply,
          langs: plain.langs,
          labels: plain.labels,
        },
        fields,
      ),
    )
    return {plain, record}
  })
}

/**
 * Publish a private compose. Takes the stock `PostOpts` and returns the
 * stock `{uris}`; every client comes from `opts`.
 */
export async function postPrivate(
  queryClient: QueryClient,
  opts: PostOpts,
): Promise<{uris: string[]}> {
  const thread = opts.thread
  /*
   * The media spoiler flags and content warnings, captured before the first
   * await (2J design, 4.6).
   */
  const composeSpoilers = getComposeSpoilers()

  const did = opts.pdsClient.assertDid
  /*
   * Both writers, once (PA-20): a route that changes during the compose does
   * not move it, and its rollback deletes through the same repo writer. On
   * posting route `checking` or `none` this throws before anything is
   * resolved, uploaded or written.
   */
  const routes = getWriteRoute(did)
  const postingWriter = postingWriterFor(
    routes.postingRoute,
    opts.pdsClient,
    did,
  )
  const repoWriter = repoWriterFor(routes.repoRoute, opts.pdsClient)
  const encodes = postingWriter.route === 'encode'
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
  const resolved = await resolveComposePosts(queryClient, opts, composeSpoilers)

  /*
   * The rkeys are chosen client-side, so the whole compose's URIs are known
   * before anything is written, and the reply and quote limits (4.14) are
   * written before any post: a private post is never published without the
   * limits its author chose.
   */
  let tid: TID | undefined
  const rkeys = thread.posts.map(() => {
    tid = TID.next(tid)
    return tid.toString()
  })
  const postUris = rkeys.map(rkey => `at://${did}/${PP_COLLECTION}/${rkey}`)

  const now = new Date()
  // As stock: at most three languages, from the composer's choice (K-1).
  const langs =
    PRIVATE_LANGS_LABELS && opts.langs?.length
      ? opts.langs.slice(0, 3)
      : undefined
  const composed: ComposedPost[] = thread.posts.map((draft, index) => {
    const {rt, embed} = resolved[index]
    // As stock: posts of one compose are 1 ms apart, so they sort in order.
    now.setMilliseconds(now.getMilliseconds() + 1)
    const facets = toPrivateFacets(rt.facets)
    const privateEmbed = toPrivateEmbed(
      withMediaSpoilers(embed, draft, composeSpoilers),
    )
    const labels = toPrivateSelfLabels(
      contentWarningLabelValues(draft, composeSpoilers),
    )
    return {
      $type: PP_COLLECTION,
      text: rt.text,
      createdAt: toDatetimeString(now),
      audienceList: plan.audienceUri,
      ...(facets ? {facets} : {}),
      ...(privateEmbed ? {embed: privateEmbed} : {}),
      ...(langs ? {langs} : {}),
      ...(labels ? {labels} : {}),
    }
  })

  /*
   * On the encode route every post is encoded before the gates (PA-12): an
   * encoder failure or an invalid assembly writes nothing.
   */
  const encoded = encodes
    ? await encodeComposePosts(did, rkeys, composed, plan.reply)
    : undefined

  const gateUris = await writeComposeGates(opts, did, postUris)

  const uris: string[] = []
  /** Posts known or possibly written, for rollback. */
  const written: string[] = []
  const views = new Map<string, app.bsky.feed.defs.PostView>()
  if (plan.parentView) views.set(plan.parentView.uri, plan.parentView)

  let reply = plan.reply
  /** Whether prism caught up with the compose's last post (5.7). */
  let lastCaughtUp: Promise<boolean> | undefined

  try {
    for (const [index, draft] of thread.posts.entries()) {
      const rkey = rkeys[index]
      const uri = postUris[index]
      const withReply = reply ? {reply} : {}

      /*
       * `record` is what is written; `plain` is the plaintext record, which
       * the pending view shows. The same on the locus route.
       */
      let record: PostPrivate | PostPrivateEncoded
      let plain: PostPrivate
      if (encoded) {
        plain = validatePrivateRecord({...encoded[index].plain, ...withReply})
        record = checkEncodedRecord({...encoded[index].record, ...withReply})
      } else {
        plain = validatePrivateRecord({...composed[index], ...withReply})
        record = plain
      }

      opts.onStateChange?.(t`Posting privately...`)
      let cid: string | undefined
      try {
        const res = await postingWriter.createPost({
          procedure: plan.procedure,
          rkey,
          record,
        })
        if (res.cid) {
          // The encode route: `createRecord` answers the record CID.
          cid = res.cid
        } else {
          const stored = await readRecordState(opts.pdsClient, did, rkey)
          if (stored.state !== 'present' || !stored.cid) {
            throw new Error('getRecord did not return the stored private post')
          }
          cid = stored.cid
        }
      } catch (error) {
        /*
         * An error does not mean nothing was stored: aurora commits before
         * it reconciles blobs or checks the commit size, and a response can
         * be lost. Ask for the record before deciding.
         */
        const after = await readRecordState(opts.pdsClient, did, rkey)
        if (after.state !== 'absent') written.push(uri)
        if (!encodes && isReplyRefusal(error, !!reply)) {
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
          record: plain,
          indexedAt: plain.createdAt,
          labels: [],
        },
        {
          embed: pendingEmbedView(
            plain,
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
          record: plain,
          audienceUri: plan.audienceUri,
          postView,
          feedItem:
            parentRef && rootRef
              ? {post: postView, reply: {root: rootRef, parent: parentRef}}
              : {post: postView},
          createdAt: plain.createdAt,
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
  /*
   * On the encode route the confirmation reads go to prism directly (PA-7),
   * so the post's text never passes the writer's PDS; the token is minted
   * here when none is cached, and a failure only fails that read.
   */
  const confirmer = encodes ? getDirectPrismClient(opts.pdsClient) : prism
  confirmInBackground(confirmer, uris)
  // Never rejects; on `true` the posts read at once, before the schedule.
  void lastCaughtUp?.then(caughtUp => {
    if (caughtUp) confirmNow(confirmer, uris)
  })
  invalidateAuthorPrivateFeeds(queryClient, did)
  return {uris}
}

/**
 * Refetch an author's Private tab and the Posts and Replies tabs that merge
 * it.
 */
export function invalidateAuthorPrivateFeeds(
  queryClient: QueryClient,
  did: string,
) {
  for (const filter of [
    'horizon_private',
    'posts_and_author_threads',
    'posts_with_replies',
  ]) {
    void queryClient.invalidateQueries({
      queryKey: [POST_FEED_RQKEY_ROOT, `author|${did}|${filter}`],
    })
  }
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
