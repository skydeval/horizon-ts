/*
 * The steps of a private compose that both routes share, and the encode
 * route's local encode (2K design 4.2). `writes.ts` runs them in order on the
 * locus route, with the composer waiting; the outbox (`private/outbox.ts`)
 * runs them on the encode route in its background job, from what was
 * captured at press (PA-28). Kept apart from `writes.ts` so the outbox and
 * the write path do not import each other.
 *
 * Nothing here reads composer- or session-scoped state: every value is an
 * argument (PA-28 step 1), except the published current clients that
 * `authorView` and `pendingEmbedView` read for display only.
 *
 * Logs name URIs, key names and failure classes only, never private text or
 * an encoder's or server's message.
 */

import {type Client, XrpcResponseError} from '@atproto/lex'
import {type DidString, toDatetimeString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'

import {resolveEmbed, resolveReply} from '#/lib/api/index'
import {type ResolvedLink} from '#/lib/api/resolve'
import {logger} from '#/logger'
import {RQKEY_ROOT as POST_FEED_RQKEY_ROOT} from '#/state/queries/post-feed'
import {RQKEY as profileQueryKey} from '#/state/queries/profile'
import {RQKEY_LINK} from '#/state/queries/resolve-link'
import {type PostDraft} from '#/view/com/composer/state/composer'
import {kryphocron} from '#/horizon/lexicons'
import {
  type PostPrivate,
  type PostPrivateEncoded,
} from '#/horizon/lexicons/kryphocron'
import {type ComposeSpoilers} from '#/horizon/media-spoilers/compose-store'
import {
  contentWarningLabelValues,
  resolveComposeRT,
  withMediaSpoilers,
} from '#/horizon/media-spoilers/write'
import {embedViewFromRecord} from '#/horizon/private/adapt/embed-view'
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
import {getPrivatePosts} from '#/horizon/private/api/reads'
import {
  placePrivateReply,
  type StrongRef,
} from '#/horizon/private/api/reply-anchor'
import {
  assertClear,
  type BlockVerdict,
  combineVerdicts,
  needsReplyBlockCheck,
  parentAuthorOf,
  PrivateReplyBlockedError,
  readAppviewBlocks,
  readPrivateBlocks,
  type ReplyBlockCheck,
} from '#/horizon/private/api/reply-block'
import {
  PrivatePostInvalidError,
  validateEncodedRecord,
  validatePrivateRecord,
} from '#/horizon/private/api/validate'
import {
  type PostingWriter,
  type PostProcedure,
} from '#/horizon/private/api/writer'
import {type ComposeAudience} from '#/horizon/private/composer/state'
import {
  type EncodeFailureClass,
  type Encoder,
  loadEncoder,
  PrivateEncodeFailedError,
} from '#/horizon/private/encoder'
import {parseGenerationSecs} from '#/horizon/private/rotation/generation'
import {
  CONFIRM_AT_MS,
  confirmPendingPost,
  getPendingPost,
} from '#/horizon/private/store'
import {isPrivatePostUri, PP_COLLECTION} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {resolveSpoilerRT, type SpoilerWriteMode} from '#/horizon/spoilers/write'
import {type app, com} from '#/lexicons'

/*
 * When prism is asked whether it serves a just-written post. Kept with the
 * pending store, which the suspect registry reads without the compose path.
 */
export {CONFIRM_AT_MS}

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
export type Plan = {
  audienceUri: string
  procedure: PostProcedure
  reply: {root: StrongRef; parent: StrongRef} | undefined
  /** The parent's view, when the parent is a private post. */
  parentView: app.bsky.feed.defs.PostView | undefined
  /**
   * The reply block check this plan passed, taken again before the first
   * write when it is no longer fresh (`recheckReplyBlock`). `undefined`
   * when there was no pair to check.
   */
  blockCheck?: ReplyBlockCheck
}

/**
 * The value of a settled promise, or its reason thrown.
 */
function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason
  return result.value
}

