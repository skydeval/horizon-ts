import {describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))

import {sortAndAnnotateThreadItems} from '#/state/queries/usePostThread/traversal'
import {
  gapInfoOf,
  LENS_EPOCH,
  type LensSelected,
  selectLensAnswer,
  threadLensState,
  tidTimeMs,
} from '#/horizon/thread-lens/adapt'
import {
  checkLensNodes,
  EMPTY_BASE,
  type LensNode,
  mergeLensNodes,
  type PublicOutcome,
} from '#/horizon/thread-lens/nodes'
import {
  firstSnapshot,
  gapOnlySnapshot,
  LENS_ROOT,
  type LensSnapshot,
  stopKey,
} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'
import {
  AUTHOR,
  BLOCKED,
  gapNode,
  MODERATION_OPTS,
  postNode,
  privateUriOf,
  READER,
  uriOf,
  view,
} from './harness'

type PostView = app.bsky.feed.defs.PostView

const ROOT = uriOf('3kroot2222222')
const ANCHOR = uriOf('3kanchor22222')

function snapshotOf(
  raw: unknown[],
  {
    anchor = ANCHOR,
    bridging = ['full'],
    extra = [],
    edit = s => s,
  }: {
    anchor?: string
    bridging?: string[]
    extra?: LensNode[]
    edit?: (snapshot: LensSnapshot) => LensSnapshot
  } = {},
): LensSnapshot {
  const checked = checkLensNodes(raw)
  const outcomes = new Map<string, PublicOutcome>()
  for (const node of checked) {
    if (node.type === 'post') {
      outcomes.set(node.uri, {
        kind: 'view',
        view: node.post as unknown as PostView,
      })
    }
  }
  const merged = mergeLensNodes(EMPTY_BASE, checked, {
    request: {kind: 'first'},
    bridging: bridging[0],
    outcomes,
  })
  const nodes = new Map(merged.nodes)
  for (const node of extra) nodes.set(node.uri, node)
  const snapshot = firstSnapshot({
    runId: 'run-1',
    anchorUri: anchor,
    prismAnchor: anchor,
    merged: {...merged, nodes},
    bridging: bridging[0],
  })
  return edit({...snapshot, bridging})
}

function select(
  snapshot: LensSnapshot,
  settings: Partial<Parameters<typeof selectLensAnswer>[1]> = {},
): LensSelected {
  return selectLensAnswer(
    {lens: snapshot},
    {
      sort: 'oldest',
      view: 'linear',
      below: 10,
      queueId: 'q1',
      ...settings,
    },
  ) as unknown as LensSelected
}

function postOf(item: LensSelected['thread'][number]): PostView {
  return (item.value as {post: PostView}).post
}

function uris(output: LensSelected) {
  return output.thread.map(item => [item.uri, item.depth])
}

