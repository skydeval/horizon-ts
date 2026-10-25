import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * Drafts keep their posting account (Phase 5 design 8.2 Drafts, PA-10,
 * B-26; section 13 "Drafts"): the side entry captured when the save starts,
 * the reset-free restore, a signed-out account, held members, and the drop
 * of another account's reply lists in the record form.
 */
const mockAccounts: Record<string, unknown>[] = []
jest.mock('#/state/persisted', () => ({
  get: (key: string) =>
    key === 'session' ? {accounts: mockAccounts} : undefined,
  write: () => Promise.resolve(),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: [], currentAccount: undefined}),
  useMaybePdsClient: () => null,
}))
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => Promise.reject(new Error('no network in tests')),
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
const mockTemps = new Map<string, Record<string, unknown>>()
jest.mock('#/horizon/posting-as/temp-client', () => {
  const actual = jest.requireActual<Record<string, unknown>>(
    '#/horizon/posting-as/temp-client',
  )
  return {
    ...actual,
    acquireTemporaryClient: (did: string) => {
      const held = mockTemps.get(did)
      if (!held) {
        const {TemporaryClientUnavailableError} = actual as {
          TemporaryClientUnavailableError: new (did: string) => Error
        }
        throw new TemporaryClientUnavailableError(did)
      }
      return held
    },
    peekTemporaryClient: (did: string) => mockTemps.get(did),
    releaseTemporaryClient: () => {},
  }
})

import {type AtUriString} from '@atproto/syntax'
import {i18n} from '@lingui/core'

