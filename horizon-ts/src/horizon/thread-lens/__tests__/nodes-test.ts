import {describe, expect, it} from '@jest/globals'

import {
  checkLensNode,
  checkLensNodes,
  EMPTY_BASE,
  isLensAtUri,
  type LensNode,
  lensRootUri,
  lensTree,
  type MergeBase,
  mergeLensNodes,
  postUrisToRead,
  type PublicOutcome,
} from '#/horizon/thread-lens/nodes'
import {type app} from '#/lexicons'
import {
  AUTHOR,
  BLOCKED,
  gapNode,
  postNode,
  privateUriOf,
  uriOf,
  view,
} from './harness'

type PostView = app.bsky.feed.defs.PostView

const ROOT = uriOf('3kroot2222222')
const ANCHOR = uriOf('3kanchor22222')
const REPLY = uriOf('3kreply222222')
const DEEP = uriOf('3kdeep2222222')
const LIST = `at://${AUTHOR}/app.bsky.graph.list/3klist2222222`

/** Every post node's outcome as its own view, as a clean public pass. */
function viewsFor(checked: ReturnType<typeof checkLensNodes>) {
  const outcomes = new Map<string, PublicOutcome>()
  for (const node of checked) {
    if (node.type === 'post') {
      outcomes.set(node.uri, {
        kind: 'view',
        view: node.post as unknown as PostView,
      })
    }
  }
  return outcomes
}

function first(raw: unknown[], bridging = 'full') {
  const checked = checkLensNodes(raw)
  return mergeLensNodes(EMPTY_BASE, checked, {
    request: {kind: 'first'},
    bridging,
    outcomes: viewsFor(checked),
  })
}

function later(
  base: MergeBase,
  raw: unknown[],
  request: Parameters<typeof mergeLensNodes>[2]['request'],
  bridging = 'full',
) {
  const checked = checkLensNodes(raw)
  const outcomes = viewsFor(checked)
  for (const uri of outcomes.keys()) {
    if (!postUrisToRead(base, checked).includes(uri)) outcomes.delete(uri)
  }
  return mergeLensNodes(base, checked, {request, bridging, outcomes})
}

describe('the at_uri check (7.2 step 1)', () => {
  it('takes a DID authority with four slashes only', () => {
    expect(isLensAtUri(ANCHOR)).toBe(true)
    expect(isLensAtUri('at://alice.test/app.bsky.feed.post/3k')).toBe(false)
    expect(isLensAtUri(`${ANCHOR}/extra`)).toBe(false)
    expect(isLensAtUri(`at://${AUTHOR}/app.bsky.feed.post`)).toBe(false)
    expect(isLensAtUri('https://example.com/a/b/c')).toBe(false)
    expect(isLensAtUri(42)).toBe(false)
  })
})

describe('node checks (7.2 step 1)', () => {
  it('drops a malformed node and keeps the rest', () => {
    const checked = checkLensNodes([
      postNode(view('3kanchor22222')),
      {uri: 'at://handle.test/app.bsky.feed.post/3k', gap: 'deleted'},
      {uri: REPLY},
      {uri: REPLY, post: {uri: DEEP}},
      'not a node',
      gapNode(DEEP, 'deleted'),
    ])
    expect(checked.map(node => node.uri)).toEqual([ANCHOR, DEEP])
  })

  it('reads a non-boolean hidden flag as absent', () => {
    expect(
      checkLensNode(gapNode(REPLY, 'deleted', {hiddenByThreadgate: 'true'}))
        ?.hidden,
    ).toBe(false)
    expect(
      checkLensNode(gapNode(REPLY, 'deleted', {hiddenByThreadgate: true}))
        ?.hidden,
    ).toBe(true)
  })

  it('reads blockingByListUri only as a list AT-URI on blocked-by-you', () => {
    const on = (gap: string, list: unknown) =>
      checkLensNode(gapNode(REPLY, gap, {blockingByListUri: list}))
    expect(on('blocked-by-you', LIST)).toMatchObject({listUri: LIST})
    expect(on('blocked-by-you', ANCHOR)).not.toHaveProperty('listUri')
    expect(on('blocked-by-you', 'not a uri')).not.toHaveProperty('listUri')
    expect(on('blocking-you', LIST)).not.toHaveProperty('listUri')
  })

  it('keeps markers on block gaps only', () => {
    expect(
      checkLensNode(
        gapNode(REPLY, 'blocking-you', {moreParents: true, moreReplies: {}}),
      )?.markers,
    ).toEqual({moreParents: true, moreReplies: {}})
    expect(
      checkLensNode(gapNode(REPLY, 'deleted', {moreParents: true}))?.markers,
    ).toEqual({})
  })

  it('makes a post node with a private URI a tier-hidden gap (5.6)', () => {
    const uri = privateUriOf('3kpriv222222')
    const checked = checkLensNode({uri, post: {uri}})
    expect(checked).toMatchObject({type: 'gap', gap: 'tier-hidden'})
    expect(postUrisToRead(EMPTY_BASE, checked ? [checked] : [])).toEqual([])
  })
})

