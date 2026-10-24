import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The reader's labelers on the lens calls (prism `threadLens.labelers`,
 * #887): the header on `getThread` and `resolve`, direct and proxied, only
 * with the feature listed; the labels the views take from the lens answer;
 * why the public-view pass still runs for members and visitors; and prism's
 * edge cases.
 */

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did,
}))
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))
jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))

import {Client} from '@atproto/lex'
import {moderatePost} from '@bsky/sdk/moderation'
import {type QueryClient} from '@tanstack/react-query'

import {createLexClient} from '#/lib/lexClient'
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
import {
  gapInfoOf,
  type LensSelected,
  selectLensAnswer,
} from '#/horizon/thread-lens/adapt'
import {
  getLensThread,
  resetLensRefusals,
  resetLensWaits,
  resolveLens,
} from '#/horizon/thread-lens/api'
import {installLensDirect, resetLensDirect} from '#/horizon/thread-lens/direct'
import {isRetryableLensGap, runLens} from '#/horizon/thread-lens/fetch'
import {
  lensLabelsApplied,
  stockLabelersHeader,
} from '#/horizon/thread-lens/labelers'
import {resetLensViewPool} from '#/horizon/thread-lens/public-views'
import {resetLensRegistry} from '#/horizon/thread-lens/registry'
import {
  lensQueryKey,
  type LensSnapshot,
  resetLensQueues,
  snapshotOf,
} from '#/horizon/thread-lens/snapshot'
import {GAP_TEXT} from '#/horizon/thread-lens/strings'
import {type app} from '#/lexicons'
import {
  type Call,
  fakeAppview,
  gapNode,
  lensAnswer,
  MODERATION_OPTS,
  postNode,
  publishClients,
  READER,
  type Reply,
  server,
  uriOf,
  view,
} from './harness'

type PostView = app.bsky.feed.defs.PostView

const GET_THREAD = 'app.nearhorizon.threadLens.getThread'
const RESOLVE = 'app.nearhorizon.threadLens.resolve'
const ACCEPT = 'atproto-accept-labelers'
const CONTENT = 'atproto-content-labelers'

/** A labeler the reader subscribes to. */
const MINE = 'did:plc:minelabelerggggggggggggg' as const
/** Another one. */
const WHIMSY = 'did:plc:whimsylabelerhhhhhhhhhh' as const
/** prism's own labeler. */
const PRISM_LABELER = 'did:web:prism.nearhorizon.app'

const ROOT = uriOf('3kroot2222222')
const ANCHOR = uriOf('3kanchor22222')
const STRIPPED = uriOf('3kstripped222')

/** A label from `src` on `uri`. */
function label(src: string, uri: string, val: string) {
  return {src, uri, val, cts: '2026-10-24T00:00:00.000Z'}
}

/** The reader's moderation options, subscribed to `MINE`. */
const OPTS = {
  ...MODERATION_OPTS,
  prefs: {
    ...MODERATION_OPTS.prefs,
    labelers: [{did: MINE, labels: {}}],
  },
}

let lensReply: (call: Call) => Reply
let posts: PostView[]
let prismCalls: Call[]
let appviewCalls: Call[]
let appviewClient: Client

/** Publish the reader with a fake prism and AppView subscribed to two labelers. */
function setup(): QueryClient {
  const prism = server(READER, call => lensReply(call))
  const appview = fakeAppview({posts})
  appview.client.setLabelers([MINE, WHIMSY])
  prismCalls = prism.calls
  appviewCalls = appview.calls
  appviewClient = appview.client
  return publishClients({prism: prism.client, appview: appview.client})
}

function listFeature(listed: boolean) {
  answerPrismFeatures(READER, [
    'private',
    'threadLens',
    'threadLens.signedIn',
    'threadLens.hydrated',
    ...(listed ? ['threadLens.labelers'] : []),
  ])
}

