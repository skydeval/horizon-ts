/*
 * Gates, audiences, lists and fronters belong to the posting account
 * (Phase 5 design PP-19, 8.2, B-25).
 *
 * - **The reset**, on an account the user picks in the "Posting as" control
 *   (`choosePostingAccount`, the design's `resetGatesFor`): the visibility
 *   is kept exactly as it stands, Public or Private, and at once the
 *   audience becomes `{kind: 'unpicked', why: 'switch'}` unless the compose
 *   is a locked reply (skydeval's option c, P5R5-Q1; P5R6-Q1 for a Public
 *   compose), through `setComposeVisibility`, so the current account's late
 *   defaults cannot land. The member selection is cleared. Then the posting
 *   account's interaction settings, system, front and members are read
 *   (another account through its temporary client, from its own PDS), and
 *   once every read has answered the threadgate and postgate are set from
 *   its settings and its engaging members are chosen. No private posting
 *   default is ever applied. Until then the reset is pending: Publish, the
 *   drop-down's sections, the Public | Private control and the members group
 *   are held. A failed read keeps them held behind "Couldn't load @other's
 *   settings." and Try again; the current account's values are never used
 *   in their place.
 * - **The start**: the composer opening as the current account chooses its
 *   engaging members once its front and members are read, unless the user
 *   picked members first. Nothing is held.
 * - **`assertOwnGates`** at publish: a reply-list rule, or a Private `list`
 *   audience, owned by another of the user's stored accounts is refused. An
 *   audience of kind `parent` is exempt: aurora decides it (A-12, A-13).
 *
 * Every hold is read by the composer through subscriptions
 * (`compose-store.ts`), never by a zero-argument call (PA-26).
 */