/**
 * Decide the first post's audience, procedure and reply refs (4.7):
 *
 * - a reply to a private post sits in a thread or a branch: it names the
 *   anchor's current audience, whatever the composer shows, and is written
 *   with `createPostPrivate` when the anchor is the writer's, else with
 *   `participatePrivate` (`reply-anchor.ts`);
 * - anything else (a top-level post, or a private reply to a public post,
 *   which starts a branch) names `audience`: on the locus route the
 *   composer's, read before the first await; on the encode route the one
 *   captured at press (2K design PA-28 step 1). It is written with
 *   `createPostPrivate`, a branch root with the stock reply refs (the public
 *   parent and the public thread root).
 *
 * On the encode route the procedure is not used; the placement read is its
 * write-time check (PA-34).
 *
 * A reply to another author's post is also block-checked here (`reply-block.ts`),
 * the one plan every first post of a private reply goes through on both
 * routes, before anything is uploaded or written. A plan comes out only when
 * the check is `clear`; otherwise this throws `PrivateReplyBlockedError`
 * (which wins over every other outcome, a placement miss included) or, when
 * the check could not be made and nothing else failed,
 * `PrivateReplyCheckError`. The AppView read starts with the placement
 * reads, so it adds no round trip; the private-block source is decided once
 * placement settles. `skipBlockCheck` is for a Finish posting, whose posts
 * all reply to the member's own post 1.
 */
