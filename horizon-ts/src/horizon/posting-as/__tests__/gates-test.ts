import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * Phase 5 design 8.2, B-25 (section 13 "Gates", "Switching account keeps
 * Public or Private", "Publish waits for the posting account", "Fronters
 * fail closed"): the reset on an account picked in the "Posting as"
 * control, the hold, the member selection and `assertOwnGates`, against
 * fake PDSes. The temporary client is replaced by the fake account's
 * client, registered for identity reads exactly as the real one is.
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
const mockTemps = new Map<
  string,
  {
    did: string
    handle: string
    pdsClient: unknown
    appviewClient: unknown
    chatClient: unknown
    prismClient: unknown
  }
>()
const mockReleased: string[] = []
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
    releaseTemporaryClient: (did: string) => mockReleased.push(did),
    holdTemporaryClientUntil: () => {},
  }
})

import {i18n} from '@lingui/core'

import {
  type ComposerAction,
  type ThreadDraft,
} from '#/view/com/composer/state/composer'
import {identityQueryKey} from '#/horizon/identity/queries'
import {
  registerOwnIdentityClient,
  resetIdentityReads,
} from '#/horizon/identity/reads'
import {
  privateComposeAllows,
  privateComposeBlocker,
} from '#/horizon/private/composer/blockers'
import {
  applyLateComposeDefaults,
  chooseComposeVisibility,
  getComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
  startComposeVisibility,
} from '#/horizon/private/composer/state'
import {currentRoutes, resetWriteRoutes} from '#/horizon/routing/write-route'
import {
  getPostingState,
  postingAllowsFor,
  resetPostingRecord,
} from '../compose-store'
import {postingFronters} from '../fronters'
import {
  assertOwnGates,
  choosePostingAccount,
  endPostingSession,
  ForeignAudienceError,
  ForeignReplyListError,
  postingInteractionSettings,
  postingVideoRefusal,
  registerPostingComposer,
  retryPostingReads,
  setPostingHasVideo,
  startPostingSession,
  togglePostingMember,
} from '../gates'
import {setPostingNotifier} from '../notify'
import {postingRoutesFor} from '../routes'
import {
  audienceUri,
  callsOf,
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
  STRANGER,
  WREN,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const CLOSE_FRIENDS = audienceUri(MAIN)
const thread = {
  posts: [
    {
      id: 'p',
      richtext: {text: 'hello'},
      labels: [],
      embed: {quote: undefined, media: undefined, link: undefined},
      shortenedGraphemeLength: 5,
    },
  ],
  postgate: {},
  threadgate: [{type: 'everybody'}],
} as unknown as ThreadDraft

let main: FakeAccount
let other: FakeAccount
let dispatched: ComposerAction[]
let notices: string[]

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

/** The composer's `canPost` term, as Composer.tsx builds it (PA-9). */
function canPostTerm() {
  const s = getPostingState()
  const routes = postingRoutesFor(s.did, s.currentDid, currentRoutes())
  const visibility = getComposeVisibility()
  return (
    privateComposeAllows(
      thread,
      visibility.visibility === 'private',
      routes,
      visibility.audience,
    ) && postingAllowsFor(s)
  )
}

function open() {
  startComposeVisibility(PUBLIC_COMPOSE)
  startPostingSession(MAIN, 'main.test')
  registerPostingComposer({
    dispatch: action => dispatched.push(action),
    replyTo: undefined,
  })
}

beforeEach(() => {
  resetIdentityReads()
  resetWriteRoutes()
  resetPostingRecord()
  mockTemps.clear()
  mockReleased.length = 0
  mockAccounts.length = 0
  mockAccounts.push(
    storedAccount(MAIN, LOCUS_URL, 'main.test'),
    storedAccount(OTHER, LOCUS_URL, 'other.test'),
    storedAccount(STOCKY, STOCK_URL, 'stocky.test'),
  )
  dispatched = []
  notices = []
  setPostingNotifier(message => notices.push(message))
  main = fakeAccount(MAIN, {
    system: true,
    members: [
      {rkey: WREN, name: 'Wren'},
      {rkey: SPARROW, name: 'Sparrow'},
    ],
    engaging: [WREN],
    replyRules: [],
  })
  other = fakeAccount(OTHER, {
    replyRules: [{$type: 'app.bsky.feed.threadgate#followerRule'}],
  })
  publishCurrent(main, LOCUS_URL, 'main.test')
  useTemp(other, 'other.test')
  setComposeVisibility(PUBLIC_COMPOSE)
})

describe('switching account keeps Public or Private (P5R5-L1, Q1)', () => {
  it('Private, switch: still Private, audience unpicked (switch), the note names @other, Post off until a pick', async () => {
    open()
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'list', uri: CLOSE_FRIENDS},
      locked: false,
    })
    expect(canPostTerm()).toBe(true)
    choosePostingAccount(OTHER)
    // At once, before any read lands.
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'switch'},
      locked: false,
    })
    expect(canPostTerm()).toBe(false)
    await settle()
    expect(getPostingState().resetPending).toBe(false)
    expect(getComposeVisibility().audience).toEqual({
      kind: 'unpicked',
      why: 'switch',
    })
    // Still off once the hold lifted: only the user's pick enables it.
    expect(postingAllowsFor(getPostingState())).toBe(true)
    expect(canPostTerm()).toBe(false)
    const routes = postingRoutesFor(OTHER, MAIN, currentRoutes())
    expect(
      privateComposeBlocker(
        thread,
        routes,
        getComposeVisibility().audience,
        getPostingState().handle,
      ),
    ).toBe(
      'Choose an audience for @other.test. Audiences belong to the account that posts.',
    )
    chooseComposeVisibility({audience: {kind: 'mode', mode: 'followers'}})
    expect(canPostTerm()).toBe(true)
  })

  it('Public, switch: still Public and posts with no pick, but holds no audience for a flip (P5R6-Q1)', async () => {
    open()
    // The main account's own "Default audience".
    setComposeVisibility({
      visibility: 'public',
      audience: {kind: 'list', uri: CLOSE_FRIENDS},
      locked: false,
    })
    choosePostingAccount(OTHER)
    // Before the other account's reads land, the held audience is already unpicked.
    expect(getComposeVisibility()).toEqual({
      visibility: 'public',
      audience: {kind: 'unpicked', why: 'switch'},
      locked: false,
    })
    await settle()
    expect(canPostTerm()).toBe(true)
    chooseComposeVisibility({visibility: 'private'})
    expect(getComposeVisibility().audience).toEqual({
      kind: 'unpicked',
      why: 'switch',
    })
    expect(canPostTerm()).toBe(false)
  })

  it('the current account’s defaults arriving late never land after a switch', async () => {
    open()
    choosePostingAccount(OTHER)
    applyLateComposeDefaults(undefined, {
      startAs: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
    } as never)
    expect(getComposeVisibility()).toEqual({
      visibility: 'public',
      audience: {kind: 'unpicked', why: 'switch'},
      locked: false,
    })
    await settle()
  })

  it('back to the current account: the same rule, Private with no audience chosen', async () => {
    open()
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'list', uri: CLOSE_FRIENDS},
      locked: false,
    })
    choosePostingAccount(OTHER)
    await settle()
    chooseComposeVisibility({audience: {kind: 'mode', mode: 'followers'}})
    choosePostingAccount(MAIN)
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'switch'},
      locked: false,
    })
    await settle()
    expect(canPostTerm()).toBe(false)
    expect(mockReleased).toContain(OTHER)
  })

  it('a locked kryphocron reply keeps its parent audience and posts with no pick', async () => {
    open()
    const locked = {
      visibility: 'private' as const,
      audience: {kind: 'parent' as const, uri: audienceUri(STRANGER)},
      locked: true,
    }
    setComposeVisibility(locked)
    choosePostingAccount(OTHER)
    expect(getComposeVisibility()).toEqual(locked)
    await settle()
    expect(canPostTerm()).toBe(true)
  })

  it('a compose never switched still starts from its own account’s "Default audience"', () => {
    open()
    startComposeVisibility(PUBLIC_COMPOSE)
    applyLateComposeDefaults(undefined, {
      startAs: 'public',
      audience: {kind: 'list', uri: CLOSE_FRIENDS},
    } as never)
    chooseComposeVisibility({visibility: 'private'})
    expect(getComposeVisibility().audience).toEqual({
      kind: 'list',
      uri: CLOSE_FRIENDS,
    })
  })
})

