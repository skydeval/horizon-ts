/*
 * Publishing as the posting account (Phase 5 design 8.3, 8.4, 8.5).
 *
 * - **The fronters** a post is written with: `fronters.ts`.
 * - **The clients** (`beginPostingPublish`, PA-2): the current account's, or
 *   the chosen account's temporary client, whose PDS client must write as
 *   that account (Witchsky's "posting session does not match" check), after
 *   `assertOwnGates`.
 * - **The front update** after a public post with members (PP-6, 8.4):
 *   chosen members become engaging, members engaging before and not chosen
 *   leave, everything else is kept; skipped when the engaging set already
 *   matches; through the posting account's client, swapped on the cached
 *   CID and reapplied once on a swap failure. A failure never fails the
 *   post. A kryphocron post never changes the front (P5R1-Q1).
 */

import {type Client, lexToJson, XrpcResponseError} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {type ThreadDraft} from '#/view/com/composer/state/composer'
import {
  type FrontMember,
  isEngaging,
  parseFront,
  type PluralFront,
} from '#/horizon/identity/parse'
import {type IdentityAnswer, identityQueryKey} from '#/horizon/identity/queries'
import {
  IdentityWriteConflictError,
  type OwnWriter,
  saveFront,
} from '#/horizon/identity/writes'
import {
  PLURAL_FRONT_COLLECTION,
  PLURAL_SELF_RKEY,
} from '#/horizon/lexicons/nearhorizon'
import {getComposeVisibility} from '#/horizon/private/composer/state'
import {CONFIRM_AT_MS} from '#/horizon/private/store'
import {isPrivatePostUri} from '#/horizon/private/uri'
import {POSTING_AS} from '#/horizon/switches'
import {com} from '#/lexicons'
import {getPostingState, isPostingAsOther} from './compose-store'
import {postingFronters} from './fronters'
import {assertOwnGates, postingClientsFor} from './gates'
import {holdTemporaryClientUntil} from './temp-client'
import {showFrontFailedToast} from './toasts'

/** The chosen account's client does not write as that account. */
export class PostingAccountMismatchError extends Error {
  constructor() {
    super(
      t`This post isn’t set to go from the account you chose. Choose it again.`,
    )
    this.name = 'PostingAccountMismatchError'
  }
}

/** Publish was reached while the posting account was still held. */
export class PostingAccountNotReadyError extends Error {
  constructor() {
    super(t`Couldn’t load that account’s settings. Try again.`)
    this.name = 'PostingAccountNotReadyError'
  }
}

type StockClients = {
  appviewClient: Client
  chatClient: Client
  pdsClient: Client
}

/** What the composer posts with, and what it does after. */
export type PostingReceipt = {
  clients: StockClients
  /** The posting account's handle when it is not the current account. */
  postedAs: string | undefined
  /** After a successful publish: the front update and the client's hold. */
  afterPublish: (postUri: string | undefined) => void
}

/**
 * The clients `post()` is handed (PA-2), after `assertOwnGates`. Throws a
 * message the composer shows, with nothing sent.
 */
export function beginPostingPublish(
  stock: StockClients,
  thread: Pick<ThreadDraft, 'threadgate'>,
  queryClient: QueryClient,
): PostingReceipt {
  const s = getPostingState()
  if (!POSTING_AS || !s.active || !s.did) {
    return {clients: stock, postedAs: undefined, afterPublish: () => {}}
  }
  if (s.hold.kind !== 'none' || s.resetPending || s.heldMembers) {
    throw new PostingAccountNotReadyError()
  }
  const did = s.did
  const other = isPostingAsOther(s)
  const posting = other ? postingClientsFor(did) : undefined
  if (other && !posting) throw new PostingAccountNotReadyError()
  const clients: StockClients = posting
    ? {
        appviewClient: posting.appviewClient,
        chatClient: posting.chatClient,
        pdsClient: posting.pdsClient,
      }
    : stock
  let writesAs: string | undefined
  try {
    writesAs = clients.pdsClient.assertDid
  } catch {
    writesAs = undefined
  }
  if (writesAs !== did) throw new PostingAccountMismatchError()
  assertOwnGates(did, thread, getComposeVisibility())
  const members = postingFronters(queryClient, did)
  return {
    clients,
    postedAs: other ? s.handle : undefined,
    afterPublish: postUri => {
      const background = new Promise<void>(resolve =>
        setTimeout(resolve, CONFIRM_AT_MS[CONFIRM_AT_MS.length - 1] + 5_000),
      )
      const front =
        postUri && !isPrivatePostUri(postUri) && members.length > 0
          ? runFrontUpdate(
              {did, pdsClient: clients.pdsClient, queryClient},
              members,
            )
          : Promise.resolve()
      // The temporary client stays open for the front write and the private
      // path's background confirmations (PP-16).
      if (other) holdTemporaryClientUntil(did, Promise.all([background, front]))
    },
  }
}