import {AtUri, type AtUriString, toDatetimeString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {createPostgateRecord} from '#/state/queries/postgate/util'
import {threadgateRecordToAllowUISetting} from '#/state/queries/threadgate/util'
import {
  type ComposerAction,
  type ThreadDraft,
} from '#/view/com/composer/state/composer'
import {MAX_FRONTERS} from '#/horizon/identity/fronters'
import {isEngaging} from '#/horizon/identity/parse'
import {type IdentityAnswer, identityQueryKey} from '#/horizon/identity/queries'
import {readActorRecords, readMemberList} from '#/horizon/identity/reads'
import {getPrivatePosts} from '#/horizon/private/api/reads'
import {readAppviewBlocks} from '#/horizon/private/api/reply-block'
import {
  type ComposeVisibility,
  getComposeVisibility,
  setComposeVisibility,
} from '#/horizon/private/composer/state'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {POSTING_AS} from '#/horizon/switches'
import {app} from '#/lexicons'
import {
  endPostingRecord,
  getPostingState,
  isPostingAsOther,
  type PostingAccountData,
  type PostingState,
  startPostingRecord,
  updatePosting,
} from './compose-store'
import {notifyPosting} from './notify'
import {
  acquireTemporaryClient,
  peekTemporaryClient,
  type PostingClients,
  releaseTemporaryClient,
  storedAccountDids,
  storedAccountFor,
  TemporaryClientUnavailableError,
} from './temp-client'

type ComposerHandle = {
  dispatch: (action: ComposerAction) => void
  replyTo: string | undefined
}

let composer: {handle: ComposerHandle} | undefined

/**
 * Called by the composer's audience provider (Horizon code) on mount: the
 * composer's dispatch and reply target, for the reset. Returns the
 * unregister function, which never clears a newer registration.
 */
export function registerPostingComposer(handle: ComposerHandle): () => void {
  const entry = {handle}
  composer = entry
  return () => {
    if (composer === entry) composer = undefined
  }
}

/** Tell the store whether a video is attached (8.5's video limit). */
export function setPostingHasVideo(hasVideo: boolean) {
  const s = getPostingState()
  if (s.active && s.hasVideo !== hasVideo) updatePosting({hasVideo})
}

/**
 * The clients of the posting account `did`: the published current clients
 * for the current account, else its temporary client while held.
 */
export function postingClientsFor(did: string): PostingClients | undefined {
  const current = getCurrentClients()
  if (current?.did === did) {
    return {
      did,
      handle: current.handle,
      pdsClient: current.pdsClient,
      appviewClient: current.appviewClient,
      chatClient: current.chatClient ?? current.appviewClient,
      prismClient: current.prismClient,
    }
  }
  return peekTemporaryClient(did)
}

/**
 * The posting account's interaction settings, read with its client. The raw
 * lexicon read, not the sdk's `getPreferences`: that action writes a
 * default saved feed into an account that has none, minted on the sdk's own
 * shared TID clock, which would put one page's clock id into another
 * account's repo (Phase 5 PP-21, Appendix A). A read changes nothing.
 */
async function readSettings(
  clients: PostingClients,
): Promise<app.bsky.actor.defs.PostInteractionSettingsPref | undefined> {
  const res = await clients.pdsClient.call(app.bsky.actor.getPreferences, {})
  const pref = res.preferences.find(
    item =>
      (item as {$type?: string}).$type ===
      'app.bsky.actor.defs#postInteractionSettingsPref',
  ) as app.bsky.actor.defs.PostInteractionSettingsPref | undefined
  return {
    threadgateAllowRules: pref?.threadgateAllowRules,
    postgateEmbeddingRules: pref?.postgateEmbeddingRules,
  }
}

/**
 * The posting account's plural records, from its own PDS (the current
 * account's, or the temporary client registered for it). Any failure
 * throws. The query cache is seeded, so the composer's member check and
 * every other site see the answers.
 */
async function readPlural(
  did: string,
  queryClient: QueryClient | undefined,
): Promise<{data: PostingAccountData; engaging: string[]}> {
  const actor = await readActorRecords(did)
  if (actor.system.status === 'error') throw actor.system.error
  if (actor.system.status === 'unknown') throw new Error('system unknown')
  if (actor.system.status === 'none') {
    queryClient?.setQueryData(identityQueryKey('system', {did}), {
      kind: 'none',
    } satisfies IdentityAnswer<never>)
    return {data: {did, isSystem: false, members: []}, engaging: []}
  }
  if (actor.front.status === 'error') throw actor.front.error
  if (actor.front.status === 'unknown') throw new Error('front unknown')
  const list = await readMemberList(did)
  if (list.status === 'unknown') throw new Error('members unknown')
  if (queryClient) {
    queryClient.setQueryData(identityQueryKey('system', {did}), {
      kind: 'record',
      value: actor.system.value,
      ...(actor.system.cid ? {cid: actor.system.cid} : {}),
    })
    queryClient.setQueryData(
      identityQueryKey('front', {did}),
      actor.front.status === 'record'
        ? {
            kind: 'record',
            value: actor.front.value,
            ...(actor.front.cid ? {cid: actor.front.cid} : {}),
          }
        : {kind: 'none'},
    )
    queryClient.setQueryData(identityQueryKey('members', {did}), {
      members: list.members,
      partial: list.status === 'partial',
    })
    for (const member of list.members) {
      queryClient.setQueryData(
        identityQueryKey('member', {did, rkey: member.rkey}),
        {
          kind: 'record',
          value: member.value,
          ...(member.cid ? {cid: member.cid} : {}),
        },
      )
    }
  }
  const listed = new Set(list.members.map(member => member.rkey))
  const engaging =
    actor.front.status === 'record'
      ? [
          ...new Set(
            actor.front.value.members
              .filter(isEngaging)
              .map(member => member.id)
              .filter(id => listed.has(id)),
          ),
        ]
          .sort()
          .slice(0, MAX_FRONTERS)
      : []
  return {data: {did, isSystem: true, members: list.members}, engaging}
}

/** A choice the chosen account cannot make (8.2, 8.5): refused, not failed. */
class PostingChoiceRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostingChoiceRefused'
  }
}

/**
 * The reply checks for another account (8.2, 8.5): a reply to a private post
 * needs that account to read the parent through prism; a reply to a public
 * post needs the parent served to it, replies not disabled for it, and no
 * block between it and the parent's author. A check that cannot be made
 * lets the choice stand: the write path checks again at publish.
 */