describe('the reset of gates (P5R1-B2, P5R3-L1)', () => {
  it('sets the threadgate and postgate from the chosen account’s own settings, read with its client', async () => {
    open()
    choosePostingAccount(OTHER)
    expect(dispatched).toEqual([])
    await settle()
    expect(dispatched).toEqual([
      {type: 'update_threadgate', threadgate: [{type: 'followers'}]},
      expect.objectContaining({type: 'update_postgate'}),
    ])
    expect(
      other.calls.some(call => call.nsid === 'app.bsky.actor.getPreferences'),
    ).toBe(true)
    expect(
      main.calls.some(call => call.nsid === 'app.bsky.actor.getPreferences'),
    ).toBe(false)
    // A read writes nothing into the other account's preferences (no saved
    // feed minted on a shared clock, PP-21).
    expect(callsOf(other, 'app.bsky.actor.putPreferences')).toEqual([])
    expect(postingInteractionSettings(undefined)).toEqual({
      threadgateAllowRules: [{$type: 'app.bsky.feed.threadgate#followerRule'}],
      postgateEmbeddingRules: [],
    })
  })

  it('Publish waits while the chosen account’s settings are pending, and nothing is dispatched before they land', async () => {
    let release: () => void = () => {}
    other.fail = call =>
      call.nsid === 'app.bsky.actor.getPreferences'
        ? new Promise(resolve => {
            release = () => resolve(undefined)
          })
        : undefined
    open()
    choosePostingAccount(OTHER)
    await settle()
    expect(getPostingState().hold.kind).toBe('pending')
    expect(canPostTerm()).toBe(false)
    expect(dispatched).toEqual([])
    expect(callsOf(other, 'app.bsky.actor.getPreferences')).toHaveLength(1)
    release()
    await settle()
    expect(getPostingState().hold.kind).toBe('none')
    expect(canPostTerm()).toBe(true)
  })

  it('a failed read blocks with Try again, never falls back to the current account, and Try again reads again', async () => {
    other.fail = () => ({status: 500, body: {error: 'InternalServerError'}})
    open()
    choosePostingAccount(OTHER)
    await settle()
    expect(getPostingState().hold.kind).toBe('failed')
    expect(getPostingState().resetPending).toBe(true)
    expect(canPostTerm()).toBe(false)
    expect(dispatched).toEqual([])
    // Nothing was read as the current account in its place.
    expect(
      main.calls.some(call => call.nsid === 'app.bsky.actor.getPreferences'),
    ).toBe(false)
    other.fail = undefined
    retryPostingReads()
    expect(getPostingState().hold.kind).toBe('pending')
    await settle()
    expect(getPostingState().hold.kind).toBe('none')
    expect(getPostingState().resetPending).toBe(false)
    expect(canPostTerm()).toBe(true)
  })

  it('a failing member read holds Publish the same way', async () => {
    other = fakeAccount(OTHER, {
      system: true,
      members: [{rkey: WREN, name: 'W'}],
    })
    other.fail = call =>
      call.nsid === 'com.atproto.repo.listRecords'
        ? {status: 500, body: {error: 'InternalServerError'}}
        : undefined
    useTemp(other, 'other.test')
    open()
    choosePostingAccount(OTHER)
    await settle()
    expect(getPostingState().hold.kind).toBe('failed')
    expect(canPostTerm()).toBe(false)
  })

  it('an account that cannot be made a client keeps the previous choice', () => {
    open()
    choosePostingAccount(STOCKY)
    expect(getPostingState().did).toBe(MAIN)
    expect(notices).toEqual(['That account isn’t signed in on this device.'])
  })
})

