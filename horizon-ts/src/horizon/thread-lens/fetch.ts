/*
 * The lens reads (Phase 4 design 5, 9, 11.3): `runLens`, the lens half of
 * the thread query function (TL-27), and the continuations and retry the
 * rows queue (9.2, 9.3).
 *
 * `runLens` returns either the lens answer, or no data and a `tag` that the
 * stock body's answer goes through, so the fallback is the stock read in the
 * same run, stored under the lens key with its reason (TL-27). A failure is
 * handled in this order (11.3; v6: R4-L1): (1) a refusal is recorded (by
 * `api.ts`, for the key's DID); (2) any other failure over a held snapshot
 * keeps it with the failure's note and its `runId` (TL-35), the current data
 * read when the failure is caught; (3) a lens-only anchor gets the gap-only
 * answer, or the unverified one when the registry does not hold it, with
 * the case's note; (4) anything else falls back.
 *
 * A gap URI is sent only to prism's lens methods: the public-view pass reads
 * post nodes only, the private branches are read only for a post anchor and
 * only for the key's account, and a lens-only anchor never falls back.
 */

import {type Client} from '@atproto/lex'
import {AtUri} from '@atproto/syntax'
import {type QueryClient, type QueryKey} from '@tanstack/react-query'

import {logger} from '#/logger'
import {fetchStamp} from '#/horizon/private/load-gate'
import {resolvePrivateQuotes} from '#/horizon/private/quotes/resolve'
import {resolveAnchor} from '#/horizon/private/thread/fetch'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {
  getCurrentClients,
  getCurrentDid,
} from '#/horizon/routing/current-clients'
import {THREAD_LENS} from '#/horizon/switches'
import {
  getLensThread,
  getLensWaitUntil,
  LENS_RESOLVE_BATCH,
  type LensFailure,
  lensFailureOf,
  lensSmallPages,
  lensThreadBody,
  resolveLens,
} from '#/horizon/thread-lens/api'
import {
  cachedHandleDid,
  rememberHandleDid,
} from '#/horizon/thread-lens/handle-cache'
import {
  type CheckedNode,
  checkLensNodes,
  EMPTY_BASE,
  isLensAtUri,
  type LensNode,
  lensTree,
  mergeLensNodes,
  type MergeRequest,
  postUrisToRead,
  type PublicOutcome,
} from '#/horizon/thread-lens/nodes'
import {takeWarmLensThread} from '#/horizon/thread-lens/prewarm'
import {
  readLensPrivatePart,
  startLensBranches,
} from '#/horizon/thread-lens/private-part'
import {
  bookmarkedInCache,
  formatPassStats,
  lensHydrationGate,
  lensHydrationOf,
  readPublicViews,
  warmPublicViews,
} from '#/horizon/thread-lens/public-views'
import {getLensGapKind, registerLensGaps} from '#/horizon/thread-lens/registry'
import {
  enqueueLensTask,
  fallbackOf,
  firstSnapshot,
  gapOnlySnapshot,
  heldSnapshotOf,
  type LensKeyParams,
  lensKeyParams,
  type LensNote,
  type LensQueryData,
  type LensSnapshot,
  type LensTaskOutcome,
  newRunId,
  snapshotOf,
  stopKey,
  withMerged,
} from '#/horizon/thread-lens/snapshot'
import {
  lensTimingNow,
  lensTimingOn,
  noteLensDetail,
  noteLensStep,
} from '#/horizon/thread-lens/timing'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** A lens answer the response had no anchor node for: a malformed body. */
export class LensMalformedError extends Error {
  constructor(message = 'The Thread Lens answer has no anchor node') {
    super(message)
    this.name = 'LensMalformedError'
  }
}