async function checkReply(clients: PostingClients, replyTo: string) {
  if (isPrivatePostUri(replyTo)) {
    const posts = await getPrivatePosts(clients.prismClient, [replyTo])
    if (!posts.some(post => post.uri === replyTo)) {
      throw new PostingChoiceRefused(t`That account can’t see this post.`)
    }
    return
  }
  const res = await clients.appviewClient.call(app.bsky.feed.getPosts, {
    uris: [replyTo as AtUriString],
  })
  const parent = res.posts[0]
  if (!parent || parent.viewer?.replyDisabled) {
    throw new PostingChoiceRefused(t`That account can’t reply to this post.`)
  }
  const author = parent.author.did
  if (author !== clients.did) {
    const verdict = await readAppviewBlocks(
      clients.appviewClient,
      clients.did,
      author,
    )
    if (verdict === 'blocked') {
      throw new PostingChoiceRefused(t`That account can’t reply to this post.`)
    }
  }
}

/** The threadgate and postgate of a compose started from `settings`. */
function dispatchSettings(
  settings: app.bsky.actor.defs.PostInteractionSettingsPref | undefined,
) {
  const dispatch = composer?.handle.dispatch
  if (!dispatch) return
  dispatch({
    type: 'update_threadgate',
    threadgate: threadgateRecordToAllowUISetting({
      $type: 'app.bsky.feed.threadgate',
      post: '' as AtUriString,
      createdAt: toDatetimeString(new Date()),
      allow: settings?.threadgateAllowRules,
    }),
  })
  dispatch({
    type: 'update_postgate',
    postgate: createPostgateRecord({
      post: '',
      embeddingRules: settings?.postgateEmbeddingRules || [],
    }),
  })
}

function current(gen: number): PostingState | undefined {
  const s = getPostingState()
  return s.active && s.generation === gen ? s : undefined
}

type LoadMode = 'start' | 'reset' | 'restore'

/**
 * Read the posting account `did` for `mode` and apply the answer, unless a
 * newer change came meanwhile (`gen`).
 */
async function loadPostingAccount(
  gen: number,
  did: string,
  mode: LoadMode,
  previous?: string,
) {
  const queryClient = getCurrentClients()?.queryClient
  try {
    const clients = postingClientsFor(did)
    if (!clients) throw new TemporaryClientUnavailableError(did)
    const replyTo = composer?.handle.replyTo
    const isOther = did !== getPostingState().currentDid
    const [settings, plural] = await Promise.all([
      mode === 'start' ? Promise.resolve(undefined) : readSettings(clients),
      readPlural(did, queryClient),
      mode === 'reset' && isOther && replyTo
        ? checkReply(clients, replyTo)
        : Promise.resolve(),
    ])
    const s = current(gen)
    if (!s) return
    if (mode === 'start') {
      updatePosting({
        data: plural.data,
        ...(s.touched ? {} : {members: plural.engaging}),
      })
      return
    }
    if (mode === 'reset') {
      dispatchSettings(settings)
      updatePosting({
        data: plural.data,
        settings,
        members: plural.engaging,
        touched: false,
        hold: {kind: 'none'},
        resetPending: false,
      })
      return
    }
    // A restored draft: its members stand only if read for this account.
    const listed = new Set(plural.data.members.map(member => member.rkey))
    updatePosting({
      data: plural.data,
      settings,
      members: (s.heldMembers ?? []).filter(rkey => listed.has(rkey)),
      heldMembers: undefined,
      touched: true,
      hold: {kind: 'none'},
    })
  } catch (error) {
    const s = current(gen)
    if (!s) return
    if (error instanceof PostingChoiceRefused) {
      notifyPosting(error.message)
      if (previous) choosePostingAccount(previous)
      return
    }
    logger.warn('posting as: the posting account could not be read', {
      mode,
      safeMessage: error,
    })
    if (mode === 'start') return
    updatePosting({hold: {kind: 'failed'}})
  }
}

/**
 * Start the compose session (the composer opening) as the current account
 * `did`. Its engaging members are chosen once read; nothing is held.
 */
export function startPostingSession(did: string, handle: string | undefined) {
  if (!POSTING_AS) return
  startPostingRecord(did, handle)
  void loadPostingAccount(getPostingState().generation, did, 'start')
}

