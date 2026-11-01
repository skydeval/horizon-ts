/*
 * The AppView's counts on a member's lens thread (counts.ts): posts drawn
 * from prism's view take the AppView's counts and the reader's like,
 * repost and bookmark state once the thread shows, only onto the run the
 * read started on.
 */

import {type Client} from '@atproto/lex'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {QueryClient} from '@tanstack/react-query'

import {
  LENS_COUNTS_WAIT_MS,
  patchLensCounts,
  refreshLensCounts,
  withAppViewCounts,
} from '#/horizon/thread-lens/counts'
import {type LensNode} from '#/horizon/thread-lens/nodes'
import {setLensShadowCarrier} from '#/horizon/thread-lens/shadow-carry'
import {
  lensQueryKey,
  type LensSnapshot,
  snapshotOf,
} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'
import {READER, uriOf, view} from './harness'

type PostView = app.bsky.feed.defs.PostView

const ANCHOR = uriOf('3kanchor33333')
const REPLY = uriOf('3kreply333333')
const KEY = lensQueryKey({
  did: READER,
  anchor: ANCHOR,
  depth: 10,
  mode: 'lens',
  marked: false,
})

/** prism's view: its own short tally. */
function prismView(rkey: string, parent?: string): PostView {
  return view(rkey, {parent, likeCount: 0, replyCount: 0})
}

/** The AppView's view of the same post. */
function appviewView(
  rkey: string,
  {
    parent,
    likeCount,
    replyCount,
    viewer = {},
  }: {
    parent?: string
    likeCount: number
    replyCount: number
    viewer?: Record<string, unknown>
  },
): PostView {
  const base = view(rkey, {parent, likeCount, replyCount})
  return {...base, repostCount: 2, quoteCount: 1, viewer}
}

function snapshot(
  runId: string,
  nodes: LensNode[],
  extra: Partial<LensSnapshot> = {},
): LensSnapshot {
  return {
    form: 'snapshot',
    runId,
    anchor: {uri: ANCHOR, prismAnchor: ANCHOR},
    nodes: new Map(nodes.map(node => [node.uri, node])),
    markers: new Map(),
    stopped: new Set(),
    hidden: new Set(),
    bridging: [],
    ...extra,
  }
}

function postNode(v: PostView, extra: Partial<LensNode> = {}): LensNode {
  return {kind: 'post', uri: v.uri, view: v, ...extra} as LensNode
}

/** A getPosts AppView answering from `posts`, its calls recorded. */
function appview(posts: PostView[], fail = false) {
  const calls: string[][] = []
  const client = {
    call: (_method: unknown, params: {uris: string[]}) => {
      calls.push(params.uris)
      if (fail) return Promise.reject(new Error('down'))
      return Promise.resolve({
        posts: params.uris
          .map(uri => posts.find(post => post.uri === uri))
          .filter(Boolean),
      })
    },
  } as unknown as Client
  return {client, calls}
}

function shownView(qc: QueryClient, uri: string): PostView | undefined {
  const node = snapshotOf(qc.getQueryData(KEY))?.nodes.get(uri)
  return node && node.kind !== 'gap' ? node.view : undefined
}

let qc: QueryClient

beforeEach(() => {
  qc = new QueryClient({defaultOptions: {queries: {retry: false}}})
})

describe('withAppViewCounts', () => {
  it("takes the AppView's counts and the reader's state", () => {
    const like = `at://${READER}/app.bsky.feed.like/3klike3333333`
    const next = withAppViewCounts(
      {...prismView('3kanchor33333'), viewer: {bookmarked: true}},
      appviewView('3kanchor33333', {
        likeCount: 5,
        replyCount: 3,
        viewer: {like},
      }),
    )
    expect(next).toMatchObject({
      likeCount: 5,
      replyCount: 3,
      repostCount: 2,
      quoteCount: 1,
      viewer: {like},
    })
    // The AppView's view says it is not saved.
    expect(next.viewer?.bookmarked).toBeUndefined()
  })

  it('keeps the same object when nothing differs', () => {
    const v = {...prismView('3kanchor33333'), repostCount: 0}
    expect(withAppViewCounts(v, {...v, viewer: undefined})).toBe(v)
  })

  it("keeps everything else prism's", () => {
    const prism = {
      ...prismView('3kanchor33333'),
      labels: [{val: 'prism', src: READER, uri: ANCHOR, cts: ''}],
    } as unknown as PostView
    const next = withAppViewCounts(
      prism,
      appviewView('3kanchor33333', {likeCount: 5, replyCount: 3}),
    )
    expect(next.labels).toBe(prism.labels)
    expect(next.author).toBe(prism.author)
    expect(next.record).toBe(prism.record)
  })
})

describe('patchLensCounts', () => {
  it('patches public post nodes only', () => {
    const restored = prismView('3kreply333333', ANCHOR)
    const current = snapshot('run', [
      postNode(prismView('3kanchor33333')),
      postNode(restored, {restored: true}),
    ])
    const {next, found} = patchLensCounts(
      current,
      new Map([
        [ANCHOR, appviewView('3kanchor33333', {likeCount: 5, replyCount: 1})],
        [REPLY, appviewView('3kreply333333', {likeCount: 9, replyCount: 0})],
      ]),
    )
    expect(found).toEqual([ANCHOR])
    const anchor = next?.nodes.get(ANCHOR)
    expect(anchor?.kind === 'post' && anchor.view.likeCount).toBe(5)
    const reply = next?.nodes.get(REPLY)
    expect(reply?.kind === 'post' && reply.view).toBe(restored)
    // The held snapshot is never changed.
    expect(current.nodes.get(ANCHOR)).not.toBe(anchor)
  })

  it('gives no snapshot when no view changed', () => {
    const v = {...prismView('3kanchor33333'), repostCount: 0}
    const {next, found} = patchLensCounts(
      snapshot('run', [postNode(v)]),
      new Map([[ANCHOR, {...v, viewer: undefined}]]),
    )
    expect(next).toBeUndefined()
    expect(found).toEqual([ANCHOR])
  })
})