describe('members (P5R2-L4, 8.1)', () => {
  it('the current account starts on its engaging members, read from its own PDS', async () => {
    open()
    await settle()
    expect(getPostingState().members).toEqual([WREN])
    expect(postingFronters(undefined, MAIN)).toEqual([WREN])
  })

  it('an account change clears the selection; a member checked under one account never reaches the other', async () => {
    const queryClient = publishCurrent(main, LOCUS_URL, 'main.test')
    open()
    await settle()
    expect(togglePostingMember(SPARROW)).toBe(true)
    expect(getPostingState().members).toEqual([WREN, SPARROW])
    choosePostingAccount(OTHER)
    expect(getPostingState().members).toEqual([])
    // Held while the reset is pending: no pick lands.
    expect(togglePostingMember(WREN)).toBe(false)
    await settle()
    expect(getPostingState().members).toEqual([])
    expect(postingFronters(queryClient, OTHER)).toEqual([])
    // The main account's members are never written as the other's.
    expect(postingFronters(queryClient, MAIN)).toEqual([])
  })

  it('a member not read for the posting account, or answered none since, is not written', async () => {
    const queryClient = publishCurrent(main, LOCUS_URL, 'main.test')
    open()
    await settle()
    expect(togglePostingMember('3zzzzzzzzzz2a')).toBe(false)
    togglePostingMember(SPARROW)
    queryClient.setQueryData(
      identityQueryKey('member', {did: MAIN, rkey: SPARROW}),
      {kind: 'none'},
    )
    expect(postingFronters(queryClient, MAIN)).toEqual([WREN])
  })

  it('no more than 20 members can be chosen', async () => {
    const many = Array.from({length: 21}, (_x, n) => ({
      rkey: `3m4kq${String(n).padStart(2, '0')}aaaaaa`.slice(0, 13),
      name: `M${n}`,
    }))
    main = fakeAccount(MAIN, {system: true, members: many, replyRules: []})
    publishCurrent(main, LOCUS_URL, 'main.test')
    open()
    await settle()
    for (const member of many) togglePostingMember(member.rkey)
    expect(getPostingState().members).toHaveLength(20)
  })
})