/** End the compose session: the temporary client is let go. */
export function endPostingSession() {
  const s = getPostingState()
  if (isPostingAsOther(s) && s.did) releaseTemporaryClient(s.did)
  endPostingRecord()
}

/**
 * The visibility an account change leaves: as it stands, with no audience
 * chosen, unless the compose is a locked reply, which keeps its `parent`.
 */
export function visibilityAfterSwitch(
  visibility: ComposeVisibility,
): ComposeVisibility {
  if (visibility.locked) return visibility
  return {
    visibility: visibility.visibility,
    audience: {kind: 'unpicked', why: 'switch'},
    locked: false,
  }
}

/**
 * The reset (PA-9, the design's `resetGatesFor`): `did` picked in the
 * control. See the file header. A choice that the chosen account's client
 * cannot be made for keeps the previous choice and offers sign-in.
 */
export function choosePostingAccount(did: string) {
  const s = getPostingState()
  if (!POSTING_AS || !s.active || did === s.did) return
  const isOther = did !== s.currentDid
  // 8.5: a video was uploaded as the current account.
  if (isOther && s.hasVideo) return
  let handle = s.currentHandle
  if (isOther) {
    try {
      handle = acquireTemporaryClient(did).handle
    } catch (error) {
      logger.info('posting as: no temporary client', {safeMessage: error})
      notifyPosting(t`That account isn’t signed in on this device.`)
      return
    }
  }
  const previous = s.did
  if (previous && previous !== s.currentDid) releaseTemporaryClient(previous)
  // At once, before any read: the visibility kept, no audience chosen.
  setComposeVisibility(visibilityAfterSwitch(getComposeVisibility()))
  const gen = s.generation + 1
  updatePosting({
    did,
    handle,
    members: [],
    heldMembers: undefined,
    touched: false,
    hold: {kind: 'pending'},
    resetPending: true,
    data: undefined,
    settings: undefined,
    draftNote: undefined,
    generation: gen,
  })
  void loadPostingAccount(gen, did, 'reset', previous)
}

/** The design's name for the reset (PA-9). */
export const resetGatesFor = choosePostingAccount

/**
 * Try again after a failed read: the failed reset or restore runs its reads
 * again, nothing else.
 */
export function retryPostingReads() {
  const s = getPostingState()
  if (!s.active || s.hold.kind !== 'failed' || !s.did) return
  const gen = s.generation + 1
  updatePosting({hold: {kind: 'pending'}, generation: gen})
  void loadPostingAccount(gen, s.did, s.resetPending ? 'reset' : 'restore')
}

/**
 * Set the posting account without the reset, for a restored draft (8.2,
 * P5R2-L5): the draft's own gates and audience apply as saved, and its
 * members are held until that account's member list answers. An account
 * that is not signed in here blocks Publish until another is chosen.
 */
export function restorePostingAccount(
  did: string,
  members: readonly string[],
  savedHandle?: string,
) {
  const s = getPostingState()
  if (!POSTING_AS || !s.active) return
  const isOther = did !== s.currentDid
  const previous = s.did
  let handle = s.currentHandle
  let signedOut = false
  if (isOther) {
    if (previous === did) {
      handle = s.handle
    } else {
      try {
        handle = acquireTemporaryClient(did).handle
      } catch {
        signedOut = true
        handle = storedAccountFor(did)?.handle ?? savedHandle
      }
    }
  }
  if (previous && previous !== s.currentDid && previous !== did) {
    releaseTemporaryClient(previous)
  }
  const gen = s.generation + 1
  updatePosting({
    did,
    handle,
    members: [],
    heldMembers: signedOut ? undefined : [...members],
    touched: true,
    hold: signedOut ? {kind: 'signedOut', handle} : {kind: 'pending'},
    resetPending: false,
    data: undefined,
    settings: undefined,
    generation: gen,
  })
  if (!signedOut) void loadPostingAccount(gen, did, 'restore')
}

/**
 * A restored draft with no posting-as entry on this device starts as the
 * current account does (8.1): its engaging members, nothing held.
 */