describe('the tree (7.2 step 3)', () => {
  const nodes = [
    postNode(view('3kroot2222222')),
    postNode(view('3kanchor22222', {parent: ROOT})),
    gapNode(REPLY, 'blocked-by-you', {parentUri: ANCHOR}),
    postNode(view('3kdeep2222222', {parent: REPLY, root: ROOT})),
  ]

  function shape(raw: unknown[]) {
    const merged = first(raw)
    const tree = lensTree(merged.nodes, ANCHOR)
    const walk = (uri: string): unknown[] =>
      (tree.children.get(uri) ?? []).map(child => [child.uri, walk(child.uri)])
    return {chain: tree.chain.map(node => node.uri), replies: walk(ANCHOR)}
  }

  it('builds the same tree from nodes in any order', () => {
    expect(shape(nodes)).toEqual(shape([...nodes].reverse()))
    expect(shape(nodes)).toEqual({
      chain: [ROOT],
      replies: [[REPLY, [[DEEP, []]]]],
    })
  })

  it('attaches a reply under a gap to the gap', () => {
    expect(shape(nodes).replies).toEqual([[REPLY, [[DEEP, []]]]])
  })

  it('drops a reply whose parent the merged map lacks, with its subtree', () => {
    const orphan = uriOf('3korphan22222')
    const merged = first([
      ...nodes,
      postNode(view('3korphan22222', {parent: uriOf('3kmissing2222')})),
      postNode(view('3korphanchild', {parent: orphan})),
    ])
    const tree = lensTree(merged.nodes, ANCHOR)
    const reachable = new Set<string>()
    const walk = (uri: string) => {
      for (const child of tree.children.get(uri) ?? []) {
        reachable.add(child.uri)
        walk(child.uri)
      }
    }
    walk(ANCHOR)
    expect(reachable.has(orphan)).toBe(false)
    expect(reachable.has(uriOf('3korphanchild'))).toBe(false)
  })

  it('attaches a reply whose parent came in an earlier response', () => {
    const base = first(nodes.slice(0, 2))
    const merged = later(
      base,
      [postNode(view('3kreply222222', {parent: ANCHOR}))],
      {kind: 'replies', anchor: ANCHOR, subtree: true},
    )
    const tree = lensTree(merged.nodes, ANCHOR)
    expect(tree.children.get(ANCHOR)?.map(node => node.uri)).toEqual([REPLY])
  })

  it('finds the root from rootUri, then a held record, then the top', () => {
    const withRoot = first([
      postNode(view('3kanchor22222', {parent: ROOT}), {rootUri: ROOT}),
    ])
    expect(lensRootUri(withRoot.nodes)).toBe(ROOT)
    const fromRecord = first([
      postNode(view('3kanchor22222', {parent: REPLY, root: ROOT})),
    ])
    expect(lensRootUri(fromRecord.nodes)).toBe(ROOT)
    const top = first([postNode(view('3kroot2222222'))])
    expect(lensRootUri(top.nodes, top.nodes.get(ROOT))).toBe(ROOT)
  })
})