describe('gaps as placeholder items (7.3)', () => {
  const GAP = uriOf('3kgap22222222', BLOCKED)
  const BELOW = uriOf('3kbelow222222')
  const raw = [
    postNode(view('3kroot2222222')),
    postNode(view('3kanchor22222', {parent: ROOT}), {rootUri: ROOT}),
    gapNode(GAP, 'blocking-you', {parentUri: ANCHOR, moreReplies: {}}),
    postNode(view('3kbelow222222', {parent: GAP, root: ROOT})),
  ]

  it('builds the placeholder view as the design lists it', () => {
    const output = select(snapshotOf(raw))
    const item = output.thread.find(i => i.uri === GAP)!
    const post = postOf(item)
    expect(post.cid).toBe('')
    expect(post.indexedAt).toBe(LENS_EPOCH)
    expect(post.author).toEqual({did: BLOCKED, handle: 'handle.invalid'})
    expect(post.viewer).toEqual({replyDisabled: true, embeddingDisabled: true})
    expect(post.record).toEqual({
      $type: 'app.bsky.feed.post',
      text: '',
      createdAt: LENS_EPOCH,
      reply: {parent: {uri: ANCHOR, cid: ''}, root: {uri: ROOT, cid: ''}},
    })
    // One attached reply plus one for the gap's marker.
    expect(post.replyCount).toBe(2)
    expect(post.likeCount).toBe(0)
    expect(gapInfoOf(post)).toMatchObject({gap: 'blocking-you', uri: GAP})
  })

  it('takes the root from a held record, else the parent', () => {
    const fromRecord = select(
      snapshotOf([
        postNode(view('3kanchor22222', {parent: uriOf('3kp'), root: ROOT})),
        gapNode(uriOf('3kgapxx222222'), 'deleted', {parentUri: ANCHOR}),
      ]),
    )
    const gap = fromRecord.thread.find(i => i.uri === uriOf('3kgapxx222222'))!
    expect(
      (postOf(gap).record as {reply: {root: {uri: string}}}).reply.root.uri,
    ).toBe(ROOT)
    const anchorGap = select(
      snapshotOf([gapNode(ANCHOR, 'deleted', {parentUri: ROOT})]),
    )
    expect(
      (postOf(anchorGap.thread[0]).record as {reply: {root: {uri: string}}})
        .reply.root.uri,
    ).toBe(ROOT)
  })

  it('gives a parentless top gap no reply, so it reads as a root', () => {
    const output = select(snapshotOf([gapNode(ANCHOR, 'blocking-you')]))
    expect(output.thread).toHaveLength(1)
    expect(postOf(output.thread[0]).record).not.toHaveProperty('reply')
  })

  it('never draws a real post with an empty cid as a gap', () => {
    const lookAlike = {...view('3kanchor22222'), cid: ''}
    expect(gapInfoOf(lookAlike)).toBeUndefined()
  })

  it('keeps no placeholder in the snapshot', () => {
    const snapshot = snapshotOf(raw)
    select(snapshot)
    for (const node of snapshot.nodes.values()) {
      if (node.kind !== 'gap') expect(node.view.cid).not.toBe('')
      expect(node).not.toHaveProperty('placeholder')
    }
  })

  it.each(['linear', 'tree'] as const)(
    'keeps parents above a gap and replies below it in the stock traversal (%s)',
    viewKind => {
      const parentGap = uriOf('3kparentgap22', BLOCKED)
      const snapshot = snapshotOf([
        postNode(view('3kroot2222222')),
        gapNode(parentGap, 'blocked-by-you', {parentUri: ROOT}),
        postNode(view('3kanchor22222', {parent: parentGap, root: ROOT})),
        gapNode(GAP, 'blocking-you', {parentUri: ANCHOR}),
        postNode(view('3kbelow222222', {parent: GAP, root: ROOT})),
      ])
      const output = select(snapshot, {
        view: viewKind,
        below: viewKind === 'tree' ? 4 : 10,
      })
      const {threadItems} = sortAndAnnotateThreadItems(output.thread, {
        threadgateHiddenReplies: new Set(),
        moderationOpts: MODERATION_OPTS,
        view: viewKind,
      })
      expect(threadItems.map(item => (item as {uri: string}).uri)).toEqual([
        ROOT,
        parentGap,
        ANCHOR,
        GAP,
        BELOW,
      ])
    },
  )
})