/** What `runLens` needs beside the key (7.1, TH-2). */
export type LensRunOptions = {
  qc: QueryClient
  /** With `mode: 'gap-only'`: why the lens is not active (11.3). */
  inactiveReason?: 'off' | 'not-served'
  /** The stock key, which a refusal's fallback is also written to (R2-N5). */
  stockKey: QueryKey
  /** The `sort` and rendered `below` a fallback reads with (TL-36). */
  readWith: {sort: string | undefined; below: number}
  /** The stock placeholder, whose `knownLikers` the anchor takes. */
  placeholder?: {value: unknown}
  /**
   * The stock placeholder search for another URI (`getThreadPlaceholder`),
   * given by the thread query so this module stays free of the stock caches.
   */
  findPlaceholder?: (uri: string) => unknown
  signal?: AbortSignal
}

/** `runLens`'s result: the lens answer, or the fallback's tag. */
export type LensRun = {
  data?: LensQueryData
  tag: <T>(result: T) => T
}

const PASS: LensRun = {tag: result => result}

/** The note a failure gives (11.3). */
function noteOf(data: unknown): LensNote | undefined {
  const snapshot = snapshotOf(data)
  if (snapshot) return snapshot.failure ?? snapshot.note
  const tag = fallbackOf(data)
  if (!tag || tag.fallback === 'refused') return undefined
  return {reason: tag.fallback, retryAt: tag.retryAt, autoRetry: tag.autoRetry}
}

/**
 * The note for `failure` over `previous` (11.3): one automatic retry for a
 * 429 or a `Reindexing`, `spent` when the entry's previous answer was itself
 * such an answer, except that a run made during the wait (no prism call)
 * carries a retry still due at the same time (v6: R4-N6).
 */
export function lensNoteFor(failure: LensFailure, previous: unknown): LensNote {
  const reason = failure.kind === 'rate-limited' ? '429' : 'unavailable'
  if (failure.kind !== 'rate-limited' && failure.kind !== 'reindexing') {
    return {reason, autoRetry: 'none'}
  }
  const held = noteOf(previous)
  let autoRetry: LensNote['autoRetry'] = 'pending'
  if (held?.retryAt !== undefined) {
    const carried =
      failure.kind === 'rate-limited' &&
      !failure.called &&
      held.autoRetry === 'pending' &&
      held.retryAt === failure.retryAt
    autoRetry = carried ? 'pending' : 'spent'
  }
  return {reason, retryAt: failure.retryAt, autoRetry}
}

/**
 * A failed call of `did` read for the screen. A 429's `retryAt` is the
 * account's wait as `api.ts` holds it (the later time kept, 11.5), so every
 * note and row of the account names the same end.
 */
function failureFor(did: string, error: unknown): LensFailure {
  const failure = lensFailureOf(error)
  if (failure.kind !== 'rate-limited') return failure
  return {...failure, retryAt: getLensWaitUntil(did) ?? failure.retryAt}
}

/** Whether `params`'s anchor is lens-only now (5.1, TL-25, TL-33). */
function isLensOnly(params: LensKeyParams): boolean {
  return (
    !isPrivatePostUri(params.anchor) &&
    (params.marked || getLensGapKind(params.did, params.anchor) !== undefined)
  )
}

/** The gap-only answer, or the unverified one (11.3, TL-33). */
function gapOnlyAnswer(
  params: LensKeyParams,
  runId: string,
  note: LensNote,
): LensQueryData {
  return {
    lens: gapOnlySnapshot({
      runId,
      anchorUri: params.anchor,
      gap: getLensGapKind(params.did, params.anchor),
      note,
    }),
  }
}

function viewsOf(outcomes: ReadonlyMap<string, PublicOutcome>) {
  const cids = new Map<string, string>()
  for (const outcome of outcomes.values()) {
    if (outcome.kind !== 'gap') cids.set(outcome.view.uri, outcome.view.cid)
  }
  return cids
}

