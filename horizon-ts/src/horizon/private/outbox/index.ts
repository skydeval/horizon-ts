/*
 * The outbox: optimistic private posting on posting route `encode` (2K
 * design 4.11, PA-28).
 *
 * At press, `pressEncodeCompose` captures the compose (synchronously, before
 * any await), checks it, picks the rkeys, reads the images into memory,
 * takes the entry's run lock and saves its recovery record. Nothing touches
 * the network. The composer then closes and the posts show at once, pending
 * in phase `sending`. The background job (one compose at a time per tab, in
 * press order) plans, uploads, encodes, writes the gates and then the posts,
 * from the capture alone.
 *
 * - **No automatic delete** on this route: a failure leaves what was written
 *   and the entry is "Not posted" or "Partly posted" in Unsent, where the
 *   member chooses Retry, Finish posting, Edit, Delete what was posted or
 *   Discard (8.4).
 * - **The live session only**: the job runs in the tab and session that
 *   pressed Post. Nothing resumes by itself; at the account's next use each
 *   record nobody is running is decided by `getRecord` (step 5).
 * - **Answered or not**: a PDS write with no HTTP answer (a timeout, a
 *   network error, an abort, an edge's 502 to 524, a body that is not XRPC)
 *   leaves the entry `undecided` until its settle time, 3 minutes from the
 *   write's start; only then may an absent read decide it.
 * - **One tab at a time** per entry, through its run lock; every action
 *   re-reads the record under it; other tabs' changes arrive by `storage`
 *   event.
 *
 * The record never holds encoded bytes or media bytes; media are held in
 * memory as Blobs for the life of the tab. Logs name ids, URIs, error names
 * and classes, never private text.
 */

import {TID} from '@atproto/common-web'
import {type Client, type UriString, XrpcResponseError} from '@atproto/lex'
import {AtUri, type DidString, toDatetimeString} from '@atproto/syntax'
import {RichText} from '@bsky/sdk/richtext'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'
import {nanoid} from 'nanoid/non-secure'

import {type PostOpts} from '#/lib/api/index'
import {isNetworkError} from '#/lib/strings/errors'
import {shortenLinks} from '#/lib/strings/rich-text-manip'
import {logger} from '#/logger'
import {type ComposerImage} from '#/state/gallery'
import {type ComposerOptsPostRef} from '#/state/shell/composer'
import {deleteMediaFromLocal} from '#/view/com/composer/drafts/state/storage'
import {
  type PostDraft,
  type ThreadDraft,
} from '#/view/com/composer/state/composer'
import {type PostPrivate} from '#/horizon/lexicons/kryphocron'
import {getComposeSpoilers} from '#/horizon/media-spoilers/compose-store'
import {
  type DraftPostSpoilers,
  draftPostSpoilers,
  jobSpoilerSnapshot,
} from '#/horizon/media-spoilers/drafts'
import {toPostView} from '#/horizon/private/adapt/post-view'
import {
  type AudienceEntry,
  audiencesQueryKey,
  pickStandingAudience,
  PrivateAudienceMissingError,
} from '#/horizon/private/api/audiences'
import {
  authorView,
  buildComposedPosts,
  checkEncodedRecord,
  confirmInBackground,
  confirmNow,
  encodeComposePosts,
  invalidateAuthorPrivateFeeds,
  pendingEmbedView,
  type Plan,
  planFirstPost,
  PrivateEncodeError,
  quoteViewFromCache,
  readRecordState,
  resolveComposePosts,
} from '#/horizon/private/api/compose'
import {
  gatesForNewPost,
  type GateWrite,
  PrivateGateWriteError,
  THREADGATE_COLLECTION,
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
} from '#/horizon/private/api/reply-block'
import {
  requestRecordCaughtUp,
  requestRecordQuietly,
} from '#/horizon/private/api/request-record'
import {isTransientPrismError} from '#/horizon/private/api/transient'
import {
  PrivatePostInvalidError,
  validatePrivateRecord,
} from '#/horizon/private/api/validate'
import {
  encodePostingWriter,
  locusRepoWriter,
  PrivateKryphocronHostError,
  PrivateRouteUnavailableError,
  repoWriterFor,
} from '#/horizon/private/api/writer'
import {
  type ComposeVisibility,
  getComposeReplyRef,
  getComposeVisibility,
} from '#/horizon/private/composer/state'
import {prewarmEncoder} from '#/horizon/private/encoder'
import {
  type HeldLock,
  heldLockNames,
  tryRunLock,
} from '#/horizon/private/outbox/locks'
import {
  listOutboxRecords,
  type OutboxRecord,
  type OutboxRecordPost,
  readOutboxRecord,
  recordUris,
  removeOutboxRecord,
  saveOutboxRecord,
  type StoredReplyRef,
} from '#/horizon/private/outbox/record'
import {
  markRunning,
  outboxRecordKey,
  outboxRecordPrefix,
  runLockName,
  unmarkRunning,
} from '#/horizon/private/outbox/running'
import {
  alreadyPostedToastText,
  deleteIncompleteToastText,
  handledElsewhereText,
  isParentFailure,
  notPostedToastText,
  type OutboxFailure,
  outboxFailureText,
  partlyPostedToastText,
} from '#/horizon/private/outbox/texts'
import {PRIVATE_LANGS_LABELS} from '#/horizon/private/server-support'
import {
  addPendingPost,
  dropPendingPosts,
  getPendingPost,
  PENDING_TTL_MS,
  pendingPhase,
  type PendingPost,
  setPendingBatch,
  updatePendingPost,
} from '#/horizon/private/store'
import {isPrivatePostUri, PP_COLLECTION} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {getDirectPrismClient} from '#/horizon/routing/prism-direct'
import {getWriteRoute, type WriteRoutes} from '#/horizon/routing/write-route'
import {
  listLocalKeys,
  readLocal,
  subscribeLocalPrefix,
  writeLocal,
} from '#/horizon/session/local-store'
import {type SpoilerWriteMode, spoilerWriteMode} from '#/horizon/spoilers/write'
import {app, com} from '#/lexicons'

export {type OutboxRecord} from '#/horizon/private/outbox/record'

/**
 * The per-call timeouts and the settle window (PA-28 step 2). Mutable for
 * tests only.
 */
export const OUTBOX_TIMING = {
  /** A record write or read. */
  callMs: 60_000,
  /** A blob upload (the whole resolve step of the compose). */
  uploadMs: 5 * 60_000,
  /** From the start of an unanswered write to its settle time. */
  settleMs: 3 * 60_000,
}

/**
 * From the start of a write with no answer to the time an absent read may
 * decide it: the 60 s timeout plus 2 minutes (PA-28 step 2).
 */
export const OUTBOX_SETTLE_MS = 3 * 60_000

/**
 * At press: an image could not be read into memory. Nothing was posted.
 */
export class PrivateMediaUnreadableError extends Error {
  constructor() {
    super(
      t`An image or video couldn’t be read. Remove it and add it again. Nothing was posted.`,
    )
    this.name = 'PrivateMediaUnreadableError'
  }
}

/**
 * At press: the recovery record could not be saved (quota, storage
 * blocked). Nothing was posted.
 */
export class PrivateOutboxNotSavedError extends Error {
  constructor() {
    super(
      t`Horizon couldn’t save this post on this device. Nothing was posted.`,
    )
    this.name = 'PrivateOutboxNotSavedError'
  }
}

/**
 * At the press of a composer opened by Edit: another tab is running the old
 * entry, or posted or discarded it. Nothing was posted.
 */
export class PrivateOutboxHandledError extends Error {
  constructor() {
    super(t`This post was handled in another tab. Nothing was posted.`)
    this.name = 'PrivateOutboxHandledError'
  }
}

/** A call that did not settle within its timeout: unanswered. */
class OutboxTimeoutError extends Error {
  constructor() {
    super('The call timed out')
    this.name = 'OutboxTimeoutError'
  }
}

/** A checked record write failed: an answered local failure. */
class OutboxLocalWriteError extends Error {
  constructor() {
    super('The outbox record could not be saved')
    this.name = 'OutboxLocalWriteError'
  }
}

/** A read the job needed failed: the entry waits, undecided. */
class OutboxReadError extends Error {
  constructor() {
    super('A read failed')
    this.name = 'OutboxReadError'
  }
}

/** The entry's account is no longer current: the job stops. */
class OutboxStoppedError extends Error {
  constructor() {
    super('The account is not current')
    this.name = 'OutboxStoppedError'
  }
}

/**
 * The statuses a proxy or an edge in front of the PDS answers with while the
 * PDS may still be running the write (PA-28 step 2, K10-N1).
 */
const EDGE_STATUSES = new Set([502, 503, 504, 522, 524])

/**
 * Whether a failed PDS write was answered (PA-28 step 2): an
 * `XrpcResponseError` whose status is not an edge's, read on the raw error.
 * A timeout, a network error, an abort, an `XrpcInvalidResponseError` and
 * its validation subclass are unanswered. PA-5's refusal is a 400, and a
 * failed checked record write made no PDS write: both answered.
 */
export function isAnsweredWrite(error: unknown): boolean {
  if (error instanceof PrivateKryphocronHostError) return true
  if (error instanceof OutboxLocalWriteError) return true
  if (error instanceof XrpcResponseError)
    return !EDGE_STATUSES.has(error.status)
  return false
}

/*
 * Notices: the outbox's toasts, shown by `OutboxHost` (this module imports
 * no UI, so the write path and its tests load no design system).
 */

/**
 * A toast the outbox asks for.
 */
export type OutboxNotice = {text: string; type: 'error' | 'warning' | 'info'}

const noticeListeners = new Set<(notice: OutboxNotice) => void>()