describe('sort, branching and depth (7.4)', () => {
  const a = view('3kaaaaaa22222', {parent: ANCHOR, minutes: 3, likeCount: 1})
  const b = view('3kbbbbbb22222', {parent: ANCHOR, minutes: 1, likeCount: 5})
  // A TID gap: 3kc... sorts by its key's time, which is near the others.
  const gapUri = uriOf('3kcccccc22222', BLOCKED)
  const privUri = privateUriOf('3kpriv2222222')
  const priv: LensNode = {
    kind: 'private',
    uri: privUri,
    parentUri: ANCHOR,
    view: {
      ...view('3kpriv2222222', {parent: ANCHOR, minutes: 2}),
      uri: privUri as PostView['uri'],
    },
  }
  const snapshot = snapshotOf(
    [
      postNode(view('3kanchor22222')),
      postNode(a),
      postNode(b),
      gapNode(gapUri, 'blocked-by-you', {parentUri: ANCHOR}),
      gapNode(uriOf('nottid', BLOCKED), 'deleted', {parentUri: ANCHOR}),
    ],
    {extra: [priv]},
  )

  it('decodes a TID record key to its time', () => {
    // A `3k` key is from late 2023.
    const time = tidTimeMs(uriOf('3kcccccc22222'))!
    expect(time).toBeGreaterThan(Date.UTC(2023, 0, 1))
    expect(time).toBeLessThan(Date.UTC(2025, 0, 1))
    expect(tidTimeMs(uriOf('nottid'))).toBeUndefined()
  })

  it('orders top by likes, private subtrees first, gaps last', () => {
    const output = select(snapshot, {sort: 'top'})
    expect(output.thread.map(item => item.uri)).toEqual([
      ANCHOR,
      priv.uri,
      b.uri,
      a.uri,
      gapUri,
      uriOf('nottid', BLOCKED),
    ])
  })

  it('orders oldest and newest by time, a non-TID gap last', () => {
    const oldest = select(snapshot, {sort: 'oldest'}).thread.map(i => i.uri)
    const newest = select(snapshot, {sort: 'newest'}).thread.map(i => i.uri)
    // The gap's TID dates from before the fixture's posts.
    expect(oldest.slice(1, 5)).toEqual([gapUri, b.uri, priv.uri, a.uri])
    expect(newest.slice(1, 5)).toEqual([a.uri, priv.uri, b.uri, gapUri])
    expect(oldest.at(-1)).toBe(uriOf('nottid', BLOCKED))
    expect(newest.at(-1)).toBe(uriOf('nottid', BLOCKED))
  })

  it('reuses the held views across a sort change, with no other input', () => {
    const top = select(snapshot, {sort: 'top'})
    const oldest = select(snapshot, {sort: 'oldest'})
    const held = (s: LensSelected, uri: string) =>
      postOf(s.thread.find(item => item.uri === uri)!)
    expect(held(top, a.uri)).toBe(held(oldest, a.uri))
    expect(select(snapshot, {sort: 'top'})).toBe(top)
    expect(select(snapshot, {sort: 'top'}).thread).toBe(top.thread)
  })

  it('cuts branching into moreReplies counts in linear view', () => {
    const c1 = view('3kc1c1c122222', {parent: a.uri, minutes: 4})
    const c2 = view('3kc2c2c222222', {parent: a.uri, minutes: 5})
    const output = select(
      snapshotOf([
        postNode(view('3kanchor22222')),
        postNode(a),
        postNode(c1),
        postNode(c2),
      ]),
      {view: 'linear'},
    )
    expect(uris(output)).toEqual([
      [ANCHOR, 0],
      [a.uri, 1],
      [c1.uri, 2],
    ])
    const item = output.thread[1].value as {moreReplies: number}
    expect(item.moreReplies).toBe(1)
    expect(output.lensState.markers.has(a.uri)).toBe(false)
  })

  it('cuts the tree at the rendered bound into read-more counts', () => {
    const chain = [postNode(view('3kanchor22222'))]
    let parent = ANCHOR
    for (let i = 1; i <= 6; i++) {
      const v = view(`3kdepth${i}222222`, {parent, minutes: i})
      chain.push(postNode(v))
      parent = v.uri
    }
    const snapshot = snapshotOf(chain)
    const narrow = select(snapshot, {view: 'tree', below: 4})
    expect(narrow.thread.map(item => item.depth)).toEqual([0, 1, 2, 3, 4])
    expect((narrow.thread[4].value as {moreReplies: number}).moreReplies).toBe(
      1,
    )
    const wide = select(snapshot, {view: 'tree', below: 6})
    expect(wide.thread.map(item => item.depth)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})

describe('markers (9.2)', () => {
  it('draws "Load earlier posts" only on a top whose parent is absent', () => {
    const top = select(
      snapshotOf([
        postNode(view('3kroot2222222', {parent: uriOf('3kabove')}), {
          moreParents: true,
        }),
        postNode(view('3kanchor22222', {parent: ROOT}), {moreParents: true}),
      ]),
    )
    expect(
      top.thread.map(
        item => (item.value as {moreParents: boolean}).moreParents,
      ),
    ).toEqual([true, false])
    expect(top.lensState.markers.get(ROOT)).toEqual({kind: 'parents'})
    expect(top.lensState.markers.has(ANCHOR)).toBe(false)
  })

  it('draws no row for a dangling top without moreParents', () => {
    const output = select(
      snapshotOf([postNode(view('3kanchor22222', {parent: uriOf('3kgone')}))]),
    )
    expect((output.thread[0].value as {moreParents: boolean}).moreParents).toBe(
      false,
    )
    expect(output.lensState.markers.size).toBe(0)
  })

  it('records an in-place "Load more replies" row inside the bound', () => {
    const reply = view('3kreply222222', {parent: ANCHOR})
    const output = select(
      snapshotOf([
        postNode(view('3kanchor22222')),
        postNode(reply, {moreReplies: {cursor: 'c'}}),
      ]),
    )
    expect(output.lensState.markers.get(reply.uri)).toEqual({kind: 'replies'})
    expect((output.thread[1].value as {moreReplies: number}).moreReplies).toBe(
      1,
    )
  })

  it('leaves a marker at the bound to the stock read-more row', () => {
    const reply = view('3kreply222222', {parent: ANCHOR})
    const output = select(
      snapshotOf([
        postNode(view('3kanchor22222')),
        postNode(reply, {moreReplies: {cursor: 'c'}}),
      ]),
      {below: 1},
    )
    expect(output.lensState.markers.has(reply.uri)).toBe(false)
    expect((output.thread[1].value as {moreReplies: number}).moreReplies).toBe(
      1,
    )
  })

  it('removes a stopped row', () => {
    const reply = view('3kreply222222', {parent: ANCHOR})
    const output = select(
      snapshotOf(
        [postNode(view('3kanchor22222')), postNode(reply, {moreReplies: {}})],
        {
          edit: s => ({
            ...s,
            stopped: new Set([stopKey('replies', reply.uri)]),
          }),
        },
      ),
    )
    expect(output.lensState.markers.size).toBe(0)
    expect((output.thread[1].value as {moreReplies: number}).moreReplies).toBe(
      0,
    )
  })

  it('draws no marker on a gap-only answer', () => {
    const output = select(
      gapOnlySnapshot({
        runId: 'r',
        anchorUri: ANCHOR,
        gap: 'blocking-you',
        note: {reason: 'off', autoRetry: 'none'},
      }),
    )
    expect(output.lensState.kind).toBe('gap-only')
    expect(output.lensState.markers.size).toBe(0)
    expect(gapInfoOf(postOf(output.thread[0]))?.retryable).toBe(false)
    expect(output.lensState.note).toEqual({reason: 'off', autoRetry: 'none'})
  })
})

describe('hidden replies and the emitted threadgate (7.5)', () => {
  const flagged = view('3kflagged2222', {parent: ANCHOR, did: BLOCKED})
  const deep = view('3kdeepflag222', {parent: flagged.uri, did: BLOCKED})
  const deeper = view('3kdeeper22222', {parent: deep.uri})

  function threadgateOf(output: LensSelected) {
    return output.threadgate as unknown as
      {record: {hiddenReplies: string[]; allow?: unknown}} | undefined
  }

  it('joins the flags with the root post view gate, keeping allow', () => {
    const gate = {
      uri: `at://${AUTHOR}/app.bsky.feed.threadgate/3kanchor22222`,
      cid: 'bafy',
      record: {
        $type: 'app.bsky.feed.threadgate',
        post: ANCHOR,
        createdAt: LENS_EPOCH,
        allow: [{$type: 'app.bsky.feed.threadgate#followingRule'}],
        hiddenReplies: [uriOf('3kalready2222')],
      },
    }
    const snapshot = snapshotOf([
      postNode(view('3kanchor22222', {threadgate: gate})),
      postNode(flagged, {hiddenByThreadgate: true}),
    ])
    const output = select(snapshot)
    const emitted = threadgateOf(output)!
    expect(emitted).not.toBe(gate)
    expect(emitted.record.allow).toEqual(gate.record.allow)
    expect(new Set(emitted.record.hiddenReplies)).toEqual(
      new Set([uriOf('3kalready2222'), flagged.uri]),
    )
    expect(select(snapshot).threadgate).toBe(output.threadgate)
  })

  it('emits a flags-only record for a gap root, with no allow', () => {
    const output = select(
      snapshotOf([
        gapNode(ROOT, 'blocking-you'),
        postNode(view('3kanchor22222', {parent: ROOT}), {rootUri: ROOT}),
        postNode(view('3kflagged2222', {parent: ANCHOR, root: ROOT}), {
          hiddenByThreadgate: true,
        }),
      ]),
    )
    const emitted = threadgateOf(output)!
    expect(emitted.record).not.toHaveProperty('allow')
    expect(emitted.record.hiddenReplies).toEqual([uriOf('3kflagged2222')])
  })

  it('emits no threadgate with no flag and no gate', () => {
    expect(
      select(snapshotOf([postNode(view('3kanchor22222'))])).threadgate,
    ).toBe(undefined)
  })

  it('collapses a flagged depth-1 reply and drops a flagged depth-2 one', () => {
    const output = select(
      snapshotOf([
        postNode(view('3kanchor22222')),
        postNode(flagged, {hiddenByThreadgate: true}),
        postNode(deep, {hiddenByThreadgate: true}),
        postNode(deeper),
      ]),
    )
    const hidden = new Set(threadgateOf(output)!.record.hiddenReplies)
    const {threadItems, otherThreadItems} = sortAndAnnotateThreadItems(
      output.thread,
      {
        threadgateHiddenReplies: hidden,
        moderationOpts: MODERATION_OPTS,
        view: 'linear',
      },
    )
    expect(threadItems.map(item => (item as {uri: string}).uri)).toEqual([
      ANCHOR,
    ])
    expect(otherThreadItems.map(item => (item as {uri: string}).uri)).toEqual([
      flagged.uri,
    ])
  })

  it('keeps the reader own flagged post visible', () => {
    const own = view('3kownflag2222', {parent: ANCHOR, did: READER})
    const output = select(
      snapshotOf([
        postNode(view('3kanchor22222')),
        postNode(own, {hiddenByThreadgate: true}),
      ]),
    )
    const {threadItems} = sortAndAnnotateThreadItems(output.thread, {
      threadgateHiddenReplies: new Set(
        threadgateOf(output)!.record.hiddenReplies,
      ),
      moderationOpts: MODERATION_OPTS,
      view: 'linear',
    })
    expect(threadItems.map(item => (item as {uri: string}).uri)).toEqual([
      ANCHOR,
      own.uri,
    ])
  })
})

describe('lensState (4.3, 10)', () => {
  it.each([
    [['full'], 'full'],
    [['limited'], 'limited'],
    [['off'], 'off'],
    [['full', 'off'], 'limited'],
    [['full', 'something-new'], 'limited'],
    [['off', 'full'], 'off'],
  ])('reads bridging %j as %s', (bridging, expected) => {
    const output = select(
      snapshotOf([postNode(view('3kanchor22222'))], {bridging}),
    )
    expect(output.lensState.bridging).toBe(expected)
  })

  it('carries the kind, gap URIs and queue id of a snapshot', () => {
    const gap = uriOf('3kgap22222222', BLOCKED)
    const output = select(
      snapshotOf([
        postNode(view('3kanchor22222')),
        gapNode(gap, 'deleted', {parentUri: ANCHOR}),
      ]),
    )
    expect(output.lensState).toMatchObject({
      kind: 'snapshot',
      queueId: 'q1',
      fallbackStale: false,
    })
    expect(output.lensState.gapUris).toEqual(new Set([gap]))
  })

  it('tags a fallback with a shallow copy and its staleness', () => {
    const data = {
      thread: [],
      hasOtherReplies: false,
      lens: {
        fallback: '429',
        retryAt: 5,
        autoRetry: 'pending',
        readWith: {sort: 'oldest', below: 10},
        runId: 'r',
      },
    }
    const same = selectLensAnswer(data, {
      sort: 'oldest',
      view: 'linear',
      below: 10,
    }) as unknown as LensSelected
    expect(same.thread).toBe(data.thread)
    expect(same.lensState).toMatchObject({
      kind: 'fallback',
      fallbackStale: false,
      note: {reason: '429', retryAt: 5, autoRetry: 'pending'},
    })
    const stale = selectLensAnswer(data, {
      sort: 'top',
      view: 'linear',
      below: 10,
    }) as unknown as LensSelected
    expect(stale.lensState.fallbackStale).toBe(true)
  })

  it('passes placeholder data through, and threadLensState reads the key', () => {
    const placeholder = {
      thread: [],
      threadgate: undefined,
      hasOtherReplies: false,
    }
    expect(
      selectLensAnswer(placeholder, {sort: 'top', view: 'linear', below: 10}),
    ).toBe(placeholder)
    const lensKey = [LENS_ROOT, {}]
    expect(threadLensState(placeholder, true, lensKey).kind).toBe('placeholder')
    expect(
      threadLensState(placeholder, true, ['post-thread-v2', {}]).kind,
    ).toBe('stock')
    const output = select(snapshotOf([postNode(view('3kanchor22222'))]))
    expect(threadLensState(output, false, lensKey)).toBe(output.lensState)
    expect(threadLensState(output, false, ['post-thread-v2', {}]).kind).toBe(
      'stock',
    )
  })
})