/**
 * The front after a post as `chosen` (PP-6): `undefined` when its engaging
 * set already is `chosen`.
 */
export function nextFrontMembers(
  previous: PluralFront | undefined,
  chosen: readonly string[],
): FrontMember[] | undefined {
  const wanted = new Set(chosen)
  const before = previous?.members ?? []
  const engagingBefore = new Set(
    before.filter(isEngaging).map(member => member.id),
  )
  if (
    engagingBefore.size === wanted.size &&
    [...wanted].every(id => engagingBefore.has(id))
  ) {
    return undefined
  }
  const next: FrontMember[] = []
  const seen = new Set<string>()
  for (const member of before) {
    if (seen.has(member.id)) continue
    seen.add(member.id)
    if (wanted.has(member.id)) next.push({id: member.id, status: 'engaging'})
    else if (!isEngaging(member)) next.push(member)
  }
  for (const id of chosen) {
    if (!seen.has(id)) next.push({id, status: 'engaging'})
  }
  return next
}

/**
 * The front as stored, read with the posting account's own client (never
 * through prism, never as another account). A record that does not parse
 * is not written over.
 */
async function readFront(w: OwnWriter): Promise<IdentityAnswer<PluralFront>> {
  let res
  try {
    res = await w.pdsClient.call(com.atproto.repo.getRecord, {
      repo: w.did as DidString,
      collection: PLURAL_FRONT_COLLECTION,
      rkey: PLURAL_SELF_RKEY,
    })
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return {kind: 'none'}
    }
    throw error
  }
  const value = parseFront(lexToJson(res.value))
  if (!value) throw new Error('the front does not parse')
  const answer: IdentityAnswer<PluralFront> = {
    kind: 'record',
    value,
    ...(res.cid ? {cid: res.cid} : {}),
  }
  w.queryClient.setQueryData(identityQueryKey('front', {did: w.did}), answer)
  return answer
}

async function writeFront(
  w: OwnWriter,
  previous: IdentityAnswer<PluralFront>,
  chosen: readonly string[],
) {
  const old = previous.kind === 'record' ? previous.value : undefined
  const members = nextFrontMembers(old, chosen)
  if (!members) return
  await saveFront(w, previous, {
    members,
    state: old?.state ?? '',
    comment: old?.comment ?? '',
  })
}

/**
 * Update the front after a public post as `chosen`: from the cached front
 * (read when none is cached), and on a swap failure read once more and
 * apply again. Throws when it could not.
 */
export async function updateFrontAfterPost(
  w: OwnWriter,
  chosen: readonly string[],
): Promise<void> {
  const cached = w.queryClient.getQueryData<IdentityAnswer<PluralFront>>(
    identityQueryKey('front', {did: w.did}),
  )
  const previous = cached ?? (await readFront(w))
  try {
    await writeFront(w, previous, chosen)
  } catch (error) {
    if (!(error instanceof IdentityWriteConflictError)) throw error
    await writeFront(w, await readFront(w), chosen)
  }
}

function runFrontUpdate(
  w: OwnWriter,
  chosen: readonly string[],
): Promise<void> {
  return updateFrontAfterPost(w, chosen).catch((error: unknown) => {
    logger.warn('posting as: the front could not be updated', {
      safeMessage: error,
    })
    showFrontFailedToast(() => void runFrontUpdate(w, chosen))
  })
}