/** Copy the stock placeholder's `knownLikers` onto the anchor (7.1). */
function copyKnownLikers(anchor: LensNode | undefined, placeholder: unknown) {
  if (anchor?.kind !== 'post') return
  const cached = (
    placeholder as
      | {value?: {post?: {viewer?: {knownLikers?: {actors?: unknown[]}}}}}
      | undefined
  )?.value?.post?.viewer?.knownLikers
  if (!cached?.actors?.length) return
  if (anchor.view.viewer?.knownLikers?.actors.length) return
  anchor.view.viewer = {
    ...anchor.view.viewer,
    knownLikers: cached as NonNullable<
      NonNullable<PostView['viewer']>['knownLikers']
    >,
  }
}

/** Private quotes in `views`, for the key's account only (5.5). */
async function resolveQuotes(did: string, views: readonly PostView[]) {
  if (views.length === 0 || getCurrentDid() !== did) return
  await resolvePrivateQuotes(views)
}

/** The stock placeholder's post view, when it is a full public one. */
function placeholderPost(placeholder: unknown): PostView | undefined {
  const post = (placeholder as {value?: {post?: PostView}} | undefined)?.value
    ?.post
  if (!post || typeof post.uri !== 'string' || !post.cid) return undefined
  return isPrivatePostUri(post.uri) ? undefined : post
}