export function subscribeOutboxNotices(
  listener: (notice: OutboxNotice) => void,
) {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

function notice(text: string, type: OutboxNotice['type'] = 'error') {
  noticeListeners.forEach(listener => listener({text, type}))
}

/*
 * Change listeners: the pending posts' status and Unsent re-read the outbox
 * when it changes.
 */

const listeners = new Set<() => void>()
let version = 0

function changed() {
  version++
  listeners.forEach(listener => listener())
}

export function subscribeOutbox(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Bumped on every change of the outbox in this tab or a record in another.
 */
export function getOutboxVersion(): number {
  return version
}

/**
 * What the press captured (step 1.1): the live objects, media as Blobs.
 */
type Capture = {
  visibility: ComposeVisibility
  spoilers: DraftPostSpoilers[]
  spoilerMode: SpoilerWriteMode
  langs: string[] | undefined
  replyToUri: string | undefined
  replyTo: StoredReplyRef | undefined
  thread: ThreadDraft
  /** Each image's displayed form, by `ComposerImage.source.id`. */
  images: Map<string, Blob>
  /** The id staged by `stageOutboxEdit` for the composer that pressed. */
  stagedEditId: string | undefined
}

/**
 * One entry in this tab: its record as this tab last knows it, the capture
 * when this tab pressed it, and its run lock while this tab holds it.
 */
type Entry = {
  id: string
  did: string
  record: OutboxRecord
  capture?: Capture
  /** The outbox's object URLs for the pending posts' previews. */
  previewUrls: string[]
  lock?: HeldLock
  /** A job or an action of this tab is running on the entry. */
  busy: boolean
  settleTimer?: ReturnType<typeof setTimeout>
}

const entries = new Map<string, Entry>()

/**
 * The clients of the entry's account, read again before each network call
 * (step 7): the published current clients when they are that account's,
 * else `undefined` and the job stops.
 */
export type JobClients = {
  did: string
  pdsClient: Client
  prismClient: Client
  appviewClient: Client
  chatClient: Client
  queryClient: QueryClient
}

export function clientsFor(did: string): JobClients | undefined {
  const current = getCurrentClients()
  if (!current || current.did !== did) return undefined
  if (!current.queryClient || !current.chatClient) return undefined
  return {
    did,
    pdsClient: current.pdsClient,
    prismClient: current.prismClient,
    appviewClient: current.appviewClient,
    chatClient: current.chatClient,
    queryClient: current.queryClient,
  }
}

function requireClients(did: string): JobClients {
  const clients = clientsFor(did)
  if (!clients) throw new OutboxStoppedError()
  return clients
}

/**
 * Run `call` with a signal that aborts after `ms`, and settle after `ms`
 * whatever the call does, as unanswered.
 */
async function timed<T>(
  ms: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new OutboxTimeoutError())
    }, ms)
  })
  try {
    return await Promise.race([call(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A signal that aborts after `ms`.
 */
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

/*
 * The record, as this tab writes it.
 */

/**
 * Change the entry's record and save it. A `checked` write is one the rule
 * needs before a PDS write (step 1.6, `lastWriteAt`, `deleting`): its
 * failure is returned. Any other write is tried once more and then logged;
 * the in-memory record stays the truth in this tab.
 */
function persist(
  entry: Entry,
  change: Partial<OutboxRecord>,
  {checked = false}: {checked?: boolean} = {},
): boolean {
  entry.record = {...entry.record, ...change}
  let saved = saveOutboxRecord(entry.record)
  if (!saved && !checked) {
    saved = saveOutboxRecord(entry.record)
    if (!saved) logger.warn('outbox: record not saved', {id: entry.id})
  }
  changed()
  return saved
}

/**
 * The post the compose replies to, if any.
 */
function replyUriOf(record: OutboxRecord): string | undefined {
  return record.replyToUri ?? record.replyTo?.uri
}

/**
 * The record's uris, in order.
 */
function urisOf(entry: Entry): string[] {
  return recordUris(entry.record)
}

/*
 * Locks.
 */

function holdLock(entry: Entry, lock: HeldLock, {running = false} = {}) {
  entry.lock = lock
  if (running) {
    markRunning({id: entry.id, did: entry.did, rkeys: entry.record.rkeys})
  }
}

function releaseLock(entry: Entry) {
  entry.lock?.release()
  entry.lock = undefined
  entry.busy = false
  unmarkRunning(entry.id)
  changed()
}

/**
 * The entry for a record: this tab's, or a new record-only one.
 */
function entryFor(record: OutboxRecord): Entry {
  const held = entries.get(record.id)
  if (held) return held
  const entry: Entry = {
    id: record.id,
    did: record.did,
    record,
    previewUrls: [],
    busy: false,
  }
  entries.set(record.id, entry)
  return entry
}

/**
 * Take the entry's run lock and read its record again (K9-L2). `gone`:
 * another tab posted or discarded it; the entry leaves this tab. `changed`:
 * another tab changed it; this tab takes its fields. Only `held` goes on,
 * holding the lock.
 */
async function lockAndReread(
  did: string,
  id: string,
  seen?: Pick<OutboxRecord, 'state' | 'failure' | 'present' | 'deleting'>,
): Promise<
  | {kind: 'held'; entry: Entry; record: OutboxRecord}
  | {kind: 'busy' | 'gone' | 'changed'}
> {
  const known = entries.get(id)
  if (known?.lock || known?.busy) return {kind: 'busy'}
  const lock = await tryRunLock(runLockName(id))
  if (!lock) return {kind: 'busy'}
  const record = readOutboxRecord(did, id)
  if (!record) {
    lock.release()
    if (known) forgetEntry(known, {pending: true})
    return {kind: 'gone'}
  }
  const entry = entryFor(record)
  if (
    seen &&
    (seen.state !== record.state ||
      seen.failure !== record.failure ||
      seen.deleting !== record.deleting ||
      (seen.present ?? []).join() !== (record.present ?? []).join())
  ) {
    entry.record = record
    lock.release()
    syncPendingFromRecord(entry)
    changed()
    return {kind: 'changed'}
  }
  entry.record = record
  holdLock(entry, lock)
  entry.busy = true
  return {kind: 'held', entry, record}
}

/**
 * Drop an entry from this tab: its media, previews, timer and lock, and
 * with `pending` its pending posts.
 */
function forgetEntry(entry: Entry, {pending = false}: {pending?: boolean}) {
  if (entry.settleTimer) clearTimeout(entry.settleTimer)
  for (const url of entry.previewUrls) revokeUrl(url)
  entry.previewUrls = []
  entry.capture = undefined
  entry.lock?.release()
  entry.lock = undefined
  unmarkRunning(entry.id)
  entries.delete(entry.id)
  if (pending) dropPendingPosts(urisOf(entry))
  changed()
}

function makeUrl(blob: Blob): string | undefined {
  try {
    return URL.createObjectURL(blob)
  } catch {
    return undefined
  }
}

function revokeUrl(url: string) {
  try {
    URL.revokeObjectURL(url)
  } catch {
    // Nothing to free.
  }
}

/*
 * Step 1: the press.
 */

let stagedEdit: string | undefined
let composerEdit: string | undefined

/**
 * Stage an Unsent entry for Edit: the next composer to mount restores it
 * (`useOutboxEdit`, hook Comp 4).
 */
export function stageOutboxEdit(id: string) {
  stagedEdit = id
}

/**
 * The staged entry, taken by the composer that mounts next; it stays the
 * composer's until `clearComposerEdit` (its unmount).
 */
export function takeStagedOutboxEdit(): string | undefined {
  const id = stagedEdit
  stagedEdit = undefined
  composerEdit = id
  return id
}

export function clearComposerEdit() {
  composerEdit = undefined
}

function storedReplyRef(
  ref: ComposerOptsPostRef | undefined,
  replyToUri: string | undefined,
): StoredReplyRef | undefined {
  if (!ref || !replyToUri || ref.uri !== replyToUri) return undefined
  return {
    uri: ref.uri,
    cid: ref.cid,
    text: ref.text,
    author: ref.author,
    ...(ref.langs ? {langs: ref.langs} : {}),
    ...(ref.embed ? {embed: ref.embed} : {}),
  }
}

/**
 * Step 1.1, synchronous, before any await: everything the job needs, from
 * the composer's records and `opts`. The spoiler snapshot is turned at once
 * into the serial form, with `pendingVideoPosts` cleared (K9-N2).
 */
function captureCompose(opts: PostOpts): Capture {
  const snap = getComposeSpoilers()
  const cleared = {...snap, pendingVideoPosts: new Set<string>()}
  return {
    visibility: getComposeVisibility(),
    spoilers: opts.thread.posts.map(post => draftPostSpoilers(post, cleared)),
    spoilerMode: spoilerWriteMode(true),
    langs:
      PRIVATE_LANGS_LABELS && opts.langs?.length
        ? opts.langs.slice(0, 3)
        : undefined,
    replyToUri: opts.replyTo,
    replyTo: storedReplyRef(getComposeReplyRef(), opts.replyTo),
    thread: opts.thread,
    images: new Map(),
    stagedEditId: composerEdit,
  }
}

function postImages(post: PostDraft): ComposerImage[] {
  const media = post.embed.media
  return media?.type === 'images' || media?.type === 'gallery'
    ? media.images
    : []
}

/**
 * Step 1.3: the text checks of the plaintext validator that need no upload.
 */
function checkPlaintext(did: string, thread: ThreadDraft) {
  for (const post of thread.posts) {
    validatePrivateRecord({
      $type: PP_COLLECTION,
      text: post.richtext.text,
      createdAt: toDatetimeString(new Date()),
      audienceList: `at://${did}/tools.kryphocron.policy.audience/self`,
    })
  }
}

/**
 * Step 1.4: each image's displayed form read into a Blob (a read of
 * memory on web). A video is not read: its picker `File` is held by the
 * press-time video state, which must be `done`.
 */
async function readMedia(capture: Capture) {
  for (const post of capture.thread.posts) {
    const media = post.embed.media
    if (media?.type === 'video' && media.video.status !== 'done') {
      throw new Error('outbox: a video was not done at press')
    }
    for (const image of postImages(post)) {
      const shown = image.transformed ?? image.source
      try {
        const response = await fetch(shown.path)
        capture.images.set(image.source.id, await response.blob())
      } catch {
        throw new PrivateMediaUnreadableError()
      }
    }
  }
}

function recordPostOf(post: PostDraft, spoilers: DraftPostSpoilers) {
  const media = post.embed.media
  const refs: OutboxRecordPost['refs'] = {}
  if (post.embed.quote) refs.quote = post.embed.quote.uri
  if (post.embed.link) refs.link = post.embed.link.uri
  if (media?.type === 'gif') refs.gif = {gif: media.gif, alt: media.alt}
  const record: OutboxRecordPost = {
    text: post.richtext.text,
    labels: [...post.labels],
    refs,
    media: {images: postImages(post).length, video: media?.type === 'video'},
    spoilers,
  }
  if (post.richtext.facets?.length) {
    record.facets = JSON.parse(
      JSON.stringify(post.richtext.facets),
    ) as unknown[]
  }
  return record
}

function newRkeys(count: number): string[] {
  let tid: TID | undefined
  return Array.from({length: count}, () => {
    tid = TID.next(tid)
    return tid.toString()
  })
}

/**
 * Press Post on posting route `encode` (PA-28 step 1). Awaits only local
 * work: the Blob reads of the images, a Web Lock granted at once and one
 * `localStorage` write (and for an Edit, the old entry's lock and one
 * record read). Returns `{uris}` with the posts pending as `sending`.
 */
export async function pressEncodeCompose(
  queryClient: QueryClient,
  opts: PostOpts,
  routes: WriteRoutes,
): Promise<{uris: string[]}> {
  const capture = captureCompose(opts)
  const did = opts.pdsClient.assertDid
  // 1.2: a job never starts on `checking`.
  if (routes.postingRoute !== 'encode') throw new PrivateRouteUnavailableError()
  checkPlaintext(did, capture.thread)
  const rkeys = newRkeys(capture.thread.posts.length)
  await readMedia(capture)

  // 1.5: an Edit's old entry first, then this entry's fresh lock.
  let old: {record: OutboxRecord; lock: HeldLock} | undefined
  if (capture.stagedEditId) {
    const oldLock =
      entries.get(capture.stagedEditId)?.lock ||
      entries.get(capture.stagedEditId)?.busy
        ? undefined
        : await tryRunLock(runLockName(capture.stagedEditId))
    if (!oldLock) throw new PrivateOutboxHandledError()
    const oldRecord = readOutboxRecord(did, capture.stagedEditId)
    if (!oldRecord || oldRecord.state !== 'failed') {
      oldLock.release()
      throw new PrivateOutboxHandledError()
    }
    old = {record: oldRecord, lock: oldLock}
  }
  const id = nanoid()
  const lock = await tryRunLock(runLockName(id))
  if (!lock) {
    old?.lock.release()
    throw new PrivateOutboxNotSavedError()
  }

  // 1.6: the record, `queued`, before any PDS write.
  const visibility = capture.visibility
  const record: OutboxRecord = {
    v: 1,
    id,
    did,
    pressedAt: Date.now(),
    rkeys,
    state: 'queued',
    ...(capture.langs ? {langs: capture.langs} : {}),
    posts: capture.thread.posts.map((post, index) =>
      recordPostOf(post, capture.spoilers[index]),
    ),
    visibility: visibility.visibility,
    audience: visibility.audience,
    locked: visibility.locked,
    ...(capture.replyToUri ? {replyToUri: capture.replyToUri} : {}),
    ...(capture.replyTo ? {replyTo: capture.replyTo} : {}),
    gates: {
      threadgate: capture.thread.threadgate,
      postgate: capture.thread.postgate,
    },
    ...(old?.record.sourceDraft ? {sourceDraft: old.record.sourceDraft} : {}),
    ...(old ? {replaces: old.record.id} : {}),
  }
  if (!saveOutboxRecord(record)) {
    lock.release()
    old?.lock.release()
    throw new PrivateOutboxNotSavedError()
  }
  const entry: Entry = {
    id,
    did,
    record,
    capture,
    previewUrls: [],
    busy: true,
  }
  entries.set(id, entry)
  holdLock(entry, lock, {running: true})

  // 1.7: the rest of an Edit's replacement; the new record is the commit.
  if (old) {
    const oldEntry = entries.get(old.record.id)
    removeOutboxRecord(did, old.record.id)
    if (oldEntry) forgetEntry(oldEntry, {pending: true})
    else dropPendingPosts(recordUris(old.record))
    old.lock.release()
    void settleReplies(did, recordUris(old.record), 'gone')
  }

  // 1.8: the pending posts, then the job, not awaited.
  addSendingPosts(entry, queryClient)
  const uris = urisOf(entry)
  setPendingBatch(uris)
  invalidateAuthorPrivateFeeds(queryClient, did)
  enqueue(entry)
  changed()
  return {uris}
}

/*
 * The pending posts (step 3).
 */

function audienceUriKnown(
  queryClient: QueryClient | undefined,
  did: string,
  record: OutboxRecord,
): string | undefined {
  const audience = record.audience
  if (audience.kind === 'list') return audience.uri
  if (audience.kind === 'parent') return audience.uri
  const cached = queryClient?.getQueryData<AudienceEntry[]>(
    audiencesQueryKey(did),
  )
  return cached ? pickStandingAudience(cached, audience.mode)?.uri : undefined
}

function displayRecord(
  text: string,
  createdAt: string,
  audienceUri: string | undefined,
  reply:
    | {root: {uri: string; cid: string}; parent: {uri: string; cid: string}}
    | undefined,
): PostPrivate {
  return {
    $type: PP_COLLECTION,
    text,
    createdAt,
    ...(audienceUri ? {audienceList: audienceUri} : {}),
    ...(reply ? {reply} : {}),
  } as unknown as PostPrivate
}

function previewEmbed(
  entry: Entry,
  post: PostDraft,
): app.bsky.feed.defs.PostView['embed'] {
  const images = postImages(post)
  if (!entry.capture || images.length === 0) return undefined
  const views: app.bsky.embed.images.ViewImage[] = []
  for (const image of images) {
    const blob = entry.capture.images.get(image.source.id)
    const url = blob ? makeUrl(blob) : undefined
    if (!url) continue
    entry.previewUrls.push(url)
    const shown = image.transformed ?? image.source
    views.push({
      thumb: url as app.bsky.embed.images.ViewImage['thumb'],
      fullsize: url as app.bsky.embed.images.ViewImage['fullsize'],
      alt: image.alt,
      aspectRatio: {width: shown.width, height: shown.height},
    })
  }
  return views.length
    ? {$type: 'app.bsky.embed.images#view', images: views}
    : undefined
}

/**
 * One pending post of the compose, from the capture (with previews) or from
 * the record alone (text only).
 */
function pendingFor(
  entry: Entry,
  index: number,
  queryClient: QueryClient | undefined,
  phase: 'sending' | 'failed',
): PendingPost | undefined {
  const record = entry.record
  const uris = urisOf(entry)
  const uri = uris[index]
  const createdAt = toDatetimeString(new Date(record.pressedAt + index + 1))
  const audienceUri = audienceUriKnown(queryClient, entry.did, record)
  const parentUri = index > 0 ? uris[index - 1] : replyUriOf(record)
  const parentCid = index > 0 ? '' : (record.replyTo?.cid ?? '')
  const reply = parentUri
    ? {
        root: {uri: index > 0 ? uris[0] : parentUri, cid: ''},
        parent: {uri: parentUri, cid: parentCid},
      }
    : undefined
  const post = entry.capture?.thread.posts[index]
  const text = post?.richtext.text ?? record.posts[index]?.text ?? ''
  const plain = displayRecord(text, createdAt, audienceUri, reply)
  const author = queryClient
    ? authorView(queryClient, entry.did)
    : {
        did: entry.did as DidString,
        handle: (getCurrentClients()?.handle ??
          'handle.invalid') as app.bsky.actor.defs.ProfileViewBasic['handle'],
      }
  const postView = toPostView(
    {uri, cid: '', author, record: plain, indexedAt: createdAt, labels: []},
    {embed: post ? previewEmbed(entry, post) : undefined, isPending: true},
  )
  if (!postView) return undefined
  return {
    uri,
    cid: '',
    did: entry.did,
    record: plain,
    audienceUri,
    postView,
    feedItem: {post: postView},
    createdAt,
    expiresAt: Number.POSITIVE_INFINITY,
    phase,
    outboxId: entry.id,
  }
}

function addSendingPosts(entry: Entry, queryClient: QueryClient) {
  entry.record.rkeys.forEach((_rkey, index) => {
    const pending = pendingFor(entry, index, queryClient, 'sending')
    if (pending) addPendingPost(pending)
  })
}

/**
 * Set the phase of the compose's pending posts that are not `written`;
 * with `all`, of every one (a failure after post 1 was written sends it back
 * to `failed`, K11-N2).
 */
function setPendingPhase(
  entry: Entry,
  phase: 'sending' | 'failed',
  {all = false}: {all?: boolean} = {},
) {
  for (const uri of urisOf(entry)) {
    updatePendingPost(uri, pending =>
      pending.did !== entry.did || (!all && pendingPhase(pending) === 'written')
        ? pending
        : {...pending, phase, expiresAt: Number.POSITIVE_INFINITY},
    )
  }
}

/**
 * A written post's pending entry: its record as written, its CID, and
 * today's expiry (step 3).
 */
function markWritten(
  entry: Entry,
  uri: string,
  cid: string,
  plain: PostPrivate,
  audienceUri: string,
  queryClient: QueryClient,
  quoteUrl: string | undefined,
) {
  const postView = toPostView(
    {
      uri,
      cid,
      author: authorView(queryClient, entry.did),
      record: plain,
      indexedAt: plain.createdAt,
      labels: [],
    },
    {
      embed: pendingEmbedView(
        plain,
        entry.did,
        quoteViewFromCache(queryClient, quoteUrl),
      ),
      isPending: true,
    },
  )
  if (!postView) return
  const next: PendingPost = {
    uri,
    cid,
    did: entry.did,
    record: plain,
    audienceUri,
    postView,
    feedItem: {post: postView},
    createdAt: plain.createdAt,
    expiresAt: Date.now() + PENDING_TTL_MS,
    phase: 'written',
    outboxId: entry.id,
  }
  if (getPendingPost(uri, entry.did)) {
    updatePendingPost(uri, () => next)
  } else if (getCurrentClients()?.did === entry.did) {
    addPendingPost(next)
  }
}

/**
 * Make the compose's present posts `written` with the CIDs a read returned
 * (a "done" decision, K10-N2), in the tab that holds their pending posts.
 */
function markPresentWritten(
  entry: Entry,
  present: readonly {uri: string; cid: string}[],
) {
  for (const {uri, cid} of present) {
    updatePendingPost(uri, pending =>
      pending.did !== entry.did
        ? pending
        : {
            ...pending,
            cid,
            postView: {...pending.postView, cid},
            feedItem: {
              ...pending.feedItem,
              post: {...pending.postView, cid},
            },
            phase: 'written',
            expiresAt: Date.now() + PENDING_TTL_MS,
          },
    )
  }
}

/**
 * The pending posts of a record not running in this tab: `failed`, from the
 * record alone unless this tab holds the capture (step 3, next use).
 */
function syncPendingFromRecord(entry: Entry) {
  const record = entry.record
  if (record.state !== 'failed' && record.state !== 'undecided') return
  if (getCurrentClients()?.did !== entry.did) return
  const queryClient = getCurrentClients()?.queryClient
  urisOf(entry).forEach((uri, index) => {
    const pending = getPendingPost(uri, entry.did)
    if (pending) {
      if (pendingPhase(pending) !== 'failed') {
        updatePendingPost(uri, current => ({
          ...current,
          phase: 'failed',
          expiresAt: Number.POSITIVE_INFINITY,
        }))
      }
      return
    }
    const added = pendingFor(entry, index, queryClient, 'failed')
    if (added) addPendingPost(added)
  })
}

/*
 * Step 2: the background job.
 */

const queue: Entry[] = []
let pumping = false
let paused = false
const idleWaiters = new Set<() => void>()

function enqueue(entry: Entry) {
  queue.push(entry)
  void pump()
}

/**
 * Hold the queue (tests: a paused job, to look at the press alone), and
 * release it.
 */
export function setOutboxPaused(next: boolean) {
  paused = next
  if (!paused) void pump()
}

async function pump() {
  if (pumping || paused) return
  pumping = true
  try {
    while (queue.length > 0) {
      const entry = queue.shift()!
      try {
        await runCompose(entry)
      } catch (error) {
        logger.error('outbox: job failed unexpectedly', {
          id: entry.id,
          name: error instanceof Error ? error.name : typeof error,
        })
        if (entry.lock) {
          failEntry(entry, 'post', entry.record.present ?? [])
        }
      }
    }
  } finally {
    pumping = false
    idleWaiters.forEach(resolve => resolve())
    idleWaiters.clear()
  }
}

/**
 * Resolves once this tab's queue is empty (tests).
 */
export function whenOutboxIdle(): Promise<void> {
  if (!pumping && (queue.length === 0 || paused)) return Promise.resolve()
  return new Promise(resolve => idleWaiters.add(resolve))
}

/**
 * The job's own copies of the compose's posts (step 6): from the capture,
 * each image's path an object URL the outbox made from its held Blob, with
 * the same `source.id`; else rebuilt from the record (text, facets, labels,
 * quote, link, GIF; no media). The returned URLs are revoked once the
 * uploads end.
 */
function jobPosts(entry: Entry): {posts: PostDraft[]; urls: string[]} {
  const urls: string[] = []
  const capture = entry.capture
  if (capture) {
    const posts = capture.thread.posts.map(post => {
      const media = post.embed.media
      if (media?.type !== 'images' && media?.type !== 'gallery') return post
      const images = media.images.map(image => {
        const blob = capture.images.get(image.source.id)
        const url = blob ? makeUrl(blob) : undefined
        if (!url) return image
        urls.push(url)
        const shown = image.transformed ?? image.source
        return {
          alt: image.alt,
          source: {
            id: image.source.id,
            path: url,
            width: shown.width,
            height: shown.height,
            mime: shown.mime,
          },
        } satisfies ComposerImage
      })
      return {...post, embed: {...post.embed, media: {...media, images}}}
    })
    return {posts, urls}
  }
  return {posts: entry.record.posts.map(postFromRecord), urls}
}

/**
 * A composer post rebuilt from the record (a record-only Retry, Edit after a
 * reload).
 */
export function postFromRecord(
  post: OutboxRecordPost,
  index: number,
): PostDraft {
  const richtext = new RichText({
    text: post.text,
    ...(post.facets
      ? {facets: post.facets as NonNullable<RichText['facets']>}
      : {}),
  })
  return {
    id: `outbox-post-${index}`,
    richtext,
    shortenedGraphemeLength: shortenLinks(richtext).graphemeLength,
    labels: post.labels as PostDraft['labels'],
    embed: {
      quote: post.refs.quote
        ? {type: 'link', uri: post.refs.quote as UriString}
        : undefined,
      link: post.refs.link
        ? {type: 'link', uri: post.refs.link as UriString}
        : undefined,
      media: post.refs.gif
        ? {type: 'gif', gif: post.refs.gif.gif, alt: post.refs.gif.alt}
        : undefined,
    },
  }
}

function hasVideo(entry: Entry): boolean {
  return entry.record.posts.some(post => post.media.video)
}

/**
 * The failure id of an answered error (4.9), read on the error itself; for
 * a gate write, on the raw failure inside it.
 */
function failureOf(error: unknown, entry: Entry): OutboxFailure {
  if (error instanceof PrivateRouteUnavailableError) return 'route'
  if (error instanceof PrivateParentUnavailableError) {
    return 'parent-unavailable'
  }
  if (error instanceof PrivateParentBusyError) return 'parent-busy'
  // The reply block check: a block, or a check that could not be made.
  if (error instanceof PrivateReplyBlockedError) return 'reply-blocked'
  if (error instanceof PrivateReplyCheckError) return 'parent-busy'
  if (error instanceof PrivateReplyRefusedError) return 'reply-refused'
  if (error instanceof PrivateAudienceMissingError) return 'audience-missing'
  if (error instanceof PrivateEncodeError) return 'encoder'
  if (error instanceof PrivateKryphocronHostError) return 'kryphocron-host'
  if (error instanceof OutboxLocalWriteError) return 'not-saved'
  if (error instanceof PrivatePostInvalidError) return 'encoder'
  if (error instanceof PrivateGateWriteError) {
    const raw = error.failure
    if (raw instanceof XrpcResponseError && raw.status === 429) {
      return 'rate-limited'
    }
    if (isNetworkError(raw)) return 'network'
    return 'gates'
  }
  if (error instanceof XrpcResponseError) {
    if (error.error === 'BlobNotFound' && hasVideo(entry)) return 'video-blob'
    if (error.status === 429) return 'rate-limited'
    return 'post'
  }
  if (isNetworkError(error)) return 'network'
  return 'post'
}

/**
 * Where the job stands after a failure, and what it may still read.
 */
type JobOutcome =
  | {kind: 'stop'}
  | {kind: 'decide'}
  | {kind: 'failed'; failure: OutboxFailure}
  | {kind: 'undecided-settle'}
  | {kind: 'undecided'}

/**
 * The placement rule on pending phases (step 2): walk the reply chain
 * through the pending store of the entry's DID. `written` places; `sending`
 * waits; `failed` (or an undecided entry) fails the compose with the
 * parent's text.
 */
async function placementRule(entry: Entry): Promise<OutboxFailure | undefined> {
  for (let wait = 0; ; wait++) {
    let uri = replyUriOf(entry.record)
    let waiting = false
    const seen = new Set<string>()
    while (uri && !seen.has(uri)) {
      seen.add(uri)
      const pending = getPendingPost(uri, entry.did)
      if (!pending) break
      const phase = pendingPhase(pending)
      if (phase === 'sending') {
        waiting = true
        break
      }
      if (phase === 'failed') {
        const parent = pending.outboxId
          ? (entries.get(pending.outboxId)?.record ??
            readOutboxRecord(entry.did, pending.outboxId))
          : undefined
        if (parent?.state === 'undecided') return 'parent-undecided'
        if (parent?.present?.length) return 'parent-partly'
        return 'parent-not-posted'
      }
      const parentRef = (pending.record as {reply?: {parent?: {uri?: unknown}}})
        .reply?.parent?.uri
      uri = typeof parentRef === 'string' ? parentRef : undefined
    }
    if (!waiting) return undefined
    // Defensive: one compose at a time in press order, so this is rare.
    if (wait > 600) return 'parent-not-posted'
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}

/**
 * The compose's gate records at the rkeys of its posts (4.2 step 7).
 */
function composeGates(record: OutboxRecord): GateWrite[] {
  return gatesForNewPost({
    threadgate: record.gates.threadgate,
    postgate: record.gates.postgate,
    postUris: recordUris(record),
    isReply: !!replyUriOf(record),
  })
}

function sameGate(stored: unknown, wanted: GateWrite): boolean {
  if (typeof stored !== 'object' || stored === null) return false
  const value = stored as Record<string, unknown>
  const want = wanted.record as unknown as Record<string, unknown>
  const keys =
    wanted.collection === THREADGATE_COLLECTION
      ? ['allow', 'post']
      : ['embeddingRules', 'detachedEmbeddingUris', 'post']
  return keys.every(
    key =>
      JSON.stringify(value[key] ?? null) === JSON.stringify(want[key] ?? null),
  )
}

/**
 * Write one record with `lastWriteAt` and `lastWriteKind` recorded first,
 * checked (PA-28 persistence): a failed checked write makes no PDS write.
 */
async function checkedWrite<T>(
  entry: Entry,
  kind: 'create' | 'delete',
  write: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (
    !persist(
      entry,
      {lastWriteAt: Date.now(), lastWriteKind: kind},
      {checked: true},
    )
  ) {
    throw new OutboxLocalWriteError()
  }
  return timed(OUTBOX_TIMING.callMs, write)
}

/**
 * Retry and Finish posting's gate rule (K6-N10, K11-L1): a gate of a
 * present post is never written; a gate of an absent post is read first,
 * kept when equal, rewritten with `putRecord` and its CID as swap when it
 * differs, and created when absent.
 */
async function writeRetryGates(
  entry: Entry,
  clients: JobClients,
  presentRkeys: ReadonlySet<string>,
) {
  for (const gate of composeGates(entry.record)) {
    const governsPresent =
      gate.collection === THREADGATE_COLLECTION
        ? presentRkeys.size > 0
        : presentRkeys.has(gate.rkey)
    if (governsPresent) continue
    let stored: {cid?: string; value?: unknown} | 'absent'
    try {
      const res = await timed(OUTBOX_TIMING.callMs, signal =>
        clients.pdsClient.call(
          com.atproto.repo.getRecord,
          {
            repo: entry.did as DidString,
            collection: gate.collection,
            rkey: gate.rkey,
          },
          {signal},
        ),
      )
      stored = {cid: res.cid, value: res.value}
    } catch (error) {
      if (
        error instanceof XrpcResponseError &&
        error.error === 'RecordNotFound'
      ) {
        stored = 'absent'
      } else {
        throw new OutboxReadError()
      }
    }
    if (stored !== 'absent' && sameGate(stored.value, gate)) continue
    const swap = stored === 'absent' ? undefined : stored.cid
    try {
      await checkedWrite(entry, 'create', signal =>
        swap
          ? clients.pdsClient.call(
              com.atproto.repo.putRecord,
              {
                repo: entry.did as DidString,
                collection: gate.collection,
                rkey: gate.rkey,
                record: gate.record,
                swapRecord: swap,
              },
              {signal},
            )
          : clients.pdsClient.call(
              com.atproto.repo.createRecord,
              {
                repo: entry.did as DidString,
                collection: gate.collection,
                rkey: gate.rkey,
                record: gate.record,
              },
              {signal},
            ),
      )
    } catch (error) {
      if (error instanceof OutboxLocalWriteError) throw error
      throw new PrivateGateWriteError(error, [])
    }
    persist(entry, {lastWriteAt: undefined, lastWriteKind: undefined})
  }
}

/**
 * Read every post of the compose (step 5's reads; Retry's and Finish
 * posting's first reads).
 */
async function readPosts(
  entry: Entry,
  clients: JobClients,
): Promise<
  {state: 'present' | 'absent' | 'unknown'; cid?: string; value?: unknown}[]
> {
  const reads = []
  for (const rkey of entry.record.rkeys) {
    try {
      reads.push(
        await timed(OUTBOX_TIMING.callMs, signal =>
          readRecordState(clients.pdsClient, entry.did, rkey, {signal}),
        ),
      )
    } catch {
      reads.push({state: 'unknown' as const})
    }
  }
  return reads
}

/**
 * A reply to a private post whose planning failed, classified before any
 * remap (prism busy design 9, BR17-N3): a miss prism left out
 * (`PrivateParentBusyError`) or any transient failure (a 503, `Reindexing`,
 * a network error, a call timeout, a waiter's error) is `parent-busy`; an own
 * post the PDS says is gone, prism's or the walk's refusal, the reply block
 * check's two outcomes and a stop pass through. `undefined` for anything
 * else, which keeps each site's own path.
 */
function replyPlanningFailure(error: unknown): Error | undefined {
  if (error instanceof OutboxStoppedError) return error
  if (
    error instanceof PrivateReplyBlockedError ||
    error instanceof PrivateReplyCheckError
  ) {
    return error
  }
  if (
    error instanceof PrivateParentUnavailableError ||
    error instanceof PrivateReplyRefusedError ||
    error instanceof PrivateParentBusyError
  ) {
    return error
  }
  if (isTransientPrismError(error)) return new PrivateParentBusyError()
  return undefined
}

/**
 * The plan of a Finish posting (K11-L2, K12-L1): the root ref and, when
 * post 1 is its own anchor, the audience from post 1's stored record; a
 * reply to a private post still runs placement for its audience.
 */
async function finishPlan(
  entry: Entry,
  clients: JobClients,
  post1: {uri: string; cid: string; value: unknown},
  last: {uri: string; cid: string},
): Promise<Plan | 'changed'> {
  const value =
    typeof post1.value === 'object' && post1.value !== null
      ? (post1.value as {
          audienceList?: unknown
          reply?: {root?: {uri?: unknown; cid?: unknown}}
        })
      : {}
  const replyToUri = replyUriOf(entry.record)
  let root: {uri: string; cid: string}
  if (replyToUri) {
    const storedRoot = value.reply?.root
    if (
      typeof storedRoot?.uri !== 'string' ||
      typeof storedRoot.cid !== 'string'
    ) {
      return 'changed'
    }
    root = {uri: storedRoot.uri, cid: storedRoot.cid}
  } else {
    root = {uri: post1.uri, cid: post1.cid}
  }
  let audienceUri: string
  if (!replyToUri || !isPrivatePostUri(replyToUri)) {
    if (typeof value.audienceList !== 'string') return 'changed'
    audienceUri = value.audienceList
  } else {
    let placed: Plan
    try {
      placed = await timed(OUTBOX_TIMING.callMs, () =>
        planFirstPost(
          clients.queryClient,
          clients,
          {
            replyTo: replyToUri,
            appviewClient: clients.appviewClient,
            // Every post a Finish posting writes replies to the member's own.
            skipBlockCheck: true,
          },
          entry.record.audience,
          encodePostingWriter(clients.pdsClient, entry.did),
        ),
      )
    } catch (error) {
      // Anything not classed here keeps today's path (`failureOf`).
      throw replyPlanningFailure(error) ?? error
    }
    audienceUri = placed.audienceUri
  }
  return {
    audienceUri,
    procedure: undefined as unknown as Plan['procedure'],
    reply: {root, parent: last},
    parentView: undefined,
  }
}

/**
 * Run one compose: the first run after press, a Retry or a Finish posting
 * (`mode` from the record: any run but the first reads every post first).
 * Holds the entry's run lock throughout; never deletes anything.
 */
async function runCompose(entry: Entry) {
  const did = entry.did
  const firstRun = !entry.record.madeWrite && entry.record.present === undefined
  /** The compose's posts known written, in order, with their CIDs. */
  const present: {uri: string; cid: string}[] = []
  const uris = urisOf(entry)
  let lastCall: {kind: 'read' | 'write'; client: Client} | undefined
  let wrote = false
  let mediaUrls: string[] = []
  let lastCaughtUp: Promise<boolean> | undefined

  const outcome = await (async (): Promise<JobOutcome | 'done'> => {
    try {
      persist(entry, {state: 'sending'})
      const parentFailure = await placementRule(entry)
      if (parentFailure) return {kind: 'failed', failure: parentFailure}
      let clients = requireClients(did)

      // Retry and Finish posting read first: a present post is not written again.
      let presentValue: unknown
      if (!firstRun) {
        lastCall = {kind: 'read', client: clients.pdsClient}
        const reads = await readPosts(entry, clients)
        if (reads.some(read => read.state === 'unknown')) {
          return {kind: 'undecided'}
        }
        const firstAbsent = reads.findIndex(read => read.state === 'absent')
        const prefix = firstAbsent === -1 ? reads.length : firstAbsent
        if (reads.slice(prefix).some(read => read.state === 'present')) {
          // Not a prefix: Finish posting is withheld (PA-28 step 4).
          reads.forEach((read, index) => {
            if (read.state === 'present')
              present.push({uri: uris[index], cid: read.cid ?? ''})
          })
          return {kind: 'failed', failure: 'changed'}
        }
        for (let index = 0; index < prefix; index++) {
          present.push({uri: uris[index], cid: reads[index].cid ?? ''})
        }
        presentValue = reads[0]?.value
        if (present.length === uris.length) return 'done'
        // A late commit Retry finds present makes it a Finish posting.
        if (present.length === 0 && (entry.record.present?.length ?? 0) > 0) {
          // Every post deleted elsewhere: Not posted, nothing written.
          return {kind: 'failed', failure: 'post'}
        }
        markPresentWritten(entry, present)
      }

      // 4.2 step 1: the plan.
      clients = requireClients(did)
      const writer = encodePostingWriter(clients.pdsClient, did)
      const replyToUri = replyUriOf(entry.record)
      let plan: Plan
      lastCall = {kind: 'read', client: clients.pdsClient}
      if (present.length > 0) {
        const finished = await finishPlan(
          entry,
          clients,
          {...present[0], value: presentValue},
          present[present.length - 1],
        )
        if (finished === 'changed') return {kind: 'failed', failure: 'changed'}
        plan = finished
      } else {
        try {
          plan = await timed(OUTBOX_TIMING.callMs, () =>
            planFirstPost(
              clients.queryClient,
              clients,
              {replyTo: replyToUri, appviewClient: clients.appviewClient},
              entry.record.audience,
              writer,
            ),
          )
        } catch (error) {
          if (replyToUri && isPrivatePostUri(replyToUri)) {
            // Classified first (design 9); anything else keeps today's remap.
            throw (
              replyPlanningFailure(error) ?? new PrivateParentUnavailableError()
            )
          }
          // A reply to a public post: `failureOf` maps the block check's.
          throw error
        }
      }

      // 4.2 step 2: resolve and upload the posts still to write.
      const absent = uris
        .map((_uri, index) => index)
        .filter(index => index >= present.length)
      const {posts, urls} = jobPosts(entry)
      mediaUrls = urls
      const spoilers = jobSpoilerSnapshot(
        entry.capture?.spoilers ??
          entry.record.posts.map(post => post.spoilers),
        posts,
      )
      clients = requireClients(did)
      lastCall = {kind: 'read', client: clients.pdsClient}
      const toWrite = absent.map(index => posts[index])
      const resolved = await timed(OUTBOX_TIMING.uploadMs, () =>
        resolveComposePosts(
          clients.queryClient,
          clients,
          toWrite,
          spoilers,
          entry.capture?.spoilerMode ?? spoilerWriteMode(true),
        ),
      ).catch((error: unknown) => {
        throw error instanceof OutboxTimeoutError
          ? Object.assign(new Error('upload timed out'), {
              name: 'UploadTimeout',
            })
          : error
      })
      for (const url of mediaUrls) revokeUrl(url)
      mediaUrls = []

      // 4.2 steps 3 to 5: the rkeys were fixed at press; a fresh encode.
      const composed = buildComposedPosts({
        posts: toWrite,
        resolved,
        audienceUri: plan.audienceUri,
        langs: entry.record.langs,
        composeSpoilers: spoilers,
        now: new Date(entry.record.pressedAt + present.length),
      })
      const absentRkeys = absent.map(index => entry.record.rkeys[index])
      /*
       * The block check again, beside the encode, when uploads made the
       * plan's verdict stale (PR2-L1); a refusal wins over an encode failure.
       */
      const [encodedResult, recheck] = await Promise.allSettled([
        encodeComposePosts(did, absentRkeys, composed, plan.reply),
        recheckReplyBlock(clients, plan.blockCheck),
      ])
      if (recheck.status === 'rejected') throw recheck.reason
      if (encodedResult.status === 'rejected') throw encodedResult.reason
      const encoded = encodedResult.value
      const lastCheck = recheck.value

      // 4.2 step 7: the gates, before any post; nothing is deleted on failure.
      clients = requireClients(did)
      lastCall = {kind: 'write', client: clients.pdsClient}
      if (firstRun) {
        const writes = composeGates(entry.record)
        if (writes.length > 0) {
          await writeGatesForNewPost(clients.pdsClient, did, writes, {
            deleteOnFailure: false,
            beforeWrite: () => {
              wrote = true
              if (
                !persist(
                  entry,
                  {lastWriteAt: Date.now(), lastWriteKind: 'create'},
                  {checked: true},
                )
              ) {
                throw new OutboxLocalWriteError()
              }
            },
            signal: () => timeoutSignal(OUTBOX_TIMING.callMs),
          })
          persist(entry, {lastWriteAt: undefined, lastWriteKind: undefined})
        }
      } else {
        wrote = true
        await writeRetryGates(
          entry,
          clients,
          new Set(present.map(post => new AtUri(post.uri).rkey)),
        )
      }

      /*
       * The block check once more before the first post write (RB-13), when
       * the encode and the gate writes made the last verdict older than
       * `prePostFreshMs`. A refusal here is classified at the top of the
       * `catch`, never as a write in doubt: the gate writes were answered.
       */
      clients = requireClients(did)
      await recheckReplyBlock(clients, lastCheck, {
        freshMs: REPLY_BLOCK_TIMING.prePostFreshMs,
      })

      // 4.2 step 8: each post, in order, with the previous post's CID.
      let reply = plan.reply
      for (const [k, index] of absent.entries()) {
        clients = requireClients(did)
        const rkey = entry.record.rkeys[index]
        const uri = uris[index]
        const withReply = reply ? {reply} : {}
        const plain = validatePrivateRecord({...encoded[k].plain, ...withReply})
        const record = checkEncodedRecord({...encoded[k].record, ...withReply})
        lastCall = {kind: 'write', client: clients.pdsClient}
        wrote = true
        let cid: string
        try {
          const res = await checkedWrite(entry, 'create', signal =>
            writer.createPost({
              procedure: plan.procedure,
              rkey,
              record,
              signal,
            }),
          )
          cid = res.cid ?? ''
        } catch (error) {
          if (
            !isAnsweredWrite(error) ||
            error instanceof OutboxLocalWriteError
          ) {
            throw error
          }
          if (getCurrentClients()?.did !== did) throw error
          // An answered error can follow a commit: read before deciding.
          lastCall = {kind: 'read', client: clients.pdsClient}
          const after = await timed(OUTBOX_TIMING.callMs, signal =>
            readRecordState(clients.pdsClient, did, rkey, {signal}),
          ).catch(() => ({state: 'unknown' as const, cid: undefined}))
          if (after.state === 'unknown') return {kind: 'undecided'}
          if (after.state === 'present') {
            present.push({uri, cid: after.cid ?? ''})
            if (present.length === uris.length) return 'done'
          }
          return {kind: 'failed', failure: failureOf(error, entry)}
        }
        present.push({uri, cid})
        // Answered: no write is in doubt any more.
        persist(entry, {
          present: present.map(post => post.uri),
          lastWriteAt: undefined,
          lastWriteKind: undefined,
        })
        const prism = clients.prismClient
        if (index === uris.length - 1) {
          lastCaughtUp = requestRecordCaughtUp(prism, uri)
        } else {
          requestRecordQuietly(prism, uri)
        }
        markWritten(
          entry,
          uri,
          cid,
          plain,
          plan.audienceUri,
          clients.queryClient,
          posts[index]?.embed.quote?.uri,
        )
        reply = {root: reply?.root ?? {uri, cid}, parent: {uri, cid}}
      }
      return 'done'
    } catch (error) {
      for (const url of mediaUrls) revokeUrl(url)
      mediaUrls = []
      const current = getCurrentClients()
      if (error instanceof OutboxStoppedError || current?.did !== did) {
        return {kind: 'stop'}
      }
      // The block check's refusals are never write outcomes (PR4-L4).
      if (
        error instanceof PrivateReplyBlockedError ||
        error instanceof PrivateReplyCheckError
      ) {
        return {kind: 'failed', failure: failureOf(error, entry)}
      }
      if (error instanceof OutboxReadError) return {kind: 'undecided'}
      if (lastCall && current.pdsClient !== lastCall.client) {
        // Bundle replaced, same account (step 7): ambiguous.
        return lastCall.kind === 'write' &&
          !isAnsweredWrite(
            error instanceof PrivateGateWriteError ? error.failure : error,
          )
          ? {kind: 'undecided-settle'}
          : {kind: 'decide'}
      }
      const raw = error instanceof PrivateGateWriteError ? error.failure : error
      if (lastCall?.kind === 'write' && !isAnsweredWrite(raw)) {
        return {kind: 'undecided-settle'}
      }
      return {kind: 'failed', failure: failureOf(error, entry)}
    }
  })()

  if (wrote && outcome !== 'done') {
    entry.record = {...entry.record, madeWrite: true}
  }
  if (outcome === 'done') {
    succeedEntry(entry, present, lastCaughtUp)
    return
  }
  switch (outcome.kind) {
    case 'stop':
      stopEntry(entry)
      return
    case 'decide':
      // Still holding the run lock (step 7).
      await decideHeld(entry)
      return
    case 'undecided-settle':
      undecideEntry(entry, present, {settle: true})
      return
    case 'undecided':
      undecideEntry(entry, present, {settle: false})
      return
    case 'failed':
      failEntry(
        entry,
        outcome.failure,
        present.map(post => post.uri),
      )
      return
  }
}

/**
 * The confirmation reads of a written compose (4.2 step 9), through prism
 * directly (PA-7); only this tab's pending posts are read. The token is
 * minted here when the prefetch has none (PA-29): after the last write.
 */
function confirmCompose(
  entry: Entry,
  lastCaughtUp: Promise<boolean> | undefined,
) {
  const clients = clientsFor(entry.did)
  if (!clients) return
  const uris = urisOf(entry).filter(uri => !!getPendingPost(uri, entry.did))
  if (uris.length === 0) return
  setPendingBatch(urisOf(entry))
  const confirmer = getDirectPrismClient(clients.pdsClient)
  confirmInBackground(confirmer, uris)
  void lastCaughtUp?.then(caughtUp => {
    if (caughtUp) confirmNow(confirmer, uris)
  })
  invalidateAuthorPrivateFeeds(clients.queryClient, entry.did)
}

/**
 * The compose is posted (its own run, a Retry, a Finish posting, or a
 * "done" decision): the record leaves (an Edit's old one first), the source
 * draft is deleted, a reply waiting on it gets its Retry.
 */
function succeedEntry(
  entry: Entry,
  present: readonly {uri: string; cid: string}[],
  lastCaughtUp?: Promise<boolean>,
) {
  markPresentWritten(entry, present)
  confirmCompose(entry, lastCaughtUp)
  const record = entry.record
  if (record.replaces) removeOutboxRecord(entry.did, record.replaces)
  if (!removeOutboxRecord(entry.did, entry.id)) {
    removeOutboxRecord(entry.did, entry.id)
  }
  const uris = urisOf(entry)
  forgetEntry(entry, {pending: false})
  if (record.sourceDraft) void deleteSourceDraft(entry.did, record.sourceDraft)
  void settleReplies(entry.did, uris, 'posted')
}

/**
 * The job stopped (account switch, sign-out): no write, no rollback, no
 * toast; the record stays `queued` or `sending` and the capture stays held.
 * Step 5 decides it at the account's next use.
 */
function stopEntry(entry: Entry) {
  releaseLock(entry)
}

/**
 * An answered failure (step 4): `failed`, nothing deleted, every pending post
 * `failed`, and the toast. Every post present is "done" instead (K12-N1).
 */
function failEntry(entry: Entry, failure: OutboxFailure, present: string[]) {
  if (present.length === entry.record.rkeys.length && failure !== 'changed') {
    succeedEntry(
      entry,
      present.map(uri => ({
        uri,
        cid: getPendingPost(uri, entry.did)?.cid ?? '',
      })),
    )
    return
  }
  persist(entry, {
    state: 'failed',
    failure,
    present,
    lastWriteAt: undefined,
    lastWriteKind: undefined,
    settleAfter: undefined,
  })
  setPendingPhase(entry, 'failed', {all: true})
  releaseLock(entry)
  notice(present.length ? partlyPostedToastText() : notPostedToastText())
}

/**
 * Not decided yet: after an unanswered write (`settle`, with its settle
 * time and a timer), or after an answered failure whose read failed (no
 * settle time: the write was answered, K11-L3).
 */
function undecideEntry(
  entry: Entry,
  present: readonly {uri: string}[],
  {settle}: {settle: boolean},
) {
  const lastWriteAt = entry.record.lastWriteAt
  if (settle) {
    persist(entry, {
      state: 'undecided',
      present: present.map(post => post.uri),
      settleAfter: (lastWriteAt ?? Date.now()) + OUTBOX_TIMING.settleMs,
    })
  } else {
    persist(entry, {
      state: 'undecided',
      present: present.map(post => post.uri),
      lastWriteAt: undefined,
      lastWriteKind: undefined,
      settleAfter: undefined,
    })
  }
  setPendingPhase(entry, 'failed', {all: true})
  releaseLock(entry)
  if (settle) scheduleSettle(entry)
}

function settleTimeOf(record: OutboxRecord): number | undefined {
  if (record.settleAfter !== undefined) return record.settleAfter
  if (record.lastWriteAt !== undefined) {
    return record.lastWriteAt + OUTBOX_TIMING.settleMs
  }
  return undefined
}

/**
 * A timer for the entry's settle time: step 5 runs for it in this tab, if
 * its account is current then (K10-N4).
 */
function scheduleSettle(entry: Entry) {
  const at = settleTimeOf(entry.record)
  if (at === undefined) return
  if (entry.settleTimer) clearTimeout(entry.settleTimer)
  entry.settleTimer = setTimeout(
    () => {
      entry.settleTimer = undefined
      if (getCurrentClients()?.did !== entry.did) return
      void decideEntry(entry.did, entry.id)
    },
    Math.max(0, at - Date.now()),
  )
}

/**
 * The replies waiting on a parent that left the outbox (step 2's rule): by a
 * successful post, their `failure` is cleared and Retry is offered; by Edit,
 * Discard or Remove from this device they become `parent-gone`.
 */
async function settleReplies(
  did: string,
  parentUris: readonly string[],
  how: 'posted' | 'gone',
) {
  const parents = new Set(parentUris)
  for (const record of listOutboxRecords(did)) {
    if (record.state !== 'failed' || !isParentFailure(record.failure)) continue
    const replyToUri = replyUriOf(record)
    if (!replyToUri || !parents.has(replyToUri)) continue
    if (how === 'posted' && record.failure === 'parent-gone') continue
    const held = await lockAndReread(did, record.id)
    if (held.kind !== 'held') continue
    persist(held.entry, {
      failure: how === 'posted' ? undefined : 'parent-gone',
    })
    releaseLock(held.entry)
  }
}

/*
 * Step 6: the source draft.
 */

/**
 * Hook Comp 3: the composer hands over the draft a compose was loaded from,
 * in place of the stock cleanup at press. `true` when `postUri` is an outbox
 * entry's; the draft is deleted on that entry's success, kept on Discard.
 */
export function attachSourceDraft(
  postUri: string,
  draft: {draftId: string; originalLocalRefs: Set<string>},
): boolean {
  for (const entry of entries.values()) {
    if (!urisOf(entry).includes(postUri)) continue
    persist(entry, {
      sourceDraft: {
        draftId: draft.draftId,
        localRefs: Array.from(draft.originalLocalRefs),
      },
    })
    return true
  }
  return false
}

function draftsKey(did: string) {
  return `horizon-outbox-drafts:${did}`
}

function pendingDraftDeletes(
  did: string,
): {draftId: string; localRefs: string[]}[] {
  const raw = readLocal(draftsKey(did))
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as {draftId: string; localRefs: string[]}[]).filter(
          item =>
            typeof item?.draftId === 'string' && Array.isArray(item.localRefs),
        )
      : []
  } catch {
    return []
  }
}

/**
 * Delete a posted compose's source draft as the stock cleanup does; a
 * failure is kept and tried again at each next use (K8-N10).
 */
async function deleteSourceDraft(
  did: string,
  draft: {draftId: string; localRefs: string[]},
) {
  const clients = clientsFor(did)
  const keep = () => {
    const others = pendingDraftDeletes(did).filter(
      item => item.draftId !== draft.draftId,
    )
    writeLocal(draftsKey(did), JSON.stringify([...others, draft]))
  }
  if (!clients) {
    keep()
    return
  }
  try {
    await clients.appviewClient.call(app.bsky.draft.deleteDraft, {
      id: draft.draftId,
    })
  } catch (error) {
    logger.warn('outbox: source draft not deleted', {
      name: error instanceof Error ? error.name : typeof error,
    })
    keep()
    return
  }
  for (const ref of draft.localRefs) {
    try {
      await deleteMediaFromLocal(ref)
    } catch {
      // A missing local file needs no delete.
    }
  }
  // The stock drafts list's query key (`drafts/state/queries.ts`).
  void clients.queryClient.invalidateQueries({queryKey: ['drafts']})
  const others = pendingDraftDeletes(did).filter(
    item => item.draftId !== draft.draftId,
  )
  writeLocal(draftsKey(did), others.length ? JSON.stringify(others) : undefined)
}

/*
 * Step 5: the decision at the account's next use.
 */

const deciding = new Set<string>()

/**
 * Decide one record by `getRecord` (step 5), holding its run lock: `queued`,
 * `sending` and `undecided` records only; `failed` ones are in Unsent
 * already. Nothing is deleted.
 */
export async function decideEntry(did: string, id: string): Promise<void> {
  if (deciding.has(id)) return
  deciding.add(id)
  try {
    const held = await lockAndReread(did, id)
    if (held.kind !== 'held') return
    const {entry, record} = held
    if (record.state === 'failed') {
      releaseLock(entry)
      syncPendingFromRecord(entry)
      return
    }
    await decideHeld(entry)
  } finally {
    deciding.delete(id)
  }
}

async function decideHeld(entry: Entry) {
  const record = entry.record
  const clients = clientsFor(entry.did)
  if (!clients) {
    releaseLock(entry)
    return
  }
  const reads = await readPosts(entry, clients)
  const uris = urisOf(entry)
  const settleAt = settleTimeOf(record)
  const before = settleAt !== undefined && Date.now() < settleAt
  const keepUndecided = () => {
    persist(entry, {state: 'undecided'})
    setPendingPhase(entry, 'failed', {all: true})
    syncPendingFromRecord(entry)
    releaseLock(entry)
    if (before) scheduleSettle(entry)
  }
  if (reads.some(read => read.state === 'unknown')) {
    keepUndecided()
    return
  }
  const present = reads
    .map((read, index) =>
      read.state === 'present'
        ? {uri: uris[index], cid: read.cid ?? ''}
        : undefined,
    )
    .filter((post): post is {uri: string; cid: string} => !!post)
  const allPresent = present.length === uris.length
  if (record.deleting) {
    if (before) {
      persist(entry, {present: present.map(post => post.uri)})
      keepUndecided()
      return
    }
    if (record.deleting === 'discard') {
      persist(entry, {
        state: 'failed',
        failure: 'delete-discard',
        present: present.map(post => post.uri),
        settleAfter: undefined,
        lastWriteAt: undefined,
        lastWriteKind: undefined,
      })
    } else if (present.length > 0) {
      persist(entry, {
        state: 'failed',
        failure: 'delete-posted',
        present: present.map(post => post.uri),
        settleAfter: undefined,
        lastWriteAt: undefined,
        lastWriteKind: undefined,
      })
    } else {
      persist(entry, {
        state: 'failed',
        failure: undefined,
        present: [],
        deleting: undefined,
        settleAfter: undefined,
        lastWriteAt: undefined,
        lastWriteKind: undefined,
      })
    }
    setPendingPhase(entry, 'failed', {all: true})
    syncPendingFromRecord(entry)
    releaseLock(entry)
    return
  }
  if (allPresent && (!before || record.lastWriteKind === 'create')) {
    for (const {uri} of present) requestRecordQuietly(clients.prismClient, uri)
    succeedEntry(entry, present)
    return
  }
  if (before) {
    persist(entry, {present: present.map(post => post.uri)})
    keepUndecided()
    return
  }
  const prefix = present.every((post, index) => post.uri === uris[index])
  persist(entry, {
    state: 'failed',
    failure: prefix ? entry.record.failure : 'changed',
    present: present.map(post => post.uri),
    settleAfter: undefined,
    lastWriteAt: undefined,
    lastWriteKind: undefined,
  })
  setPendingPhase(entry, 'failed', {all: true})
  syncPendingFromRecord(entry)
  releaseLock(entry)
  notice(present.length ? partlyPostedToastText() : notPostedToastText())
}

const watchedDids = new Map<string, () => void>()

/**
 * Follow other tabs' changes to `did`'s records (K9-L2): a removed record
 * drops this tab's entry and its pending posts (no toast); a changed one
 * refreshes it; a new one is listed by Unsent.
 */
export function watchOutboxRecords(did: string) {
  if (watchedDids.has(did)) return
  const prefix = outboxRecordPrefix(did)
  watchedDids.set(
    did,
    subscribeLocalPrefix(prefix, key => {
      if (key === prefix) {
        changed()
        return
      }
      const id = key.slice(prefix.length)
      const entry = entries.get(id)
      if (!entry || entry.lock || entry.busy) {
        changed()
        return
      }
      const record = readOutboxRecord(did, id)
      if (!record) {
        forgetEntry(entry, {pending: true})
        return
      }
      entry.record = record
      syncPendingFromRecord(entry)
      changed()
    }),
  )
}

/**
 * The account's next use (step 5, "When"): it became current, came back to
 * the foreground, or Unsent opened. Decides every record nobody runs, puts
 * the failed ones' pending posts back, and retries kept draft deletes.
 */
export async function outboxNextUse(did: string): Promise<void> {
  if (getCurrentClients()?.did !== did) return
  watchOutboxRecords(did)
  for (const draft of pendingDraftDeletes(did)) {
    await deleteSourceDraft(did, draft)
  }
  for (const record of listOutboxRecords(did)) {
    const entry = entries.get(record.id)
    if (entry?.lock || entry?.busy) continue
    if (record.state === 'failed') {
      syncPendingFromRecord(entryFor(record))
      continue
    }
    await decideEntry(did, record.id)
  }
  changed()
}

/*
 * The account's removal from the device (step 7, K8-N3).
 */

/**
 * Forget every outbox record of an account no longer on the device, each
 * under its run lock (a held one is left for the next run), with its draft
 * tables. Posts already written stay on the PDS.
 */
export async function forgetRemovedAccount(did: string) {
  for (const entry of Array.from(entries.values())) {
    if (entry.did !== did || entry.lock || entry.busy) continue
    forgetEntry(entry, {pending: true})
  }
  let left = false
  const prefix = outboxRecordPrefix(did)
  // Every key, parsed or not, so a malformed record goes too.
  for (const key of listLocalKeys(prefix)) {
    const id = key.slice(prefix.length)
    const lock = await tryRunLock(runLockName(id))
    if (!lock) {
      left = true
      continue
    }
    removeOutboxRecord(did, id)
    lock.release()
  }
  if (!left) {
    writeLocal(draftsKey(did), undefined)
    writeLocal(`horizon:draft-visibility:${did}`, undefined)
    writeLocal(`horizon:draft-spoilers:${did}`, undefined)
  }
  changed()
}

/*
 * The member's actions (8.4). Each takes the run lock with `ifAvailable`
 * and re-reads the record first; `seen` is what the member was shown.
 */

/**
 * What a button was pressed on: the record's id and the fields shown.
 */
export type OutboxSeen = Pick<
  OutboxRecord,
  'id' | 'did' | 'state' | 'failure' | 'present' | 'deleting'
>

async function beginAction(seen: OutboxSeen) {
  const held = await lockAndReread(seen.did, seen.id, seen)
  if (held.kind === 'gone') {
    notice(handledElsewhereText(), 'info')
    return undefined
  }
  if (held.kind !== 'held') return undefined
  return held
}

/**
 * Retry, or Finish posting on a "Partly posted" entry: the same rkeys, a
 * fresh local encode, from the capture or the record; it reads every post
 * first and never writes a present one again.
 */
export async function retryOutboxEntry(seen: OutboxSeen): Promise<void> {
  const held = await beginAction(seen)
  if (!held) return
  const {entry} = held
  if (getWriteRoute(entry.did).postingRoute !== 'encode') {
    releaseLock(entry)
    return
  }
  prewarmEncoder()
  if (entry.capture) entry.capture.spoilerMode = spoilerWriteMode(true)
  if (
    !persist(
      entry,
      {state: 'sending', failure: undefined, deleting: undefined},
      {checked: true},
    )
  ) {
    persist(entry, {state: 'failed', failure: 'not-saved'})
    releaseLock(entry)
    notice(outboxFailureText('not-saved'))
    return
  }
  if (entry.settleTimer) clearTimeout(entry.settleTimer)
  markRunning({id: entry.id, did: entry.did, rkeys: entry.record.rkeys})
  const queryClient = getCurrentClients()?.queryClient
  urisOf(entry).forEach((uri, index) => {
    if (getPendingPost(uri, entry.did)) return
    const pending = pendingFor(entry, index, queryClient, 'sending')
    if (pending) addPendingPost(pending)
  })
  setPendingPhase(entry, 'sending')
  enqueue(entry)
}

/**
 * Check now: step 5's reads at once, for an `undecided` entry.
 */
export async function checkOutboxEntry(seen: OutboxSeen): Promise<void> {
  const held = await beginAction(seen)
  if (!held) return
  await decideHeld(held.entry)
}

/**
 * Edit, before the composer opens: the run lock and a re-read, then, when
 * the failure followed a PDS write, step 5's reads (K11-L3): a present post
 * stops the Edit. Returns the reply ref to open the composer with, staged,
 * or `undefined` when Edit stops. The lock is released once staged.
 */
export async function beginOutboxEdit(
  seen: OutboxSeen,
): Promise<{replyTo: StoredReplyRef | undefined} | undefined> {
  const held = await beginAction(seen)
  if (!held) return undefined
  const {entry} = held
  if (entry.record.madeWrite || entry.record.lastWriteAt !== undefined) {
    const clients = clientsFor(entry.did)
    if (!clients) {
      releaseLock(entry)
      return undefined
    }
    const reads = await readPosts(entry, clients)
    const uris = urisOf(entry)
    if (reads.some(read => read.state === 'unknown')) {
      undecideEntry(entry, [], {settle: false})
      return undefined
    }
    const present = reads
      .map((read, index) =>
        read.state === 'present'
          ? {uri: uris[index], cid: read.cid ?? ''}
          : undefined,
      )
      .filter((post): post is {uri: string; cid: string} => !!post)
    if (present.length === uris.length) {
      succeedEntry(entry, present)
      notice(alreadyPostedToastText(), 'info')
      return undefined
    }
    if (present.length > 0) {
      failEntry(
        entry,
        entry.record.failure ?? 'post',
        present.map(post => post.uri),
      )
      return undefined
    }
  }
  stageOutboxEdit(entry.id)
  const replyTo = entry.record.replyTo
  releaseLock(entry)
  return {replyTo}
}

/**
 * The gates the compose may have written, as URIs.
 */
function gateUris(record: OutboxRecord): string[] {
  return composeGates(record).map(
    gate => `at://${record.did}/${gate.collection}/${gate.rkey}`,
  )
}

/**
 * Delete the present posts newest first, each a write under step 2's rule;
 * stops at the first that fails or goes unanswered.
 */
async function deletePresentPosts(
  entry: Entry,
  clients: JobClients,
  present: string[],
): Promise<'ok' | 'answered-failure' | 'unanswered'> {
  const route = getWriteRoute(entry.did)
  let writer = repoWriterFor(route.repoRoute, clients.pdsClient)
  for (const uri of [...present].reverse()) {
    try {
      await checkedWrite(entry, 'delete', signal =>
        writer.deletePost(uri, undefined, {signal}),
      )
    } catch (error) {
      if (error instanceof PrivateKryphocronHostError) {
        writer = locusRepoWriter(clients.pdsClient)
        try {
          await checkedWrite(entry, 'delete', signal =>
            writer.deletePost(uri, undefined, {signal}),
          )
        } catch (retryError) {
          return isAnsweredWrite(retryError) ? 'answered-failure' : 'unanswered'
        }
      } else if (!(
        error instanceof XrpcResponseError && error.error === 'RecordNotFound'
      )) {
        return isAnsweredWrite(error) ? 'answered-failure' : 'unanswered'
      }
    }
    present.splice(present.indexOf(uri), 1)
    persist(entry, {
      present: [...present],
      lastWriteAt: undefined,
      lastWriteKind: undefined,
    })
    requestRecordQuietly(clients.prismClient, uri)
    dropPendingPosts([uri])
  }
  return 'ok'
}

/**
 * Delete gate records; a failure is logged by URI and left (with no post, a
 * gate is harmless).
 */
async function deleteComposeGates(
  entry: Entry,
  clients: JobClients,
): Promise<void> {
  for (const uri of [...gateUris(entry.record)].reverse()) {
    const {collection, rkey} = new AtUri(uri)
    try {
      await checkedWrite(entry, 'delete', signal =>
        clients.pdsClient.call(
          com.atproto.repo.deleteRecord,
          {
            repo: entry.did as DidString,
            collection: collection as typeof THREADGATE_COLLECTION,
            rkey,
          },
          {signal},
        ),
      )
    } catch (error) {
      if (
        error instanceof XrpcResponseError &&
        error.error === 'RecordNotFound'
      ) {
        continue
      }
      logger.warn('outbox: gate not deleted', {uri})
    }
  }
}

/**
 * Delete what was posted (K10-L1), after the member confirmed: `deleting`
 * first, then the reads, the present posts newest first, a confirming read,
 * and only then the gates. Ends "Not posted"; stops keeping every gate.
 */
export async function deletePostedOutboxEntry(seen: OutboxSeen): Promise<void> {
  const held = await beginAction(seen)
  if (!held) return
  await runMemberDelete(held.entry, 'posted')
}

/**
 * Discard (K10-L1), after the member confirmed: deletes anything of the
 * compose that was posted, then the gates, then forgets the entry. The
 * source draft is kept.
 */
export async function discardOutboxEntry(seen: OutboxSeen): Promise<void> {
  const held = await beginAction(seen)
  if (!held) return
  await runMemberDelete(held.entry, 'discard')
}

async function runMemberDelete(entry: Entry, deleting: 'posted' | 'discard') {
  const createSettle =
    entry.record.lastWriteKind === 'create'
      ? settleTimeOf(entry.record)
      : undefined
  if (!persist(entry, {deleting}, {checked: true})) {
    releaseLock(entry)
    notice(outboxFailureText('not-saved'))
    return
  }
  const clients = clientsFor(entry.did)
  const stopped = (kind: 'answered' | 'unanswered' | 'read') => {
    if (kind === 'unanswered') {
      undecideEntry(
        entry,
        (entry.record.present ?? []).map(uri => ({uri})),
        {
          settle: true,
        },
      )
    } else if (kind === 'read' || deleting === 'discard') {
      undecideEntry(
        entry,
        (entry.record.present ?? []).map(uri => ({uri})),
        {
          settle: false,
        },
      )
      if (deleting === 'discard' && kind === 'answered') {
        persist(entry, {state: 'failed', failure: 'delete-discard'})
      }
    } else {
      persist(entry, {
        state: 'failed',
        failure: 'delete-posted',
        lastWriteAt: undefined,
        lastWriteKind: undefined,
        settleAfter: undefined,
      })
      setPendingPhase(entry, 'failed', {all: true})
      releaseLock(entry)
    }
    notice(deleteIncompleteToastText())
  }
  if (!clients) {
    releaseLock(entry)
    return
  }
  const uris = urisOf(entry)
  let reads = await readPosts(entry, clients)
  if (reads.some(read => read.state === 'unknown')) {
    stopped('read')
    return
  }
  const present = uris.filter((_uri, index) => reads[index].state === 'present')
  persist(entry, {present: [...present]})
  const result = await deletePresentPosts(entry, clients, present)
  if (result !== 'ok') {
    stopped(result === 'unanswered' ? 'unanswered' : 'answered')
    return
  }
  reads = await readPosts(entry, clients)
  if (reads.some(read => read.state !== 'absent')) {
    const still = uris.filter((_uri, index) => reads[index].state === 'present')
    persist(entry, {present: still})
    stopped(reads.some(read => read.state === 'unknown') ? 'read' : 'answered')
    return
  }
  // Inside an in-doubt create's window an absent read confirms nothing.
  if (createSettle !== undefined && Date.now() < createSettle) {
    persist(entry, {
      state: 'undecided',
      present: [],
      settleAfter: createSettle,
      lastWriteKind: 'create',
    })
    setPendingPhase(entry, 'failed', {all: true})
    releaseLock(entry)
    scheduleSettle(entry)
    notice(deleteIncompleteToastText())
    return
  }
  await deleteComposeGates(entry, clients)
  if (deleting === 'posted') {
    persist(entry, {
      state: 'failed',
      failure: undefined,
      present: [],
      deleting: undefined,
      lastWriteAt: undefined,
      lastWriteKind: undefined,
      settleAfter: undefined,
    })
    setPendingPhase(entry, 'failed', {all: true})
    syncPendingFromRecord(entry)
    releaseLock(entry)
    return
  }
  removeOutboxRecord(entry.did, entry.id)
  forgetEntry(entry, {pending: true})
  void settleReplies(entry.did, uris, 'gone')
}

/**
 * Remove from this device (SQ-19, built on its default): forgets the entry
 * with no read and no PDS call. Whatever is on the PDS stays.
 */
export async function removeOutboxEntryFromDevice(
  seen: OutboxSeen,
): Promise<void> {
  const held = await beginAction(seen)
  if (!held) return
  const {entry} = held
  const uris = urisOf(entry)
  removeOutboxRecord(entry.did, entry.id)
  forgetEntry(entry, {pending: true})
  void settleReplies(entry.did, uris, 'gone')
}

/*
 * Reads for display (Unsent, the pending posts' status).
 */

/**
 * An entry as Unsent and the pending post show it.
 */
export type OutboxView = {
  record: OutboxRecord
  /** This tab holds the capture, media included. */
  holdsCapture: boolean
  /** This tab is running it, or acting on it. */
  runningHere: boolean
  /** Another tab holds its run lock (K9-N5): "Posting in another tab...". */
  runningElsewhere: boolean
}

/**
 * The view of the entry whose compose holds `uri`, in this tab.
 */
export function outboxViewForUri(
  did: string,
  uri: string,
  held: ReadonlySet<string>,
): OutboxView | undefined {
  const id = getPendingPost(uri, did)?.outboxId
  if (!id) return undefined
  const entry = entries.get(id)
  const record = entry?.record ?? readOutboxRecord(did, id)
  if (!record) return undefined
  return viewOf(record, held)
}

function viewOf(record: OutboxRecord, held: ReadonlySet<string>): OutboxView {
  const entry = entries.get(record.id)
  const runningHere = !!entry?.lock || !!entry?.busy
  return {
    record: entry?.record ?? record,
    holdsCapture: !!entry?.capture,
    runningHere,
    runningElsewhere: !runningHere && held.has(runLockName(record.id)),
  }
}

/**
 * Unsent's entries (8.4): the account's `failed` and `undecided` entries,
 * and the `queued` or `sending` records another tab is running. This tab's
 * own running entries show on their pending posts instead.
 */
export function listUnsent(
  did: string,
  held: ReadonlySet<string>,
): OutboxView[] {
  return listOutboxRecords(did)
    .map(record => viewOf(record, held))
    .filter(view => {
      const state = view.record.state
      if (view.runningHere) return false
      if (state === 'failed' || state === 'undecided') return true
      return view.runningElsewhere
    })
}

export {heldLockNames}

/**
 * The staged Edit's restore (hooks Comp 4 and 5): the posts, gates,
 * visibility, spoilers and videos to put in the composer, from the held
 * capture (with outbox object URLs for the images and videos) or from the
 * record alone. `urls` are revoked when the composer unmounts.
 */
export function editRestoreFor(id: string):
  | {
      record: OutboxRecord
      posts: PostDraft[]
      videos: {
        postIndex: number
        uri: string
        mimeType: string
        altText: string
        captions: File[]
        captionLangs: string[]
      }[]
      urls: string[]
      withMedia: boolean
    }
  | undefined {
  const entry = entries.get(id)
  const did = getCurrentClients()?.did
  const record = entry?.record ?? (did ? readOutboxRecord(did, id) : undefined)
  if (!record) return undefined
  const urls: string[] = []
  const videos: NonNullable<ReturnType<typeof editRestoreFor>>['videos'] = []
  if (entry?.capture) {
    const capture = entry.capture
    const posts = capture.thread.posts.map((post, index) => {
      const restored = postFromRecord(record.posts[index], index)
      const media = post.embed.media
      if (media?.type === 'images' || media?.type === 'gallery') {
        const images: ComposerImage[] = []
        for (const image of media.images) {
          const blob = capture.images.get(image.source.id)
          const url = blob ? makeUrl(blob) : undefined
          if (!url) continue
          urls.push(url)
          const shown = image.transformed ?? image.source
          images.push({
            alt: image.alt,
            source: {
              id: nanoid(),
              path: url,
              width: shown.width,
              height: shown.height,
              mime: shown.mime,
            },
          })
        }
        restored.embed.media = {type: media.type, images}
      } else if (media?.type === 'video' && media.video.asset?.file) {
        const file = media.video.asset.file
        const url = makeUrl(file)
        if (url) {
          urls.push(url)
          videos.push({
            postIndex: index,
            uri: url,
            mimeType: file.type || 'video/mp4',
            altText: media.video.altText,
            captions: media.video.captions.map(caption => caption.file),
            captionLangs: media.video.captions.map(caption => caption.lang),
          })
        }
      } else if (media?.type === 'gif') {
        restored.embed.media = media
      }
      return restored
    })
    return {record, posts, videos, urls, withMedia: true}
  }
  return {
    record,
    posts: record.posts.map(postFromRecord),
    videos,
    urls,
    withMedia: false,
  }
}

/**
 * Release media URLs made for an Edit composer (its unmount).
 */
export function revokeEditUrls(urls: readonly string[]) {
  for (const url of urls) revokeUrl(url)
}

/**
 * Forget everything in memory (tests).
 */
export function resetOutbox() {
  for (const entry of entries.values()) {
    if (entry.settleTimer) clearTimeout(entry.settleTimer)
    entry.lock?.release()
  }
  entries.clear()
  queue.length = 0
  paused = false
  stagedEdit = undefined
  composerEdit = undefined
  watchedDids.forEach(unsubscribe => unsubscribe())
  watchedDids.clear()
  deciding.clear()
  changed()
}

export {outboxRecordKey}