describe('refreshLensCounts', () => {
  const posts = [
    appviewView('3kanchor33333', {likeCount: 5, replyCount: 1}),
    appviewView('3kreply333333', {parent: ANCHOR, likeCount: 2, replyCount: 0}),
  ]

  it('puts the counts on the run it read for', async () => {
    qc.setQueryData(KEY, {
      lens: snapshot('run', [
        postNode(prismView('3kanchor33333')),
        postNode(prismView('3kreply333333', ANCHOR)),
      ]),
    })
    const {client, calls} = appview(posts)
    await refreshLensCounts({
      qc,
      queryKey: KEY,
      runId: 'run',
      appview: client,
      uris: [ANCHOR, REPLY],
    })
    expect(calls).toEqual([[ANCHOR, REPLY]])
    expect(shownView(qc, ANCHOR)).toMatchObject({likeCount: 5, replyCount: 1})
    expect(shownView(qc, REPLY)).toMatchObject({likeCount: 2})
  })

  it('waits for its run to land', async () => {
    const {client} = appview(posts)
    const done = refreshLensCounts({
      qc,
      queryKey: KEY,
      runId: 'run',
      appview: client,
      uris: [ANCHOR],
    })
    // The query's own run is in flight while the counts arrive.
    const landed = qc.fetchQuery({
      queryKey: KEY,
      queryFn: async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        return {lens: snapshot('run', [postNode(prismView('3kanchor33333'))])}
      },
    })
    await landed
    await done
    expect(shownView(qc, ANCHOR)).toMatchObject({likeCount: 5})
  })

  it('patches nodes a later write adds', async () => {
    qc.setQueryData(KEY, {
      lens: snapshot('run', [postNode(prismView('3kanchor33333'))]),
    })
    const {client} = appview(posts)
    const done = refreshLensCounts({
      qc,
      queryKey: KEY,
      runId: 'run',
      appview: client,
      uris: [ANCHOR, REPLY],
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(shownView(qc, ANCHOR)).toMatchObject({likeCount: 5})
    // A continuation's write lands the reply.
    const current = snapshotOf(qc.getQueryData(KEY))
    if (!current) throw new Error('no snapshot')
    const nodes = new Map(current.nodes)
    nodes.set(REPLY, postNode(prismView('3kreply333333', ANCHOR)))
    qc.setQueryData(KEY, {lens: {...current, nodes}})
    await done
    expect(shownView(qc, REPLY)).toMatchObject({likeCount: 2})
    expect(shownView(qc, ANCHOR)).toMatchObject({likeCount: 5})
  })

  it('writes nothing onto another run', async () => {
    const other = snapshot('newer', [postNode(prismView('3kanchor33333'))])
    qc.setQueryData(KEY, {lens: other})
    const {client} = appview(posts)
    await refreshLensCounts({
      qc,
      queryKey: KEY,
      runId: 'run',
      appview: client,
      uris: [ANCHOR],
    })
    expect(snapshotOf(qc.getQueryData(KEY))).toBe(other)
  })

  it("leaves prism's counts when the AppView fails", async () => {
    const held = snapshot('run', [postNode(prismView('3kanchor33333'))])
    qc.setQueryData(KEY, {lens: held})
    const {client} = appview(posts, true)
    await refreshLensCounts({
      qc,
      queryKey: KEY,
      runId: 'run',
      appview: client,
      uris: [ANCHOR],
    })
    expect(snapshotOf(qc.getQueryData(KEY))).toBe(held)
  })

  it('sends nothing with nothing to read', async () => {
    const {client, calls} = appview(posts)
    await refreshLensCounts({
      qc,
      queryKey: KEY,
      runId: 'run',
      appview: client,
      uris: [],
    })
    expect(calls).toEqual([])
  })

  it('gives up waiting after a while', async () => {
    jest.useFakeTimers()
    try {
      const {client} = appview(posts)
      const done = refreshLensCounts({
        qc,
        queryKey: KEY,
        runId: 'run',
        appview: client,
        uris: [ANCHOR],
      })
      // The run is in flight and never lands.
      void qc.prefetchQuery({
        queryKey: KEY,
        queryFn: () => new Promise(() => {}),
      })
      await jest.advanceTimersByTimeAsync(LENS_COUNTS_WAIT_MS + 1)
      await done
    } finally {
      jest.useRealTimers()
    }
  })

  it("moves a post's shadow onto the patched view", async () => {
    const shadows = new WeakMap<object, unknown>()
    setLensShadowCarrier((from, to) => {
      if (shadows.has(from)) shadows.set(to, shadows.get(from))
    })
    try {
      const before = prismView('3kanchor33333')
      shadows.set(before, {likeUri: 'pending'})
      qc.setQueryData(KEY, {lens: snapshot('run', [postNode(before)])})
      const {client} = appview([
        appviewView('3kanchor33333', {likeCount: 5, replyCount: 1}),
      ])
      await refreshLensCounts({
        qc,
        queryKey: KEY,
        runId: 'run',
        appview: client,
        uris: [ANCHOR],
      })
      const after = shownView(qc, ANCHOR)
      expect(after).not.toBe(before)
      expect(after && shadows.get(after)).toEqual({likeUri: 'pending'})
    } finally {
      setLensShadowCarrier(undefined)
    }
  })
})