/** A lens answer whose response names `applied` in its header. */
function labelled(
  nodes: unknown[],
  applied: string | undefined = `${MINE}, ${WHIMSY}`,
  extra: Record<string, unknown> = {},
): Reply {
  const answer = lensAnswer(ANCHOR, nodes)
  return {
    ...answer,
    body: {...answer.body, ...extra},
    ...(applied ? {headers: {[CONTENT]: applied}} : {}),
  }
}

async function load(qc: QueryClient): Promise<LensSnapshot> {
  const key = lensQueryKey({
    did: READER,
    anchor: ANCHOR,
    depth: 10,
    mode: 'lens',
    marked: false,
  })
  const run = await runLens(key, {
    qc,
    stockKey: ['post-thread-v2', {anchor: ANCHOR}],
    readWith: {sort: 'oldest', below: 10},
  })
  const snapshot = snapshotOf(run.data)
  if (!snapshot) throw new Error('no snapshot')
  return snapshot
}

function shown(snapshot: LensSnapshot, uri: string): PostView {
  const node = snapshot.nodes.get(uri)
  if (node?.kind !== 'post') throw new Error(`${uri} is not a post`)
  return node.view
}

function vals(labels: unknown): string[] {
  return ((labels as {val: string}[] | undefined) ?? []).map(l => l.val)
}

function lensCalls() {
  return prismCalls.filter(
    call => call.nsid === GET_THREAD || call.nsid === RESOLVE,
  )
}

beforeEach(() => {
  posts = []
  lensReply = () => labelled([])
  resetPrismHealth()
  resetPrismFeatures()
  resetLensWaits()
  resetLensRefusals()
  resetLensRegistry()
  resetLensQueues()
  resetLensViewPool()
  resetThreadMuteResync()
  resetLensDirect()
  installLensDirect(undefined)
})

afterEach(() => {
  installLensDirect(undefined)
  clearCurrentClients()
})

describe('the header value', () => {
  it('is what the stock reads send: app labelers with ;redact, then subscriptions', () => {
    const client = createLexClient(
      {
        did: READER,
        fetchHandler: () => Promise.resolve(new Response('{}')),
      },
      {appLabelers: ['did:plc:moderationiiiiiiiiiiiii']},
    )
    client.setLabelers([MINE])
    expect(stockLabelersHeader(client)).toBe(
      `did:plc:moderationiiiiiiiiiiiii;redact, ${MINE}`,
    )
  })

  it('reads the class-wide app labelers when the client sets none', () => {
    const before = Client.appLabelers
    Client.configure({appLabelers: ['did:plc:moderationiiiiiiiiiiiii']})
    try {
      const client = createLexClient({
        did: READER,
        fetchHandler: () => Promise.resolve(new Response('{}')),
      })
      expect(stockLabelersHeader(client)).toBe(
        'did:plc:moderationiiiiiiiiiiiii;redact',
      )
    } finally {
      Client.appLabelers = before
    }
  })

  it('counts the answer labelled only when it names every labeler sent', () => {
    const sent = `did:plc:moderationiiiiiiiiiiiii;redact, ${MINE}`
    expect(
      lensLabelsApplied(
        sent,
        `${MINE}, did:plc:moderationiiiiiiiiiiiii;redact`,
      ),
    ).toBe(true)
    expect(lensLabelsApplied(sent, MINE)).toBe(false)
    expect(lensLabelsApplied(sent, null)).toBe(false)
    expect(lensLabelsApplied(undefined, MINE)).toBe(false)
    expect(lensLabelsApplied(sent, 'not a did, also-not')).toBe(false)
  })
})