export function restartAsCurrentAccount() {
  const s = getPostingState()
  if (!POSTING_AS || !s.active || !s.currentDid) return
  if (isPostingAsOther(s) && s.did) releaseTemporaryClient(s.did)
  const gen = s.generation + 1
  updatePosting({
    did: s.currentDid,
    handle: s.currentHandle,
    members: [],
    heldMembers: undefined,
    touched: false,
    hold: {kind: 'none'},
    resetPending: false,
    data: undefined,
    settings: undefined,
    generation: gen,
  })
  void loadPostingAccount(gen, s.currentDid, 'start')
}

/**
 * Check or uncheck a member of the posting account. Refused while the
 * members group is held, for a member not read for that account, and past
 * {@link MAX_FRONTERS}.
 */
export function togglePostingMember(rkey: string): boolean {
  const s = getPostingState()
  if (!s.active || s.resetPending || s.hold.kind !== 'none') return false
  if (!s.data?.members.some(member => member.rkey === rkey)) return false
  if (s.members.includes(rkey)) {
    updatePosting({
      members: s.members.filter(id => id !== rkey),
      touched: true,
    })
    return true
  }
  if (s.members.length >= MAX_FRONTERS) return false
  updatePosting({members: [...s.members, rkey].sort(), touched: true})
  return true
}

/**
 * The interaction settings the composer's Clear re-seeds from (8.2): the
 * posting account's own when another account posts (none until they are
 * read; the reset applies them when they land), else the current account's
 * `stock` settings.
 */
export function postingInteractionSettings(
  stock: app.bsky.actor.defs.PostInteractionSettingsPref | undefined,
): app.bsky.actor.defs.PostInteractionSettingsPref | undefined {
  const s = getPostingState()
  return isPostingAsOther(s) ? s.settings : stock
}

/**
 * Why a video cannot be attached now (8.5, PA-11): it would be uploaded as
 * the current account while another account posts. `undefined` otherwise.
 */
export function postingVideoRefusal(): string | undefined {
  const s = getPostingState()
  if (!POSTING_AS || !isPostingAsOther(s)) return undefined
  const other = s.handle ? `@${s.handle}` : t`that account`
  return t`Switch to ${other} to post a video`
}

/** Record that the posting account's settings were saved as `settings`. */
export function notePostingSettingsSaved(
  did: string,
  settings: app.bsky.actor.defs.PostInteractionSettingsPref,
) {
  const s = getPostingState()
  if (s.active && s.did === did) updatePosting({settings})
}

/** The DID a list or audience URI belongs to, or `undefined`. */
function ownerOf(uri: string): string | undefined {
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

/** A reply-list rule of another of the user's accounts (PP-19). */
export class ForeignReplyListError extends Error {
  constructor() {
    super(
      t`These reply settings use a list from another of your accounts. Choose them again.`,
    )
    this.name = 'ForeignReplyListError'
  }
}

/** A Private list audience of another of the user's accounts (PP-19). */
export class ForeignAudienceError extends Error {
  constructor() {
    super(
      t`This audience belongs to another of your accounts. Choose another audience.`,
    )
    this.name = 'ForeignAudienceError'
  }
}

/**
 * Refuse a compose that would carry another stored account's list (8.2,
 * P5R2-L3): a reply-list rule in its threadgate, or, while Private, a
 * `list` audience. An audience of kind `parent` is not looked at, nor is
 * anyone else's list: those are left to the stock and aurora paths. Pure;
 * `storedDids` defaults to the accounts stored on this device.
 */
export function assertOwnGates(
  postingDid: string,
  thread: Pick<ThreadDraft, 'threadgate'>,
  visibility: Pick<ComposeVisibility, 'visibility' | 'audience'>,
  storedDids: readonly string[] = storedAccountDids(),
) {
  const others = new Set(storedDids.filter(did => did !== postingDid))
  for (const setting of thread.threadgate) {
    if (setting.type !== 'list') continue
    const owner = ownerOf(setting.list)
    if (owner && others.has(owner)) throw new ForeignReplyListError()
  }
  const audience = visibility.audience
  if (visibility.visibility === 'private' && audience.kind === 'list') {
    const owner = ownerOf(audience.uri)
    if (owner && others.has(owner)) throw new ForeignAudienceError()
  }
}