describe('the video limit (8.5, PA-11)', () => {
  it('with a video attached another account cannot be chosen; with one chosen a video is refused', async () => {
    open()
    setPostingHasVideo(true)
    choosePostingAccount(OTHER)
    expect(getPostingState().did).toBe(MAIN)
    expect(postingVideoRefusal()).toBeUndefined()
    setPostingHasVideo(false)
    choosePostingAccount(OTHER)
    await settle()
    expect(postingVideoRefusal()).toBe('Switch to @other.test to post a video')
  })
})

describe('the reply checks for the chosen account (8.2, 8.5)', () => {
  it('a private reply whose parent the chosen account cannot read refuses the choice and keeps the previous one', async () => {
    const parent = `at://${STRANGER}/tools.kryphocron.feed.postPrivate/3kparent2222`
    other.fail = call =>
      call.nsid === 'app.nearhorizon.private.getPosts'
        ? {status: 200, body: {posts: []}}
        : undefined
    open()
    registerPostingComposer({
      dispatch: action => dispatched.push(action),
      replyTo: parent,
    })
    choosePostingAccount(OTHER)
    await settle()
    expect(notices).toEqual(['That account can’t see this post.'])
    expect(getPostingState().did).toBe(MAIN)
  })

  it('a public reply the chosen account cannot reply to (blocked or gated) is refused', async () => {
    const parent = `at://${STRANGER}/app.bsky.feed.post/3kparent2222`
    other.fail = call =>
      call.nsid === 'app.bsky.feed.getPosts'
        ? {
            status: 200,
            body: {
              posts: [
                {
                  uri: parent,
                  cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
                  author: {did: STRANGER, handle: 'stranger.test'},
                  record: {},
                  indexedAt: '2026-10-01T00:00:00.000Z',
                  viewer: {replyDisabled: true},
                },
              ],
            },
          }
        : undefined
    open()
    registerPostingComposer({
      dispatch: action => dispatched.push(action),
      replyTo: parent,
    })
    choosePostingAccount(OTHER)
    await settle()
    expect(notices).toEqual(['That account can’t reply to this post.'])
    expect(getPostingState().did).toBe(MAIN)
  })
})

describe('assertOwnGates (P5R2-L3)', () => {
  const stored = [MAIN, OTHER, STOCKY]
  const PUBLIC = {
    visibility: 'public' as const,
    audience: PUBLIC_COMPOSE.audience,
  }

  it('refuses a reply-list rule of another of the user’s accounts', () => {
    expect(() =>
      assertOwnGates(
        OTHER,
        {threadgate: [{type: 'list', list: listUri(MAIN)}]},
        PUBLIC,
        stored,
      ),
    ).toThrow(ForeignReplyListError)
    expect(() =>
      assertOwnGates(
        OTHER,
        {threadgate: [{type: 'list', list: listUri(MAIN)}]},
        PUBLIC,
        stored,
      ),
    ).toThrow(
      'These reply settings use a list from another of your accounts. Choose them again.',
    )
  })

  it('refuses a Private list audience of another of the user’s accounts', () => {
    expect(() =>
      assertOwnGates(
        OTHER,
        {threadgate: []},
        {
          visibility: 'private',
          audience: {kind: 'list', uri: audienceUri(MAIN)},
        },
        stored,
      ),
    ).toThrow(ForeignAudienceError)
  })

  it('passes the posting account’s own lists, a stranger’s, and a parent audience', () => {
    expect(() =>
      assertOwnGates(
        OTHER,
        {
          threadgate: [
            {type: 'list', list: listUri(OTHER)},
            {type: 'list', list: listUri(STRANGER)},
          ],
        },
        {
          visibility: 'private',
          audience: {kind: 'list', uri: audienceUri(OTHER)},
        },
        stored,
      ),
    ).not.toThrow()
    // A kryphocron reply in another author's thread, as either account.
    for (const did of [MAIN, OTHER]) {
      expect(() =>
        assertOwnGates(
          did,
          {threadgate: []},
          {
            visibility: 'private',
            audience: {kind: 'parent', uri: audienceUri(MAIN)},
          },
          stored,
        ),
      ).not.toThrow()
    }
  })
})

describe('the compose session', () => {
  it('ending it lets the temporary client go and clears the choice', async () => {
    open()
    choosePostingAccount(OTHER)
    await settle()
    endPostingSession()
    expect(mockReleased).toContain(OTHER)
    expect(getPostingState().active).toBe(false)
    expect(postingFronters(undefined, OTHER)).toEqual([])
  })
})