describe('the merge (7.2 step 2)', () => {
  const anchorView = view('3kanchor22222', {parent: ROOT, likeCount: 3})
  const base = first([
    postNode(view('3kroot2222222')),
    postNode(anchorView, {moreReplies: {cursor: 'c1'}}),
    postNode(view('3kreply222222', {parent: ANCHOR}), {
      moreReplies: {cursor: 'r1'},
    }),
  ])

  it('keeps a held post node and its view object (TL-31)', () => {
    const resent = view('3kanchor22222', {parent: ROOT, likeCount: 99})
    const checked = checkLensNodes([postNode(resent)])
    expect(postUrisToRead(base, checked)).toEqual([])
    const merged = later(base, [postNode(resent)], {kind: 'resolve'})
    const node = merged.nodes.get(ANCHOR)
    expect(node?.kind === 'post' && node.view).toBe(
      (base.nodes.get(ANCHOR) as {view: PostView}).view,
    )
    expect(merged.newViews).toEqual([])
  })

  it('sends a gap that became a post node to the public-view pass', () => {
    const withGap = first([gapNode(ANCHOR, 'block-state-unknown')])
    const checked = checkLensNodes([postNode(anchorView)])
    expect(postUrisToRead(withGap, checked)).toEqual([ANCHOR])
  })

  it.each([
    ['upstream-unavailable', 'full'],
    ['block-state-unknown', 'full'],
    ['some-future-kind', 'full'],
    ['blocked', 'limited'],
    ['blocked', 'off'],
  ])('keeps a post over a worse %s gap (bridging %s)', (gap, bridging) => {
    const merged = later(
      base,
      [gapNode(ANCHOR, gap)],
      {kind: 'resolve'},
      bridging,
    )
    expect(merged.nodes.get(ANCHOR)?.kind).toBe('post')
    expect(merged.gaps).toEqual([])
  })

  it.each(['blocked-by-you', 'blocking-you'])(
    'replaces a post with a new %s gap (9.4)',
    gap => {
      const merged = later(base, [gapNode(ANCHOR, gap)], {kind: 'resolve'})
      expect(merged.nodes.get(ANCHOR)).toMatchObject({kind: 'gap', gap})
      expect(merged.gaps).toEqual([[ANCHOR, gap]])
    },
  )

  it('keeps the held parentUri for a node sent without one', () => {
    const withGap = first([
      postNode(view('3kroot2222222')),
      gapNode(ANCHOR, 'block-state-unknown', {parentUri: ROOT}),
    ])
    const merged = later(withGap, [gapNode(ANCHOR, 'blocking-you')], {
      kind: 'resolve',
    })
    expect(merged.nodes.get(ANCHOR)?.parentUri).toBe(ROOT)
  })

  it('ors the hidden flag across responses', () => {
    const flagged = later(
      base,
      [
        postNode(view('3kreply222222', {parent: ANCHOR}), {
          hiddenByThreadgate: true,
        }),
      ],
      {kind: 'replies', anchor: ANCHOR, subtree: true},
    )
    expect(flagged.hidden.has(REPLY)).toBe(true)
    const again = later(
      flagged,
      [postNode(view('3kreply222222', {parent: ANCHOR}))],
      {kind: 'replies', anchor: ANCHOR, subtree: true},
    )
    expect(again.hidden.has(REPLY)).toBe(true)
    const resolved = later(again, [gapNode(REPLY, 'blocking-you')], {
      kind: 'resolve',
    })
    expect(resolved.hidden.has(REPLY)).toBe(true)
  })

  it('never replaces a private node, and a private node wins', () => {
    const uri = REPLY
    const privateNode: LensNode = {
      kind: 'private',
      uri,
      parentUri: ANCHOR,
      view: view('3kreply222222', {parent: ANCHOR}),
    }
    const held: MergeBase = {
      ...base,
      nodes: new Map([...base.nodes, [uri, privateNode]]),
    }
    const merged = later(held, [gapNode(uri, 'tier-hidden')], {kind: 'resolve'})
    expect(merged.nodes.get(uri)).toBe(privateNode)
    expect(merged.gaps).toEqual([])
  })

  it('fails closed on a block flag the public pass reports (6.3)', () => {
    const checked = checkLensNodes([
      postNode(view('3kanchor22222', {did: BLOCKED})),
    ])
    const merged = mergeLensNodes(EMPTY_BASE, checked, {
      request: {kind: 'first'},
      bridging: 'full',
      outcomes: new Map([
        [checked[0].uri, {kind: 'gap', gap: 'blocking-you'} as PublicOutcome],
      ]),
    })
    expect(merged.nodes.get(checked[0].uri)).toMatchObject({
      kind: 'gap',
      gap: 'blocking-you',
    })
    expect(merged.gaps).toEqual([[checked[0].uri, 'blocking-you']])
  })
})

describe('markers merge by what was asked (TL-32)', () => {
  const X = ANCHOR
  const Y = REPLY
  const base = first([
    postNode(view('3kroot2222222'), {moreParents: true}),
    postNode(view('3kanchor22222', {parent: ROOT}), {
      moreReplies: {cursor: 'x1'},
    }),
    postNode(view('3kreply222222', {parent: X}), {
      moreReplies: {cursor: 'y1'},
    }),
  ])

  it('"Load more replies" keeps parents and replaces the anchor replies', () => {
    const merged = later(
      base,
      [
        postNode(view('3kanchor22222', {parent: ROOT}), {moreParents: true}),
        postNode(view('3kreply222222', {parent: X})),
        postNode(view('3kdeep2222222', {parent: Y})),
      ],
      {kind: 'replies', anchor: X, subtree: true},
    )
    expect(merged.markers.get(X)).toBeUndefined()
    expect(merged.markers.get(Y)).toBeUndefined()
    expect(merged.markers.get(ROOT)).toEqual({moreParents: true})
  })

  it('keeps a subtree marker under the dev small-page setting', () => {
    const merged = later(
      base,
      [
        postNode(view('3kanchor22222', {parent: ROOT})),
        postNode(view('3kreply222222', {parent: X})),
      ],
      {kind: 'replies', anchor: X, subtree: false},
    )
    expect(merged.markers.get(Y)).toEqual({moreReplies: {cursor: 'y1'}})
    expect(merged.markers.get(X)).toBeUndefined()
  })

  it('"Load earlier posts" keeps the anchor replies', () => {
    const merged = later(
      base,
      [
        postNode(view('3kabove222222'), {moreParents: true}),
        postNode(view('3kroot2222222', {parent: uriOf('3kabove222222')})),
        postNode(view('3kanchor22222', {parent: ROOT})),
      ],
      {kind: 'parents', anchor: X},
    )
    expect(merged.markers.get(X)).toEqual({moreReplies: {cursor: 'x1'}})
    expect(merged.markers.get(uriOf('3kabove222222'))).toEqual({
      moreParents: true,
    })
    expect(merged.markers.get(ROOT)).toEqual({moreParents: true})
  })

  it('a resolve keeps every held marker', () => {
    const merged = later(base, [postNode(view('3kreply222222', {parent: X}))], {
      kind: 'resolve',
    })
    expect(merged.markers.get(Y)).toEqual({moreReplies: {cursor: 'y1'}})
  })
})