export async function planFirstPost(
  queryClient: QueryClient,
  clients: AudienceClients,
  compose: {replyTo?: string; appviewClient: Client; skipBlockCheck?: boolean},
  audience: ComposeAudience,
  writer: PostingWriter,
): Promise<Plan> {
  const replyTo = compose.replyTo
  const checkedAt = Date.now()
  const authorDid =
    !compose.skipBlockCheck && needsReplyBlockCheck(clients.did, replyTo)
      ? parentAuthorOf(replyTo as string)
      : undefined
  const blockClients = {
    did: clients.did,
    pdsClient: clients.pdsClient,
    appviewClient: compose.appviewClient,
  }
  // No pair (no reply, the member's own parent, or the switch off): clear.
  const appviewPart: Promise<BlockVerdict> = authorDid
    ? readAppviewBlocks(compose.appviewClient, clients.did, authorDid)
    : Promise.resolve('clear')

  if (replyTo && isPrivatePostUri(replyTo)) {
    const [placed, appview] = await Promise.allSettled([
      placePrivateReply(clients, replyTo),
      appviewPart,
    ])
    const appviewVerdict =
      appview.status === 'fulfilled' ? appview.value : 'unknown'
    if (appviewVerdict === 'blocked') throw new PrivateReplyBlockedError()
    const place = settledValue(placed)
    let blockCheck: ReplyBlockCheck | undefined
    if (authorDid) {
      /*
       * prism's serve of the parent is the private-block check (its read
       * rule relates the pair); without one, the two listings are.
       */
      const privateBlocks = place.parentServedByPrism ? 'prism' : 'listings'
      const verdict =
        privateBlocks === 'prism'
          ? appviewVerdict
          : combineVerdicts([
              appviewVerdict,
              await readPrivateBlocks(blockClients, authorDid),
            ])
      assertClear(verdict)
      blockCheck = {authorDid, privateBlocks, checkedAt}
    }
    return {
      audienceUri: place.anchor.audienceUri,
      procedure:
        place.anchor.authorDid === clients.did
          ? kryphocron.createPostPrivate
          : kryphocron.participatePrivate,
      reply: place.reply,
      parentView: place.parentView,
      blockCheck,
    }
  }

  // A public parent is never read through prism: the listings always run.
  const checkPromise: Promise<BlockVerdict> = authorDid
    ? Promise.all([
        appviewPart,
        readPrivateBlocks(blockClients, authorDid),
      ]).then(combineVerdicts)
    : appviewPart
  /*
   * A standing audience the reply needs is created only once the check is
   * clear: a blocked reply writes nothing, not even its audience.
   */
  const checkedWriter: PostingWriter = {
    route: writer.route,
    createPost: post => writer.createPost(post),
    changeAudience: (uri, swapCid, audienceUri) =>
      writer.changeAudience(uri, swapCid, audienceUri),
    createAudience: async record => {
      assertClear(await checkPromise)
      return writer.createAudience(record)
    },
  }
  const audiencePromise = (async () => {
    if (audience.kind === 'mode') {
      return findOrCreateStandingAudience(
        queryClient,
        clients,
        audience.mode,
        checkedWriter,
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
    ? resolveReply(compose.appviewClient, replyTo)
    : Promise.resolve(undefined)
  const [audienceResult, replyResult, checkResult] = await Promise.allSettled([
    audiencePromise,
    replyPromise,
    checkPromise,
  ])
  const verdict =
    checkResult.status === 'fulfilled' ? checkResult.value : 'unknown'
  if (verdict === 'blocked') throw new PrivateReplyBlockedError()
  const audienceUri = settledValue(audienceResult)
  const reply = settledValue(replyResult)
  assertClear(verdict)
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
    blockCheck: authorDid
      ? {authorDid, privateBlocks: 'listings', checkedAt}
      : undefined,
  }
}

export type RecordState = 'present' | 'absent' | 'unknown'

/**
 * Whether the private post at `rkey` exists, read with `getRecord`. A PDS
 * answers `RecordNotFound` for a missing record; any other failure is
 * unknown. A present record comes with its CID and stored value (2K design
 * PA-28, K11-L2). `signal` gives the read its timeout.
 */
export async function readRecordState(
  pdsClient: Client,
  did: string,
  rkey: string,
  {signal}: {signal?: AbortSignal} = {},
): Promise<{state: RecordState; cid?: string; value?: unknown}> {
  try {
    const res = await pdsClient.call(
      com.atproto.repo.getRecord,
      {
        repo: did as DidString,
        collection: PP_COLLECTION,
        rkey,
      },
      {signal},
    )
    return {state: 'present', cid: res.cid, value: res.value}
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
 * The author's profile for a pending post's view, from the query cache, else
 * the published account's handle.
 */
export function authorView(
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

/**
 * The quoted post's view, when the composer resolved it.
 */
export function quoteViewFromCache(
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
export function pendingEmbedView(
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

export function asThreadParent(
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
export function confirmInBackground(prism: Client, uris: string[]) {
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
export function confirmNow(prism: Client, uris: string[]) {
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
 * The clients resolving a compose's text and embeds.
 */
export type ResolveClients = {
  appviewClient: Client
  chatClient: Client
  pdsClient: Client
}

/**
 * One post's resolved text and embed.
 */
export type ResolvedPost = {
  rt: Awaited<ReturnType<typeof resolveSpoilerRT>>
  embed: Awaited<ReturnType<typeof resolveEmbed>>
}

/**
 * Resolve each post's text and embed, one post at a time (as stock, a post's
 * images upload together), before anything is written. The embed is the
 * stock `resolveEmbed`'s, which uploads every blob the post carries; the
 * video itself was uploaded through the video service while composing. The
 * spoilers and their write mode are passed in: captured before the first
 * await (2J design 4.6; 2K design PA-28 step 1).
 */
export async function resolveComposePosts(
  queryClient: QueryClient,
  clients: ResolveClients,
  posts: readonly PostDraft[],
  composeSpoilers: ComposeSpoilers,
  spoilerMode: SpoilerWriteMode,
  onStateChange?: (state: string) => void,
): Promise<ResolvedPost[]> {
  const resolved: ResolvedPost[] = []
  for (const draft of posts) {
    const [rt, embed] = await Promise.all([
      resolveComposeRT(
        clients.appviewClient,
        draft,
        composeSpoilers,
        spoilerMode,
      ) ?? resolveSpoilerRT(clients.appviewClient, draft.richtext, spoilerMode),
      resolveEmbed(
        clients.appviewClient,
        clients.chatClient,
        clients.pdsClient,
        queryClient,
        draft,
        onStateChange,
      ),
    ])
    resolved.push({rt, embed})
  }
  return resolved
}

/**
 * One post's plaintext record, not yet validated and without its reply refs:
 * a thread's later posts take their parent's CID only once the parent is
 * written.
 */
export type ComposedPost = Record<string, unknown>

/**
 * Each post's plaintext record from its resolved text and embed, under
 * `audienceUri`, 1 ms apart from `now` as stock does, with the captured
 * langs and each post's self-labels and CW label.
 */
export function buildComposedPosts({
  posts,
  resolved,
  audienceUri,
  langs,
  composeSpoilers,
  now = new Date(),
}: {
  posts: readonly PostDraft[]
  resolved: readonly ResolvedPost[]
  audienceUri: string
  langs: string[] | undefined
  composeSpoilers: ComposeSpoilers
  now?: Date
}): ComposedPost[] {
  return posts.map((draft, index) => {
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
      audienceList: audienceUri,
      ...(facets ? {facets} : {}),
      ...(privateEmbed ? {embed: privateEmbed} : {}),
      ...(langs ? {langs} : {}),
      ...(labels ? {labels} : {}),
    }
  })
}

/**
 * One post of an encode-route compose, prepared before any write: its
 * plaintext record (for the author's pending view only, never written) and
 * the encoded record written at its rkey.
 */
export type EncodedPost = {plain: PostPrivate; record: PostPrivateEncoded}

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
export function checkEncodedRecord(record: unknown): PostPrivateEncoded {
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
 * record after. Every call is a fresh encode, so a retry at the same rkeys
 * gets a fresh slug (D-0.8); nothing keeps the encoded bytes.
 */
export async function encodeComposePosts(
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