describe('the header on the lens calls', () => {
  it('is sent on getThread and resolve, through the proxy, when the feature is listed', async () => {
    listFeature(true)
    setup()
    lensReply = call =>
      call.nsid === RESOLVE
        ? {status: 200, body: {items: [], bridging: 'full'}}
        : labelled([])
    const proxy = getCurrentClients()!.prismClient
    await getLensThread(proxy, READER, {anchor: ANCHOR})
    await resolveLens(proxy, READER, [ANCHOR])
    const calls = lensCalls()
    expect(calls.map(call => call.nsid)).toEqual([GET_THREAD, RESOLVE])
    for (const call of calls) {
      expect(call.headers.get(ACCEPT)).toBe(`${MINE}, ${WHIMSY}`)
      expect(call.headers.get(ACCEPT)).toBe(stockLabelersHeader(appviewClient))
      // Only the labeler list: no identity header beside it.
      expect(call.headers.get('authorization')).toBeNull()
      expect(call.headers.get('x-atproto-device-id')).toBeNull()
    }
  })

  it('is sent on the direct call too', async () => {
    listFeature(true)
    setup()
    const direct = server(READER, () => labelled([]))
    installLensDirect({
      token: () => Promise.resolve('token'),
      client: () => direct.client,
      limitedUntil: () => undefined,
    })
    const answer = await getLensThread(
      getCurrentClients()!.prismClient,
      READER,
      {anchor: ANCHOR},
    )
    expect(direct.calls).toHaveLength(1)
    expect(lensCalls()).toHaveLength(0)
    expect(direct.calls[0].headers.get(ACCEPT)).toBe(`${MINE}, ${WHIMSY}`)
    expect(answer.readerLabels).toBe(true)
  })

  it('is not sent when the feature is not listed', async () => {
    listFeature(false)
    const qc = setup()
    posts = [view('3kanchor22222')]
    lensReply = () => labelled([postNode(view('3kanchor22222'))])
    await load(qc)
    expect(lensCalls()).toHaveLength(1)
    expect(lensCalls()[0].headers.get(ACCEPT)).toBeNull()
  })

  it('is not sent for a call of an account that is not current', async () => {
    listFeature(true)
    answerPrismFeatures('did:plc:otherreaderbbbbbbbbbbbbb', [
      'threadLens',
      'threadLens.labelers',
    ])
    setup()
    const other = server('did:plc:otherreaderbbbbbbbbbbbbb', () => labelled([]))
    const answer = await getLensThread(
      other.client,
      'did:plc:otherreaderbbbbbbbbbbbbb',
      {anchor: ANCHOR},
    )
    expect(other.calls[0].headers.get(ACCEPT)).toBeNull()
    expect(answer.readerLabels).toBe(false)
  })
})