import {
  registerOwnIdentityClient,
  resetIdentityReads,
} from '#/horizon/identity/reads'
import {
  applyDraftVisibility,
  captureDraftVisibility,
  recordDraftVisibility,
} from '#/horizon/private/composer/drafts'
import {
  getComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
  startComposeVisibility,
} from '#/horizon/private/composer/state'
import {writeLocal} from '#/horizon/session/local-store'
import {
  getPostingState,
  postingAllowsFor,
  resetPostingRecord,
  updatePosting,
} from '../compose-store'
import {
  applyDraftPostingAs,
  captureDraftPostingAs,
  dropForeignListRules,
  readPostingDraftTable,
  recordDraftPostingAs,
  restoredThreadgateAllow,
} from '../drafts'
import {postingFronters} from '../fronters'
import {choosePostingAccount, startPostingSession} from '../gates'
import {
  audienceUri,
  type FakeAccount,
  fakeAccount,
  listUri,
  LOCUS_URL,
  MAIN,
  OTHER,
  publishCurrent,
  settle,
  SPARROW,
  STOCK_URL,
  STOCKY,
  storedAccount,
  WREN,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const LIST_RULE = 'app.bsky.feed.threadgate#listRule' as const
const MENTION_RULE = {$type: 'app.bsky.feed.threadgate#mentionRule' as const}

let main: FakeAccount
let other: FakeAccount

function useTemp(account: FakeAccount, handle: string) {
  mockTemps.set(account.did, {
    did: account.did,
    handle,
    pdsClient: account.client,
    appviewClient: account.client,
    chatClient: account.client,
    prismClient: account.client,
  })
  registerOwnIdentityClient(account.did, account.client)
}

function open() {
  startComposeVisibility(PUBLIC_COMPOSE)
  startPostingSession(MAIN, 'main.test')
}

beforeEach(() => {
  resetIdentityReads()
  resetPostingRecord()
  mockTemps.clear()
  mockAccounts.length = 0
  mockAccounts.push(
    storedAccount(MAIN, LOCUS_URL, 'main.test'),
    storedAccount(OTHER, LOCUS_URL, 'other.test'),
  )
  writeLocal(`horizon:draft-posting-as:${MAIN}`, undefined)
  writeLocal(`horizon:draft-visibility:${MAIN}`, undefined)
  main = fakeAccount(MAIN, {
    system: true,
    members: [{rkey: SPARROW, name: 'Sparrow'}],
    engaging: [SPARROW],
    replyRules: [],
  })
  other = fakeAccount(OTHER, {
    system: true,
    members: [{rkey: WREN, name: 'Wren'}],
    engaging: [],
    replyRules: [],
  })
  publishCurrent(main, LOCUS_URL, 'main.test')
  useTemp(other, 'other.test')
  setComposeVisibility(PUBLIC_COMPOSE)
})

describe('the posting-as entry (PA-10)', () => {
  it('a draft saved as another account with Wren restores as that account and Wren, whatever the front says', async () => {
    open()
    choosePostingAccount(OTHER)
    await settle()
    updatePosting({members: [WREN]})
    recordDraftPostingAs('draft-1', captureDraftPostingAs())
    expect(readPostingDraftTable(MAIN)).toEqual([
      {id: 'draft-1', did: OTHER, handle: 'other.test', members: [WREN]},
    ])

    // A new composer, opened as the current account.
    open()
    await settle()
    expect(getPostingState().members).toEqual([SPARROW])
    expect(applyDraftPostingAs('draft-1')).toBe(OTHER)
    expect(getPostingState().did).toBe(OTHER)
    // Held until that account's member list answers.
    expect(postingAllowsFor(getPostingState())).toBe(false)
    expect(postingFronters(undefined, OTHER)).toEqual([])
    await settle()
    expect(getPostingState().members).toEqual([WREN])
    expect(postingAllowsFor(getPostingState())).toBe(true)
    expect(postingFronters(undefined, OTHER)).toEqual([WREN])
  })

  it('the entry is captured when the save starts, not when it returns', async () => {
    open()
    choosePostingAccount(OTHER)
    await settle()
    const captured = captureDraftPostingAs()
    // The composer closes, or the account changes, during the save's hop.
    open()
    recordDraftPostingAs('draft-1', captured)
    expect(readPostingDraftTable(MAIN)[0].did).toBe(OTHER)
  })

  it('a restore sets the account without the reset: the draft’s own visibility and audience stand', async () => {
    open()
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'list', uri: audienceUri(OTHER)},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    choosePostingAccount(OTHER)
    await settle()
    recordDraftPostingAs('draft-1', captureDraftPostingAs())
    open()
    applyDraftPostingAs('draft-1')
    applyDraftVisibility('draft-1')
    // Private to that account's list, as saved, never widened to its defaults.
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'list', uri: audienceUri(OTHER)},
      locked: false,
    })
    expect(getPostingState().resetPending).toBe(false)
    expect(getPostingState().did).toBe(OTHER)
  })

  it('a member answered none for that account is dropped once the reads answer', async () => {
    open()
    choosePostingAccount(OTHER)
    await settle()
    updatePosting({members: [WREN]})
    recordDraftPostingAs('draft-1', captureDraftPostingAs())
    other.members.delete(WREN)
    open()
    applyDraftPostingAs('draft-1')
    await settle()
    expect(getPostingState().members).toEqual([])
    expect(postingFronters(undefined, OTHER)).toEqual([])
  })

  it('a draft written as an account not signed in here restores with Publish blocked', async () => {
    mockAccounts.push(storedAccount(STOCKY, STOCK_URL, 'stocky.test'))
    writeLocal(
      `horizon:draft-posting-as:${MAIN}`,
      JSON.stringify([
        {id: 'draft-1', did: STOCKY, handle: 'stocky.test', members: []},
      ]),
    )
    open()
    applyDraftPostingAs('draft-1')
    // A listed system account that needs a sign-in here (system accounts 8.3).
    expect(getPostingState().hold).toEqual({
      kind: 'signedOut',
      handle: 'stocky.test',
      reason: 'signIn',
    })
    expect(postingAllowsFor(getPostingState())).toBe(false)
    await settle()
    expect(postingAllowsFor(getPostingState())).toBe(false)
    // Choosing an account lifts it.
    choosePostingAccount(MAIN)
    await settle()
    expect(postingAllowsFor(getPostingState())).toBe(true)
  })

  it('a draft with no entry on this device starts as the current account, with its engaging members', async () => {
    open()
    choosePostingAccount(OTHER)
    await settle()
    expect(applyDraftPostingAs('draft-unknown')).toBe(MAIN)
    expect(getPostingState().did).toBe(MAIN)
    await settle()
    expect(getPostingState().members).toEqual([SPARROW])
  })
})

describe('reply lists of another account are dropped on restore (P5R3-L2, P5R4-L2)', () => {
  const ownList = {$type: LIST_RULE, list: listUri(MAIN) as AtUriString}
  const foreignList = {$type: LIST_RULE, list: listUri(OTHER) as AtUriString}

  it('the only rule another DID’s list: Nobody can reply (`[]`), with the note', () => {
    open()
    expect(dropForeignListRules(MAIN, [foreignList])).toEqual({
      allow: [],
      note: 'foreign-lists-nobody',
    })
    expect(restoredThreadgateAllow(MAIN, [foreignList])).toEqual([])
    expect(getPostingState().draftNote).toBe('foreign-lists-nobody')
  })

  it('that list and a mention rule: the mention rule only, with the note', () => {
    expect(dropForeignListRules(MAIN, [foreignList, MENTION_RULE])).toEqual({
      allow: [MENTION_RULE],
      note: 'foreign-lists',
    })
  })

  it('`allow` undefined restores as anyone, with no note; the posting account’s own list is kept', () => {
    expect(dropForeignListRules(MAIN, undefined)).toEqual({
      allow: undefined,
      note: undefined,
    })
    expect(dropForeignListRules(MAIN, [ownList])).toEqual({
      allow: [ownList],
      note: undefined,
    })
    // Restored as the list's own account, it stays.
    expect(dropForeignListRules(OTHER, [foreignList]).allow).toEqual([
      foreignList,
    ])
  })
})
