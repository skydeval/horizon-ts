import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Members skip the public-view pass (2026-10-25): with an answer served as
 * `member`, the reader's labels applied and the reader's mutes whole on the
 * device, a lens post whose prism view is whole renders from it, with the
 * device's mutes applied, and only the posts prism's view cannot stand for
 * go to `getPosts`. Visitors keep the pass.
 */

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))
jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))

import {moderatePost} from '@bsky/sdk/moderation'
import {type QueryClient} from '@tanstack/react-query'

import {muteCacheKey, resetMuteCache} from '#/horizon/mutes/cache'
import {resetThreadMuteResync} from '#/horizon/private/api/thread-mute'
import {
  clearCurrentClients,
  getCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {writeLocal} from '#/horizon/session/local-store'
import {resetLensRefusals, resetLensWaits} from '#/horizon/thread-lens/api'
import {installLensDirect, resetLensDirect} from '#/horizon/thread-lens/direct'
import {
  isEmbeddingUnchecked,
  resetEmbeddingUnchecked,
} from '#/horizon/thread-lens/embedding'
import {loadMoreLensReplies, runLens} from '#/horizon/thread-lens/fetch'
import {
  resetLensViewPool,
  warmPublicViews,
} from '#/horizon/thread-lens/public-views'
import {resetLensRegistry} from '#/horizon/thread-lens/registry'
import {
  lensQueryKey,
  type LensSnapshot,
  resetLensQueues,
  snapshotOf,
} from '#/horizon/thread-lens/snapshot'
import {LENS_TIMING_KEY} from '#/horizon/thread-lens/timing'
import {type app} from '#/lexicons'
import {
  type Call,
  fakeAppview,
  lensAnswer,
  MODERATION_OPTS,
  postNode,
  publishClients,
  READER,
  RECORD_CID,
  type Reply,
  server,
  until,
  uriOf,
  view,
} from './harness'

type PostView = app.bsky.feed.defs.PostView

const MINE = 'did:plc:minelabelerggggggggggggg' as const
const CONTENT = 'atproto-content-labelers'

/** An author the reader mutes directly. */
const MUTED = 'did:plc:mutedhhhhhhhhhhhhhhhhhhh'
/** An author on a mute list the reader subscribes to. */
const LISTED = 'did:plc:listediiiiiiiiiiiiiiiiii'
/** Someone the reader does not mute. */
const PLAIN = 'did:plc:plainjjjjjjjjjjjjjjjjjjj'

const SPAM_LIST = `at://${READER}/app.bsky.graph.list/3kspam2222222`

const ROOT = uriOf('3kroot2222222')
const ANCHOR = uriOf('3kanchor22222')

/** The reader's whole mute set, as `mutes/cache.ts` stores it. */
function seedMutes() {
  writeLocal(
    muteCacheKey(READER),
    JSON.stringify({
      v: 1,
      at: Date.now(),
      accounts: [MUTED],
      lists: [
        {
          list: {
            uri: SPAM_LIST,
            cid: RECORD_CID,
            name: 'Spam accounts',
            purpose: 'app.bsky.graph.defs#modlist',
          },
          members: [LISTED],
        },
      ],
    }),
  )
}

/** prism's member view of a post: counts, and `replyDisabled` decided. */
function hydrated(
  rkey: string,
  options: Parameters<typeof view>[1] = {},
): PostView {
  const base = view(rkey, options)
  return {
    ...base,
    viewer: {replyDisabled: false, ...base.viewer},
  }
}

let lensReply: (call: Call) => Reply
let posts: PostView[]
let appviewCalls: Call[]

function setup(): QueryClient {
  const prism = server(READER, call => lensReply(call))
  const appview = fakeAppview({posts})
  appview.client.setLabelers([MINE])
  appviewCalls = appview.calls
  return publishClients({prism: prism.client, appview: appview.client})
}

/**
 * A lens answer served as `servedAs` (`null`: no field), the reader's
 * labeler applied unless `labelled` is false.
 */
function answer(
  nodes: unknown[],
  servedAs: string | null = 'member',
  labelled = true,
): Reply {
  const reply = lensAnswer(ANCHOR, nodes)
  return {
    ...reply,
    body: {...reply.body, ...(servedAs !== null ? {servedAs} : {})},
    ...(labelled ? {headers: {[CONTENT]: MINE}} : {}),
  }
}

function lensKey() {
  return lensQueryKey({
    did: READER,
    anchor: ANCHOR,
    depth: 10,
    mode: 'lens',
    marked: false,
  })
}

async function load(
  qc: QueryClient,
  placeholder?: {value: unknown},
): Promise<LensSnapshot> {
  const key = lensKey()
  const run = await runLens(key, {
    qc,
    stockKey: ['post-thread-v2', {anchor: ANCHOR}],
    readWith: {sort: 'oldest', below: 10},
    placeholder,
  })
  const snapshot = snapshotOf(run.data)
  if (!snapshot) throw new Error('no snapshot')
  qc.setQueryData(key, run.data)
  return snapshot
}

function shown(snapshot: LensSnapshot, uri: string): PostView {
  const node = snapshot.nodes.get(uri)
  if (node?.kind !== 'post') throw new Error(`${uri} is not a post`)
  return node.view
}

/** Every URI the AppView was asked for with `getPosts`. */
function asked(): string[] {
  return appviewCalls
    .filter(call => call.nsid === 'app.bsky.feed.getPosts')
    .flatMap(call => call.params.getAll('uris'))
}

const REPLY_MUTED = uriOf('3kmuted222222', MUTED)
const REPLY_LISTED = uriOf('3klisted22222', LISTED)

/** A thread: root, anchor, a reply by a muted author and one by a listed one. */
function mutedThread() {
  const root = hydrated('3kroot2222222')
  const anchor = hydrated('3kanchor22222', {parent: ROOT})
  const muted = hydrated('3kmuted222222', {did: MUTED, parent: ANCHOR})
  const listed = hydrated('3klisted22222', {did: LISTED, parent: ANCHOR})
  return [root, anchor, muted, listed]
}

beforeEach(() => {
  posts = []
  lensReply = () => answer([])
  resetPrismHealth()
  resetPrismFeatures()
  resetLensWaits()
  resetLensRefusals()
  resetLensRegistry()
  resetLensQueues()
  resetLensViewPool()
  resetThreadMuteResync()
  resetLensDirect()
  resetMuteCache()
  resetEmbeddingUnchecked()
  writeLocal(muteCacheKey(READER), undefined)
  installLensDirect(undefined)
  answerPrismFeatures(READER, [
    'private',
    'threadLens',
    'threadLens.signedIn',
    'threadLens.hydrated',
    'threadLens.labelers',
  ])
})

afterEach(() => {
  installLensDirect(undefined)
  clearCurrentClients()
})

describe("the device's mutes on a member's lens posts", () => {
  it("a muted author's lens reply shows as muted", async () => {
    seedMutes()
    // The AppView's views would say nothing of the mute: only the device does.
    posts = mutedThread().map(post => ({...post, viewer: {}}))
    lensReply = () => answer(mutedThread().map(post => postNode(post)))
    const snapshot = await load(setup())
    const reply = shown(snapshot, REPLY_MUTED)
    expect(reply.author.viewer?.muted).toBe(true)
    expect(reply.author.viewer?.mutedByList).toBeUndefined()
    // Stock moderation hides it as on the stock thread.
    const decision = moderatePost(reply, MODERATION_OPTS)
    expect(decision.ui('contentList').filter).toBe(true)
    expect(decision.ui('contentList').filters[0]).toMatchObject({
      type: 'muted',
      source: {type: 'user'},
    })
    expect(shown(snapshot, ANCHOR).author.viewer?.muted).toBe(false)
    // No post went to the AppView.
    expect(asked()).toEqual([])
  })

  it('a mute-list member shows "Muted by <list>"', async () => {
    seedMutes()
    posts = mutedThread().map(post => ({...post, viewer: {}}))
    lensReply = () => answer(mutedThread().map(post => postNode(post)))
    const snapshot = await load(setup())
    const reply = shown(snapshot, REPLY_LISTED)
    expect(reply.author.viewer).toMatchObject({
      muted: true,
      mutedByList: {uri: SPAM_LIST, name: 'Spam accounts'},
    })
    const cause = moderatePost(reply, MODERATION_OPTS).ui('contentList')
      .filters[0]
    // The cause stock's `useModerationCauseDescription` words as
    // `Muted by "Spam accounts"`.
    expect(cause).toMatchObject({
      type: 'muted',
      source: {type: 'list', list: {name: 'Spam accounts'}},
    })
    expect(asked()).toEqual([])
  })

  it("replaces prism's mute state with the device's", async () => {
    seedMutes()
    const root = hydrated('3kroot2222222')
    const anchor = hydrated('3kanchor22222', {parent: ROOT})
    const plain = hydrated('3kplain222222', {
      did: PLAIN,
      parent: ANCHOR,
      // A mute made through prism once, since undone on Bluesky.
      authorViewer: {muted: true},
    })
    lensReply = () => answer([root, anchor, plain].map(post => postNode(post)))
    const snapshot = await load(setup())
    expect(shown(snapshot, plain.uri).author.viewer?.muted).toBe(false)
  })
})

describe('which posts skip the pass', () => {
  it('members skip it on safe posts and keep it on the rest', async () => {
    seedMutes()
    const root = hydrated('3kroot2222222')
    const anchor = hydrated('3kanchor22222', {parent: ROOT})
    // Edge 1: built from its record, no counts.
    const built = hydrated('3kbuilt222222', {parent: ANCHOR}) as Record<
      string,
      unknown
    >
    delete built.likeCount
    delete built.repostCount
    delete built.replyCount
    delete built.quoteCount
    // Edge 2: a record embed (the quoted post's labels are prism's only).
    const quoting = hydrated('3kquoting2222', {
      parent: ANCHOR,
      extra: {
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: {
            $type: 'app.bsky.embed.record#viewNotFound',
            uri: uriOf('3kgone2222222'),
            notFound: true,
          },
        },
      },
    })
    // prism could not decide `replyDisabled`.
    const ungated = {
      ...view('3kungated2222', {parent: ANCHOR}),
      viewer: {},
    } as PostView
    // A media embed is fine.
    const pictured = hydrated('3kpictured222', {
      parent: ANCHOR,
      extra: {
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: {uri: 'https://example.com', title: 't', description: 'd'},
        },
      },
    })
    const unsafe = [built as unknown as PostView, quoting, ungated]
    posts = unsafe.map(post => ({...post}))
    lensReply = () =>
      answer([root, anchor, ...unsafe, pictured].map(post => postNode(post)))
    const snapshot = await load(setup())
    expect(asked().sort()).toEqual(
      [
        uriOf('3kbuilt222222'),
        uriOf('3kquoting2222'),
        uriOf('3kungated2222'),
      ].sort(),
    )
    expect(snapshot.nodes.get(uriOf('3kpictured222'))?.kind).toBe('post')
  })

  it('keeps the pass for every post without a whole mute set on the device', async () => {
    const thread = mutedThread()
    posts = thread
    lensReply = () => answer(thread.map(post => postNode(post)))
    await load(setup())
    expect(asked().sort()).toEqual(thread.map(post => post.uri).sort())
  })

  it("keeps the pass when the reader's labels were not all applied", async () => {
    seedMutes()
    const thread = mutedThread()
    posts = thread
    lensReply = () =>
      answer(
        thread.map(post => postNode(post)),
        'member',
        false,
      )
    await load(setup())
    expect(asked().sort()).toEqual(thread.map(post => post.uri).sort())
  })

  it('visitors keep the pass', async () => {
    seedMutes()
    const thread = mutedThread()
    posts = thread.map(post => ({
      ...post,
      viewer: {like: `at://${READER}/app.bsky.feed.like/3klike1111111`},
    }))
    lensReply = () =>
      answer(
        thread.map(post => postNode(post)),
        'visitor',
      )
    const snapshot = await load(setup())
    expect(asked().sort()).toEqual(thread.map(post => post.uri).sort())
    // A visitor's viewer state is the AppView's.
    expect(shown(snapshot, ANCHOR).viewer?.like).toBe(
      `at://${READER}/app.bsky.feed.like/3klike1111111`,
    )
  })

  it('an answer that names no servedAs keeps the pass', async () => {
    seedMutes()
    const thread = mutedThread()
    posts = thread
    lensReply = () =>
      answer(
        thread.map(post => postNode(post)),
        null,
      )
    await load(setup())
    expect(asked()).toHaveLength(thread.length)
  })

  it("a continuation's posts skip it too", async () => {
    seedMutes()
    const thread = mutedThread()
    lensReply = () => answer(thread.map(post => postNode(post)))
    const qc = setup()
    await load(qc)
    const more = hydrated('3kmore2222222', {did: MUTED, parent: ANCHOR})
    lensReply = () => answer([postNode(more)])
    const key = lensKey()
    const queueId = qc.getQueryCache().find({queryKey: key})?.queryHash
    expect(
      loadMoreLensReplies(qc, queueId, {uri: ANCHOR, depth: 1, below: 10}),
    ).toBe(true)
    await until(
      () =>
        snapshotOf(qc.getQueryData(key))?.nodes.get(more.uri)?.kind === 'post',
    )
    const shownMore = shown(snapshotOf(qc.getQueryData(key))!, more.uri)
    expect(shownMore.author.viewer?.muted).toBe(true)
    expect(asked()).toEqual([])
  })
})