function hostOf(uri: string): string | undefined {
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

/**
 * `anchor` with a DID authority without a request when the caches know it
 * (speed pass): the stock placeholder's own URI (the post the screen opened
 * from, whose URI the AppView gave in DID form), else the stock handle
 * cache (`resolved-did`), else `resolveHandle` on the public AppView.
 */
export function knownLensAnchor(
  qc: QueryClient,
  anchor: string,
  placeholder: unknown,
): string | undefined {
  let urip: AtUri
  try {
    urip = new AtUri(anchor)
  } catch {
    return undefined
  }
  if (urip.host.startsWith('did:')) return anchor
  const post = placeholderPost(placeholder)
  if (post) {
    try {
      const held = new AtUri(post.uri)
      if (
        held.host.startsWith('did:') &&
        held.collection === urip.collection &&
        held.rkey === urip.rkey
      ) {
        return post.uri
      }
    } catch {}
  }
  const did = qc.getQueryData<string>(['resolved-did', urip.host])
  if (typeof did === 'string' && did.startsWith('did:')) {
    return `at://${did}/${urip.collection}/${urip.rkey}`
  }
  return undefined
}

/**
 * The public URIs warmed at the start of a read, beside `getThread`
 * (speed pass): the anchor and its reply parent and root, each only when
 * the stock caches hold the AppView's own view of it (so the AppView has
 * served it as a post; U-5), and never for a lens-only anchor.
 */
function earlyPublicUris(
  params: LensKeyParams,
  anchorUri: string,
  options: LensRunOptions,
): string[] {
  if (isLensOnly(params)) return []
  const post = placeholderPost(options.placeholder)
  if (!post || post.uri !== anchorUri) return []
  const uris: string[] = [anchorUri]
  const reply = (
    post.record as {reply?: {parent?: {uri?: unknown}; root?: {uri?: unknown}}}
  ).reply
  for (const ref of [reply?.parent?.uri, reply?.root?.uri]) {
    if (typeof ref !== 'string' || isPrivatePostUri(ref)) continue
    if (uris.includes(ref) || !hostOf(ref)?.startsWith('did:')) continue
    if (getLensGapKind(params.did, ref) !== undefined) continue
    if (placeholderPost(options.findPlaceholder?.(ref))?.uri === ref) {
      uris.push(ref)
    }
  }
  return uris
}

/**
 * A handle's DID from the public AppView, without the account's session
 * (2026-10-26, Prism's cold-open finding: through the account's AppView
 * client a cold open waited 2.5 s on the PDS). Installed by
 * `TokenPrefetch.tsx`, which reaches the session module this one stays free
 * of; without it the account's AppView client resolves, as before.
 */
let publicHandleResolver: ((handle: string) => Promise<string>) | undefined

/** Install (or, with `undefined`, remove) the public handle resolver. */
export function installLensHandleResolver(
  next: ((handle: string) => Promise<string>) | undefined,
) {
  publicHandleResolver = next
}

/**
 * `anchor` with a DID authority, for an anchor the caches did not know: the
 * public AppView first, else the account's AppView client. The DID is
 * written to the stock handle cache (`resolved-did`), so the stock screen's
 * own lookup takes it.
 */
async function resolveLensAnchor(
  qc: QueryClient,
  appview: Client,
  anchor: string,
): Promise<{uri: string; from: string}> {
  const urip = new AtUri(anchor)
  if (urip.host.startsWith('did:')) return {uri: anchor, from: 'a DID'}
  const handle = urip.host
  const uriFor = (did: string) => `at://${did}/${urip.collection}/${urip.rkey}`
  const noteDid = (did: string) => {
    if (qc.getQueryData(['resolved-did', handle]) === undefined) {
      qc.setQueryData(['resolved-did', handle], did)
    }
  }
  // Known on this device: answer now, check again in the background.
  const cached = cachedHandleDid(handle)
  if (cached) {
    noteDid(cached)
    void publicHandleResolver?.(handle).then(
      fresh => {
        if (fresh.startsWith('did:')) rememberHandleDid(handle, fresh)
      },
      () => {},
    )
    return {uri: uriFor(cached), from: 'device cache'}
  }
  const did = publicHandleResolver
    ? await publicHandleResolver(handle).catch(() => undefined)
    : undefined
  if (did?.startsWith('did:')) {
    noteDid(did)
    rememberHandleDid(handle, did)
    return {uri: uriFor(did), from: 'public AppView'}
  }
  return {uri: await resolveAnchor(appview, anchor), from: "account's AppView"}
}

/** A first lens read: the lens, the public-view pass, the private part. */
async function readLens(
  params: LensKeyParams,
  runId: string,
  options: LensRunOptions,
): Promise<{
  snapshot: LensSnapshot
  gaps: readonly (readonly [string, string])[]
}> {
  const {did, depth} = params
  const clients = getCurrentClients()
  if (!clients || clients.did !== did) {
    throw new Error('Thread Lens: the key is not the current account')
  }
  const started = lensTimingNow()
  noteLensStep(params.anchor, 'read started', started)
  const known = knownLensAnchor(options.qc, params.anchor, options.placeholder)
  const resolved = known
    ? undefined
    : await resolveLensAnchor(options.qc, clients.appviewClient, params.anchor)
  const anchorUri = known ?? resolved!.uri
  noteLensStep(
    params.anchor,
    known ? 'anchor known' : `anchor resolved (${resolved!.from})`,
    started,
  )
  // The anchor's public views start now, beside `getThread` (speed pass).
  warmPublicViews(
    clients.appviewClient,
    did,
    earlyPublicUris(params, anchorUri, options),
  )
  /*
   * The private branch page starts now too (2026-10-26): used once the
   * answer shows the anchor, as asked, to be a post; else dropped.
   */
  const earlyBranches =
    getCurrentDid() === did ? startLensBranches(anchorUri, depth) : undefined
  const onBranchStep = lensTimingOn()
    ? (step: string) => noteLensStep(params.anchor, step, started)
    : undefined
  const body = lensThreadBody({kind: 'first', anchor: anchorUri, depth})
  // The press-in pre-warm's answer when one is in flight for this read.
  const warm = takeWarmLensThread(did, body)
  const ask = () => {
    noteLensStep(params.anchor, 'getThread sent', started)
    return getLensThread(clients.prismClient, did, body, options.signal)
  }
  const answer = warm ? await warm.catch(ask) : await ask()
  noteLensStep(
    params.anchor,
    warm ? 'getThread (pre-warmed)' : 'getThread',
    started,
  )
  const checked = checkLensNodes(answer.nodes)
  const anchorNode = checked.find(node => node.uri === answer.anchor)
  if (!anchorNode) {
    logger.error('thread lens: answer without its anchor node', {
      safeMessage: answer.anchor,
    })
    throw new LensMalformedError()
  }
  const lensLabels = answer.readerLabels === true
  const served = {servedAs: answer.servedAs, readerLabels: lensLabels}
  const hydration = lensHydrationOf(did, served, uri =>
    bookmarkedInCache(options.qc, uri),
  )
  if (lensTimingOn()) {
    const gate = lensHydrationGate(did, served)
    noteLensDetail(
      params.anchor,
      gate ? `member skip off: ${gate}` : 'member skip on',
    )
  }
  const publicPass = readPublicViews(
    clients.appviewClient,
    checked,
    postUrisToRead(EMPTY_BASE, checked),
    {
      did,
      lensLabels,
      hydration,
      onStats: lensTimingOn()
        ? stats => noteLensDetail(params.anchor, formatPassStats(stats))
        : undefined,
    },
  )
  /*
   * The private part (5.5): beside the public-view pass, only for a post
   * anchor and only while the key's account is current (v9: R7-N3).
   */
  let rootIsGap = false
  const privatePart =
    anchorNode.type === 'post' && getCurrentDid() === did
      ? readLensPrivatePart({
          anchor: answer.anchor,
          depth,
          publicViews: async () => {
            const outcomes = await publicPass.catch(() => undefined)
            const outcome = outcomes?.get(anchorNode.uri)
            if (!outcomes || !outcome || outcome.kind === 'gap')
              return undefined
            const rootUri = (
              outcome.view.record as {reply?: {root?: {uri?: unknown}}}
            ).reply?.root?.uri
            rootIsGap =
              typeof rootUri === 'string' &&
              (checked.some(n => n.uri === rootUri && n.type === 'gap') ||
                outcomes.get(rootUri)?.kind === 'gap')
            const cids = viewsOf(outcomes)
            return {cidOf: uri => cids.get(uri), anchorPost: outcome.view}
          },
          resyncMute: () => !rootIsGap && getCurrentDid() === did,
          page: answer.anchor === anchorUri ? earlyBranches : undefined,
          onStep: onBranchStep,
        }).catch((error: unknown) => {
          logger.warn('thread lens: private branches unavailable', {
            safeMessage: error,
          })
          return undefined
        })
      : Promise.resolve(undefined)
  const outcomes = await publicPass
  noteLensStep(params.anchor, 'public views', started)
  const merged = mergeLensNodes(EMPTY_BASE, checked, {
    request: {kind: 'first'},
    bridging: answer.bridging,
    outcomes,
  })
  const part = await privatePart
  noteLensStep(params.anchor, 'private branches', started)
  const nodes = new Map(merged.nodes)
  const newViews = [...merged.newViews]
  // Discarded when the public-view pass made the anchor a gap (R2-Q3).
  if (part && nodes.get(answer.anchor)?.kind === 'post') {
    for (const node of part.nodes) {
      nodes.set(node.uri, node)
      if (node.kind === 'private') newViews.push(node.view)
    }
  }
  const gaps = merged.gaps.filter(([uri]) => nodes.get(uri)?.kind === 'gap')
  await resolveQuotes(did, newViews)
  noteLensStep(params.anchor, 'private quotes', started)
  copyKnownLikers(nodes.get(answer.anchor), options.placeholder)
  const snapshot = firstSnapshot({
    runId,
    anchorUri: params.anchor,
    prismAnchor: answer.anchor,
    merged: {...merged, nodes},
    bridging: answer.bridging,
    privateCursor:
      part && nodes.get(answer.anchor)?.kind === 'post'
        ? part.privateCursor
        : undefined,
  })
  noteLensStep(params.anchor, 'snapshot built', started)
  return {snapshot, gaps}
}

/**
 * The lens half of the thread query function (TH-2, 7.1, 11.3). Under a
 * stock key, or with the switch off, it returns no data and a `tag` that
 * changes nothing.
 */
export async function runLens(
  queryKey: QueryKey,
  options: LensRunOptions,
): Promise<LensRun> {
  const params = THREAD_LENS ? lensKeyParams(queryKey) : undefined
  if (!params) return PASS
  const runId = newRunId()
  if (params.mode === 'gap-only') {
    const reason = options.inactiveReason ?? 'off'
    return {
      ...PASS,
      data: gapOnlyAnswer(params, runId, {reason, autoRetry: 'none'}),
    }
  }
  try {
    const {snapshot, gaps} = await readLens(params, runId, options)
    registerLensGaps(params.did, gaps)
    return {...PASS, data: {lens: {...snapshot, fetchedAt: fetchStamp()}}}
  } catch (error) {
    const failure = failureFor(params.did, error)
    if (failure.kind === 'unavailable' || failure.kind === 'invalid-request') {
      logger.warn('thread lens: read failed', {safeMessage: error})
    }
    // Read when the failure is caught, never when the run started (R4-N7).
    const previous = options.qc.getQueryData(queryKey)
    const held = heldSnapshotOf(previous)
    if (failure.kind !== 'refusal' && held) {
      return {
        ...PASS,
        data: {lens: {...held, failure: lensNoteFor(failure, previous)}},
      }
    }
    if (isLensOnly(params)) {
      const note: LensNote =
        failure.kind === 'refusal'
          ? {reason: 'not-served', autoRetry: 'none'}
          : lensNoteFor(failure, previous)
      return {...PASS, data: gapOnlyAnswer(params, runId, note)}
    }
    const note =
      failure.kind === 'refusal' ? undefined : lensNoteFor(failure, previous)
    return {
      tag: <T>(result: T): T => {
        if (failure.kind === 'refusal') {
          options.qc.setQueryData(options.stockKey, result)
        }
        return {
          ...result,
          lens: {
            fallback:
              failure.kind === 'refusal'
                ? 'refused'
                : (note?.reason ?? 'unavailable'),
            ...(note?.retryAt !== undefined ? {retryAt: note.retryAt} : {}),
            autoRetry: note?.autoRetry ?? 'none',
            readWith: options.readWith,
            runId,
          },
        }
      },
    }
  }
}

/*
 * Continuations and retry (9.2, 9.3). Each is a task on the entry's queue,
 * which runs one at a time and writes onto the current snapshot only if it
 * is still the run the task started on (9.1).
 */

/**
 * The public-view pass and the private quotes for a later response;
 * `lensLabels` when every response read carries the reader's labels, and
 * `servedAs` `member` when every one was served to a member.
 */
async function readLater(
  qc: QueryClient,
  did: string,
  snapshot: LensSnapshot,
  checked: readonly CheckedNode[],
  {lensLabels, servedAs}: {lensLabels: boolean; servedAs: string | undefined},
) {
  const clients = getCurrentClients()
  if (!clients || clients.did !== did) return undefined
  const outcomes = await readPublicViews(
    clients.appviewClient,
    checked,
    postUrisToRead(snapshot, checked),
    {
      lensLabels,
      hydration: lensHydrationOf(
        did,
        {servedAs, readerLabels: lensLabels},
        uri => bookmarkedInCache(qc, uri),
      ),
    },
  )
  const views: PostView[] = []
  for (const outcome of outcomes.values()) {
    if (outcome.kind !== 'gap') views.push(outcome.view)
  }
  await resolveQuotes(did, views)
  return outcomes
}

function errorOutcome(did: string, error: unknown): LensTaskOutcome {
  const failure = failureFor(did, error)
  logger.warn('thread lens: continuation failed', {safeMessage: error})
  return failure.kind === 'rate-limited'
    ? {kind: 'error', retryAt: failure.retryAt}
    : {kind: 'error'}
}

/** The task for one `getThread` continuation (9.2). */
function continuation(
  qc: QueryClient,
  params: LensKeyParams,
  uri: string,
  kind: 'replies' | 'parents',
  depth: number,
): (snapshot: LensSnapshot) => Promise<LensTaskOutcome> {
  return async snapshot => {
    const clients = getCurrentClients()
    if (!clients || clients.did !== params.did) return {kind: 'none'}
    const heldCursor = snapshot.markers.get(uri)?.moreReplies?.cursor
    const ask = (cursor: string | undefined) =>
      getLensThread(
        clients.prismClient,
        params.did,
        lensThreadBody(
          kind === 'replies'
            ? {kind, anchor: uri, depth, cursor}
            : {kind, anchor: uri},
        ),
      )
    let answer
    try {
      answer = await ask(heldCursor)
    } catch (error) {
      // A refused cursor: once more without it, then the row goes (9.2).
      const refused =
        kind === 'replies' &&
        heldCursor !== undefined &&
        lensFailureOf(error).kind === 'invalid-request'
      if (!refused) return errorOutcome(params.did, error)
      try {
        answer = await ask(undefined)
      } catch (again) {
        if (lensFailureOf(again).kind !== 'invalid-request') {
          return errorOutcome(params.did, again)
        }
        logger.error('thread lens: a continuation was refused twice', {
          safeMessage: again,
        })
        return {
          kind: 'write',
          apply: current => ({
            next: {
              ...current,
              stopped: new Set([...current.stopped, stopKey(kind, uri)]),
            },
            gaps: [],
          }),
        }
      }
    }
    const checked = checkLensNodes(answer.nodes)
    let outcomes: Map<string, PublicOutcome> | undefined
    try {
      outcomes = await readLater(qc, params.did, snapshot, checked, {
        lensLabels: answer.readerLabels === true,
        servedAs: answer.servedAs,
      })
    } catch (error) {
      return errorOutcome(params.did, error)
    }
    if (!outcomes) return {kind: 'none'}
    const request: MergeRequest =
      kind === 'replies'
        ? {kind, anchor: uri, subtree: !lensSmallPages()}
        : {kind, anchor: uri}
    const bridging = answer.bridging
    const read = outcomes
    return {
      kind: 'write',
      apply: current => {
        const merged = mergeLensNodes(current, checked, {
          request,
          bridging,
          outcomes: read,
        })
        // The stop rule (9.2): nothing new and the marker gone or unchanged.
        const after = merged.markers.get(uri)
        const stillAsks =
          kind === 'replies'
            ? after?.moreReplies !== undefined &&
              after.moreReplies.cursor !== heldCursor
            : after?.moreParents === true
        const stop =
          merged.added.size === 0 && !stillAsks ? stopKey(kind, uri) : undefined
        return {
          next: withMerged(current, merged, bridging, stop),
          gaps: merged.gaps,
        }
      },
    }
  }
}

function paramsOf(qc: QueryClient, queueId: string | undefined) {
  const query = queueId ? qc.getQueryCache().get(queueId) : undefined
  return query ? lensKeyParams(query.queryKey) : undefined
}

/**
 * "Load more replies" on the node `uri` at relative depth `depth` (9.2):
 * `getThread` with that node as anchor, `parentHeight: 0`, `depth`
 * `below - depth` (at least 1) and the marker's cursor. Returns whether
 * it was queued.
 */
export function loadMoreLensReplies(
  qc: QueryClient,
  queueId: string | undefined,
  {uri, depth, below}: {uri: string; depth: number; below: number},
): boolean {
  const params = paramsOf(qc, queueId)
  if (!params) return false
  return enqueueLensTask(qc, queueId, {
    uri,
    run: continuation(qc, params, uri, 'replies', Math.max(1, below - depth)),
  })
}

/**
 * "Load earlier posts" on the top node `uri` (9.2): `getThread` with that
 * node as anchor, `depth: 0`, `parentHeight` 80. Returns whether it was
 * queued.
 */
export function loadEarlierLensPosts(
  qc: QueryClient,
  queueId: string | undefined,
  {uri}: {uri: string},
): boolean {
  const params = paramsOf(qc, queueId)
  if (!params) return false
  return enqueueLensTask(qc, queueId, {
    uri,
    run: continuation(qc, params, uri, 'parents', 0),
  })
}

/** Whether a held gap is retried by "Retry" (8.1, 9.3). */
export function isRetryableLensGap(node: LensNode): boolean {
  if (node.kind !== 'gap' || !isLensAtUri(node.uri)) return false
  if (node.gap === 'block-state-unknown') return true
  if (node.gap === 'upstream-unavailable') return true
  return node.gap === 'blocked' && node.bridging !== 'full'
}

/**
 * "Retry" on the gap `uri` (9.3): every retryable gap of the snapshot to
 * `resolve`, 25 per call, one call at a time, merged by URI in order. A
 * resolved top post with a `parentUri` the map lacks asks upward. A retry
 * that answers the same kind for `uri` shows "Still unavailable".
 */
export function retryLensGaps(
  qc: QueryClient,
  queueId: string | undefined,
  {uri}: {uri: string},
): boolean {
  const params = paramsOf(qc, queueId)
  if (!params) return false
  return enqueueLensTask(qc, queueId, {
    uri,
    run: async snapshot => {
      const clients = getCurrentClients()
      if (!clients || clients.did !== params.did) return {kind: 'none'}
      const uris = Array.from(snapshot.nodes.values())
        .filter(isRetryableLensGap)
        .map(node => node.uri)
      if (uris.length === 0) return {kind: 'none'}
      const before = snapshot.nodes.get(uri)
      const batches: {
        checked: CheckedNode[]
        bridging: string
        readerLabels: boolean
        servedAs: string | undefined
      }[] = []
      try {
        for (let i = 0; i < uris.length; i += LENS_RESOLVE_BATCH) {
          const answer = await resolveLens(
            clients.prismClient,
            params.did,
            uris.slice(i, i + LENS_RESOLVE_BATCH),
          )
          batches.push({
            checked: checkLensNodes(answer.items),
            bridging: answer.bridging,
            readerLabels: answer.readerLabels === true,
            servedAs: answer.servedAs,
          })
        }
      } catch (error) {
        return errorOutcome(params.did, error)
      }
      const all = batches.flatMap(batch => batch.checked)
      let outcomes: Map<string, PublicOutcome> | undefined
      try {
        outcomes = await readLater(qc, params.did, snapshot, all, {
          lensLabels: batches.every(batch => batch.readerLabels),
          servedAs: batches.every(batch => batch.servedAs === 'member')
            ? 'member'
            : undefined,
        })
      } catch (error) {
        return errorOutcome(params.did, error)
      }
      if (!outcomes) return {kind: 'none'}
      const read = outcomes
      return {
        kind: 'write',
        apply: current => {
          const topBefore = lensTree(current.nodes, current.anchor.prismAnchor)
          const top = topBefore.chain[0] ?? topBefore.anchor
          let next = current
          const gaps = new Map<string, string>()
          for (const batch of batches) {
            const merged = mergeLensNodes(next, batch.checked, {
              request: {kind: 'resolve'},
              bridging: batch.bridging,
              outcomes: read,
            })
            for (const [gapUri, kind] of merged.gaps) gaps.set(gapUri, kind)
            next = withMerged(next, merged, batch.bridging)
          }
          // Going upward after resolve (P-5): the resolved top asks upward.
          const resolvedTop = top ? next.nodes.get(top.uri) : undefined
          if (
            top?.kind === 'gap' &&
            resolvedTop?.kind === 'post' &&
            resolvedTop.parentUri &&
            !next.nodes.has(resolvedTop.parentUri)
          ) {
            const markers = new Map(next.markers)
            markers.set(top.uri, {...markers.get(top.uri), moreParents: true})
            next = {...next, markers}
          }
          const after = next.nodes.get(uri)
          const same =
            before?.kind === 'gap' &&
            after?.kind === 'gap' &&
            after.gap === before.gap
          return {
            next,
            gaps: Array.from(gaps.entries()),
            row: same ? 'still-unavailable' : 'idle',
          }
        },
      }
    },
  })
}