describe('labels from the lens answer', () => {
  /** prism's anchor: its own label and the reader's labeler's. */
  function prismAnchor(extra: Record<string, unknown> = {}) {
    const anchor = view('3kanchor22222', {parent: ROOT, likeCount: 3})
    return {
      ...anchor,
      labels: [
        label(PRISM_LABELER, ANCHOR, 'prism-own'),
        label(MINE, ANCHOR, '!warn'),
      ],
      author: {
        ...anchor.author,
        labels: [label(WHIMSY, anchor.author.did, 'whimsy')],
      },
      ...extra,
    } as PostView
  }

  it('takes the answer labels, and the pass makes one getPosts and no labels call', async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    // The AppView's view: no labels at all (or other ones).
    posts = [root, view('3kanchor22222', {parent: ROOT, likeCount: 9})]
    lensReply = () => labelled([postNode(root), postNode(prismAnchor())])
    const qc = setup()
    const snapshot = await load(qc)
    const anchor = shown(snapshot, ANCHOR)
    expect(vals(anchor.labels)).toEqual(['prism-own', '!warn'])
    expect(vals(anchor.author.labels)).toEqual(['whimsy'])
    // The rest of the view is still the pass's (TL-5).
    expect(anchor.likeCount).toBe(9)
    // The reader's labeler's warning applies through stock moderation.
    expect(moderatePost(anchor, OPTS).ui('contentView').blur).toBe(true)
    // The AppView is asked once, for the views; nothing asks for labels.
    expect(appviewCalls.map(call => call.nsid)).toEqual([
      'app.bsky.feed.getPosts',
    ])
  })

  it('adds no repeats when the pass view carries the same labels', async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    const publicAnchor = {
      ...view('3kanchor22222', {parent: ROOT}),
      labels: [label(MINE, ANCHOR, '!warn')],
    } as PostView
    posts = [root, publicAnchor]
    lensReply = () => labelled([postNode(root), postNode(prismAnchor())])
    const snapshot = await load(setup())
    expect(vals(shown(snapshot, ANCHOR).labels)).toEqual(['prism-own', '!warn'])
  })

  it('keeps the pass labels alone when the answer does not name every labeler sent', async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    const publicAnchor = {
      ...view('3kanchor22222', {parent: ROOT}),
      labels: [label(MINE, ANCHOR, 'from-pass')],
    } as PostView
    posts = [root, publicAnchor]
    // prism applied MINE but the upstream did not confirm WHIMSY.
    lensReply = () => labelled([postNode(root), postNode(prismAnchor())], MINE)
    const snapshot = await load(setup())
    expect(vals(shown(snapshot, ANCHOR).labels)).toEqual(['from-pass'])
  })

  it('keeps the pass labels alone when prism ignored the header (edge 4: over 4096 bytes)', async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    const publicAnchor = {
      ...view('3kanchor22222', {parent: ROOT}),
      labels: [label(MINE, ANCHOR, 'from-pass')],
    } as PostView
    posts = [root, publicAnchor]
    // An ignored header: prism answers with its own labels and no header.
    lensReply = () =>
      labelled([postNode(root), postNode(prismAnchor())], undefined)
    const qc = setup()
    const many = Array.from(
      {length: 150},
      (_, i) => `did:plc:many${String(i).padStart(20, 'a')}`,
    )
    appviewClient.setLabelers(many as `did:${string}:${string}`[])
    const snapshot = await load(qc)
    expect(lensCalls()[0].headers.get(ACCEPT)!.length).toBeGreaterThan(4096)
    expect(vals(shown(snapshot, ANCHOR).labels)).toEqual(['from-pass'])
  })
})

describe('the pass is still needed', () => {
  it('for a member: mutes and bookmarks come only from the AppView', async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    const publicAnchor = view('3kanchor22222', {
      parent: ROOT,
      authorViewer: {muted: true},
      extra: {
        viewer: {
          bookmarked: true,
          like: `at://${READER}/app.bsky.feed.like/3klike1111111`,
        },
      },
    })
    posts = [root, publicAnchor]
    // A member's hydrated answer: like state from prism, no mute, no bookmark.
    const prismView = {
      ...view('3kanchor22222', {parent: ROOT}),
      viewer: {like: `at://${READER}/app.bsky.feed.like/3klike1111111`},
    } as PostView
    lensReply = () =>
      labelled([postNode(root), postNode(prismView)], undefined, {
        servedAs: 'member',
      })
    const snapshot = await load(setup())
    expect(
      appviewCalls.filter(call => call.nsid === 'app.bsky.feed.getPosts'),
    ).toHaveLength(1)
    const anchor = shown(snapshot, ANCHOR)
    expect(anchor.author.viewer?.muted).toBe(true)
    expect(anchor.viewer?.bookmarked).toBe(true)
    // The mute hides the post as on the stock thread.
    expect(moderatePost(anchor, OPTS).ui('contentList').filter).toBe(true)
  })

  it('for a visitor: viewer state comes from the AppView', async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    const publicAnchor = view('3kanchor22222', {
      parent: ROOT,
      extra: {
        viewer: {like: `at://${READER}/app.bsky.feed.like/3klike2222222`},
      },
    })
    posts = [root, publicAnchor]
    lensReply = () =>
      labelled(
        [postNode(root), postNode(view('3kanchor22222', {parent: ROOT}))],
        undefined,
        {servedAs: 'visitor'},
      )
    const snapshot = await load(setup())
    expect(
      appviewCalls.filter(call => call.nsid === 'app.bsky.feed.getPosts'),
    ).toHaveLength(1)
    expect(shown(snapshot, ANCHOR).viewer?.like).toBe(
      `at://${READER}/app.bsky.feed.like/3klike2222222`,
    )
  })
})