describe('what the pass gave that prism does not', () => {
  it('bookmarks come from the stock bookmarks cache', async () => {
    seedMutes()
    const thread = mutedThread()
    lensReply = () => answer(thread.map(post => postNode(post)))
    const qc = setup()
    qc.setQueryData(['bookmarks'], {
      pageParams: [undefined],
      pages: [{bookmarks: [{subject: {uri: REPLY_LISTED, cid: RECORD_CID}}]}],
    })
    const snapshot = await load(qc)
    expect(shown(snapshot, REPLY_LISTED).viewer?.bookmarked).toBe(true)
    expect(shown(snapshot, REPLY_MUTED).viewer?.bookmarked).toBeUndefined()
  })

  it('a post with no embeddingDisabled is noted for a check at quote time', async () => {
    seedMutes()
    const root = hydrated('3kroot2222222')
    const anchor = {
      ...hydrated('3kanchor22222', {parent: ROOT}),
      viewer: {replyDisabled: false, embeddingDisabled: true},
    } as PostView
    lensReply = () => answer([postNode(root), postNode(anchor)])
    const snapshot = await load(setup())
    expect(isEmbeddingUnchecked(ROOT)).toBe(true)
    expect(isEmbeddingUnchecked(ANCHOR)).toBe(false)
    expect(shown(snapshot, ANCHOR).viewer?.embeddingDisabled).toBe(true)
  })

  it('the anchor takes its early AppView view when it has already answered', async () => {
    seedMutes()
    const root = hydrated('3kroot2222222')
    const anchor = hydrated('3kanchor22222', {parent: ROOT})
    const publicAnchor = {
      ...view('3kanchor22222', {parent: ROOT}),
      viewer: {bookmarked: true, threadMuted: true},
    } as PostView
    posts = [publicAnchor]
    const qc = setup()
    warmPublicViews(getCurrentClients()!.appviewClient, READER, [ANCHOR])
    await until(() => asked().length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    lensReply = () => answer([postNode(root), postNode(anchor)])
    const snapshot = await load(qc)
    expect(shown(snapshot, ANCHOR).viewer).toMatchObject({
      bookmarked: true,
      threadMuted: true,
    })
    // Nothing more was asked: the root skipped the pass.
    expect(asked()).toEqual([ANCHOR])
  })
})

describe('the timing log (2026-10-26, Prism)', () => {
  let lines: string[]
  let restore: () => void

  beforeEach(() => {
    lines = []
    writeLocal(LENS_TIMING_KEY, '1')
    const spy = jest
      .spyOn(globalThis.console, 'info')
      .mockImplementation((line: unknown) => {
        lines.push(String(line))
      })
    restore = () => spy.mockRestore()
  })

  afterEach(() => {
    restore()
    writeLocal(LENS_TIMING_KEY, undefined)
  })

  it('says the member skip is on, and why each post kept the pass, as counts', async () => {
    seedMutes()
    const root = hydrated('3kroot2222222')
    const anchor = hydrated('3kanchor22222', {parent: ROOT})
    const built = hydrated('3kbuilt222222', {parent: ANCHOR}) as Record<
      string,
      unknown
    >
    delete built.likeCount
    const quoting = hydrated('3kquoting2222', {
      parent: ANCHOR,
      extra: {
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: {
            $type: 'app.bsky.embed.record#viewNotFound',
            uri: uriOf('3kgone2222222'),
            notFound: true,
          },
        },
      },
    })
    const ungated = {
      ...view('3kungated2222', {parent: ANCHOR}),
      viewer: {},
    } as PostView
    const unsafe = [built as unknown as PostView, quoting, ungated]
    posts = unsafe.map(post => ({...post}))
    lensReply = () =>
      answer([root, anchor, ...unsafe].map(post => postNode(post)))
    await load(setup())
    expect(lines).toContain('[thread lens timing] 3kanchor22222 member skip on')
    expect(lines).toContain(
      '[thread lens timing] 3kanchor22222 public pass: 5 posts, 2 skipped, ' +
        '3 to the pass (no counts 1, record embed 1, replyDisabled undecided 1), ' +
        '0 early, 3 fetched',
    )
    expect(
      lines.some(line =>
        line.startsWith('[thread lens timing] 3kanchor22222 snapshot built: '),
      ),
    ).toBe(true)
    // Record keys only: never a DID or an AT-URI.
    expect(lines.some(line => /did:|at:\/\//.test(line))).toBe(false)
  })

  it('names the gate that kept the skip off', async () => {
    const thread = mutedThread()
    posts = thread
    lensReply = () => answer(thread.map(post => postNode(post)))
    await load(setup())
    expect(lines).toContain(
      '[thread lens timing] 3kanchor22222 member skip off: ' +
        'mutes not whole on the device (none stored)',
    )
    expect(lines).toContain(
      '[thread lens timing] 3kanchor22222 public pass: 4 posts, 0 skipped, ' +
        '4 to the pass (no hydration 4), 0 early, 4 fetched',
    )
  })

  it('names a visitor answer', async () => {
    seedMutes()
    const thread = mutedThread()
    posts = thread
    lensReply = () =>
      answer(
        thread.map(post => postNode(post)),
        'visitor',
      )
    await load(setup())
    expect(lines).toContain(
      '[thread lens timing] 3kanchor22222 member skip off: served as visitor',
    )
  })
})

describe("prism's embedWhole on quote posts (2026-10-26)", () => {
  /** A quote card of a post by `author`. */
  function quoteOf(author: string) {
    return {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: uriOf('3kquoted22222', author),
      cid: RECORD_CID,
      author: {did: author, handle: 'quoted.test', viewer: {muted: false}},
      value: {$type: 'app.bsky.feed.post', text: 'q', createdAt: 'x'},
      indexedAt: '2026-10-26T00:00:00.000Z',
    }
  }

  function quoting(
    rkey: string,
    embed: Record<string, unknown>,
    viewer: Record<string, unknown> = {replyDisabled: false},
  ): PostView {
    const base = view(rkey, {parent: ANCHOR, extra: {embed}})
    return {...base, viewer: {...base.viewer, ...viewer}}
  }

  it('a marked quote skips the pass, with the device`s mute on the quoted author; an unmarked one keeps it', async () => {
    seedMutes()
    const root = hydrated('3kroot2222222')
    const anchor = hydrated('3kanchor22222', {parent: ROOT})
    const marked = quoting('3kmarked22222', {
      $type: 'app.bsky.embed.record#view',
      record: quoteOf(MUTED),
    })
    const withMedia = quoting('3kmedia222222', {
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: {$type: 'app.bsky.embed.record#view', record: quoteOf(LISTED)},
      media: {$type: 'app.bsky.embed.images#view', images: []},
    })
    const unmarked = quoting('3kunmarked222', {
      $type: 'app.bsky.embed.record#view',
      record: quoteOf(PLAIN),
    })
    posts = [unmarked]
    lensReply = () =>
      answer([
        postNode(root),
        postNode(anchor),
        postNode(marked, {embedWhole: true}),
        postNode(withMedia, {embedWhole: true}),
        postNode(unmarked),
      ])
    const snapshot = await load(setup())
    expect(asked()).toEqual([unmarked.uri])
    const quoted = (
      shown(snapshot, marked.uri).embed as {
        record: {author: {viewer: {muted: boolean}}}
      }
    ).record
    expect(quoted.author.viewer.muted).toBe(true)
    const nested = (
      shown(snapshot, withMedia.uri).embed as {
        record: {record: {author: {viewer: Record<string, unknown>}}}
      }
    ).record.record
    expect(nested.author.viewer).toMatchObject({
      muted: true,
      mutedByList: {uri: SPAM_LIST},
    })
  })

  it('the mark skips only the record-embed rule: replyDisabled undecided and unknown media still go to the pass', async () => {
    seedMutes()
    const root = hydrated('3kroot2222222')
    const anchor = hydrated('3kanchor22222', {parent: ROOT})
    const undecided = quoting(
      '3kundecided22',
      {$type: 'app.bsky.embed.record#view', record: quoteOf(PLAIN)},
      {},
    )
    const oddMedia = quoting('3koddmedia222', {
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: {$type: 'app.bsky.embed.record#view', record: quoteOf(PLAIN)},
      media: {$type: 'app.bsky.embed.somethingNew#view'},
    })
    posts = [undecided, oddMedia]
    lensReply = () =>
      answer([
        postNode(root),
        postNode(anchor),
        postNode(undecided, {embedWhole: true}),
        postNode(oddMedia, {embedWhole: true}),
      ])
    await load(setup())
    expect(asked().sort()).toEqual([undecided.uri, oddMedia.uri].sort())
  })

  it('takes the mark only when it is exactly true', async () => {
    seedMutes()
    const root = hydrated('3kroot2222222')
    const anchor = hydrated('3kanchor22222', {parent: ROOT})
    const truthy = quoting('3ktruthy22222', {
      $type: 'app.bsky.embed.record#view',
      record: quoteOf(PLAIN),
    })
    posts = [truthy]
    lensReply = () =>
      answer([
        postNode(root),
        postNode(anchor),
        postNode(truthy, {embedWhole: 'yes'}),
      ])
    await load(setup())
    expect(asked()).toEqual([truthy.uri])
  })
})