describe("prism's edge cases", () => {
  it('edge 1: a post built from its record keeps the labels the pass has', async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    // prism built it from its record: no counts, prism's labels only.
    const built = {
      ...view('3kanchor22222', {parent: ROOT}),
      labels: [label(PRISM_LABELER, ANCHOR, 'prism-own')],
    } as Record<string, unknown>
    delete built.likeCount
    delete built.repostCount
    delete built.replyCount
    delete built.quoteCount
    const publicAnchor = {
      ...view('3kanchor22222', {parent: ROOT}),
      labels: [label(MINE, ANCHOR, '!warn')],
    } as PostView
    posts = [root, publicAnchor]
    lensReply = () =>
      labelled([postNode(root), postNode(built as unknown as PostView)])
    const anchor = shown(await load(setup()), ANCHOR)
    expect(vals(anchor.labels)).toEqual(['prism-own', '!warn'])
    expect(moderatePost(anchor, OPTS).ui('contentView').blur).toBe(true)
  })

  it('edge 2: a quoted post keeps the labels the pass view carries on it', async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    const quoted = uriOf('3kquoted22222')
    const embed = (labels: unknown[]) => ({
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: quoted,
        cid: view('3kquoted22222').cid,
        author: view('3kquoted22222').author,
        value: view('3kquoted22222').record,
        indexedAt: view('3kquoted22222').indexedAt,
        labels,
      },
    })
    // prism's local view of the member's post: the quote with prism's labels.
    const prismView = view('3kanchor22222', {
      parent: ROOT,
      extra: {embed: embed([])},
    })
    const publicAnchor = view('3kanchor22222', {
      parent: ROOT,
      extra: {embed: embed([label(MINE, quoted, '!warn')])},
    })
    posts = [root, publicAnchor]
    lensReply = () => labelled([postNode(root), postNode(prismView)])
    const anchor = shown(await load(setup()), ANCHOR)
    const record = (anchor.embed as {record: {labels: unknown}}).record
    expect(vals(record.labels)).toEqual(['!warn'])
  })

  it("edge 3: a named labeler's !hide gap renders as the content-stripped gap", async () => {
    listFeature(true)
    const root = view('3kroot2222222')
    const anchor = view('3kanchor22222', {parent: ROOT})
    posts = [root, anchor]
    lensReply = () =>
      labelled([
        postNode(root),
        postNode(anchor),
        gapNode(STRIPPED, 'content-stripped', {parentUri: ANCHOR}),
      ])
    const snapshot = await load(setup())
    const node = snapshot.nodes.get(STRIPPED)
    expect(node).toMatchObject({kind: 'gap', gap: 'content-stripped'})
    expect(isRetryableLensGap(node!)).toBe(false)
    expect(GAP_TEXT['content-stripped'].message).toBe('Post unavailable')
    // The gap's URI never reaches the AppView.
    for (const call of appviewCalls) {
      expect(call.params.getAll('uris')).not.toContain(STRIPPED)
    }
    // The screen draws it as the existing gap row's placeholder.
    const selected = selectLensAnswer(
      {lens: snapshot},
      {sort: 'oldest', view: 'linear', below: 10},
    ) as unknown as LensSelected
    expect(selected.lensState.gapUris.has(STRIPPED)).toBe(true)
    const item = selected.thread.find(entry => entry.uri === STRIPPED)
    const post = (item?.value as {post?: PostView} | undefined)?.post
    expect(gapInfoOf(post!)).toMatchObject({
      gap: 'content-stripped',
      retryable: false,
    })
  })
})
