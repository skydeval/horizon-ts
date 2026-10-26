/*
 * A member's private branches under a lens anchor (Phase 4 design 5.5,
 * TL-28), and the lens "other replies" read.
 *
 * The private replies are read once prism's answer shows the anchor as a
 * post node, beside the public-view pass, through the shared
 * `readPrivateBranches`, and enter the snapshot as private nodes: one item
 * per URI, the private node winning over any lens node of the same URI. A
 * private node is never sent to the public-view pass. Their continuation is
 * the snapshot's `privateCursor`, never the shared `continuation.ts` store,
 * so the stock and lens modes cannot overwrite each other's (R1-L13).
 */

import {logger} from '#/logger'
import {readReplyRefs} from '#/horizon/private/adapt/feed-view'
import {getPrivateReplies} from '#/horizon/private/api/reads'
import {
  adaptTree,
  emitPrivateReplies,
  toTreeNode,
  type TreeNode,
} from '#/horizon/private/thread/fetch'
import {
  type BranchPage,
  type BranchPublicViews,
  type BranchSender,
  readPrivateBranches,
  startPrivateBranchPage,
} from '#/horizon/private/thread/replies'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {
  LENS_PRIVATE_REPLIES_LXM,
  sendLensCall,
} from '#/horizon/thread-lens/direct'
import {type LensNode, viewOf} from '#/horizon/thread-lens/nodes'
import {
  type LensSnapshot,
  type PrivateCursor,
} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView
type OtherOutput = app.bsky.unspecced.getPostThreadOtherV2.$OutputBody

/** The private part of a lens read: private nodes and the continuation. */
export type LensPrivatePart = {
  nodes: LensNode[]
  privateCursor?: PrivateCursor
}

/** The tree's nodes as private lens nodes, parents by their reply refs. */
function privateNodes(
  roots: TreeNode[],
  views: Map<string, PostView>,
  anchorUri: string,
): LensNode[] {
  const out: LensNode[] = []
  const walk = (node: TreeNode, treeParent: string) => {
    const view = views.get(node.input.view.uri)
    if (!view) return
    const parentUri =
      readReplyRefs(node.input.view.record)?.parent.uri ?? treeParent
    out.push({kind: 'private', uri: view.uri, parentUri, view})
    for (const reply of node.replies) walk(reply, view.uri)
  }
  for (const root of roots) walk(root, anchorUri)
  return out
}

/**
 * The anchor's private branches for a lens read (5.5). `publicViews`
 * resolves once the public-view pass is done (or to `undefined` when it
 * failed or made the anchor a gap, which discards the branches). `depth`
 * is the request depth (10 or 6), passed as `below` (v5: R3-N8).
 * `resyncMute` is asked just before the thread-mute re-sync. A failure
 * gives no private part.
 */
export async function readLensPrivatePart({
  anchor,
  depth,
  publicViews,
  resyncMute,
  page,
  onStep,
}: {
  anchor: string
  depth: number
  publicViews: () => Promise<BranchPublicViews>
  resyncMute: () => boolean
  /** The page read started at the read's start ({@link startLensBranches}). */
  page?: Promise<BranchPage>
  /** The timing log's steps. */
  onStep?: (step: string) => void
}): Promise<LensPrivatePart | undefined> {
  const part = await readPrivateBranches(anchor, {
    below: depth,
    cidOf: publicViews,
    resyncMute,
    page,
    send: lensBranchSender(),
    onStep,
  })
  if (!part || 'failed' in part) return undefined
  return {
    nodes: privateNodes(part.nodes, part.views, part.anchorUri),
    ...(part.cursor
      ? {
          privateCursor: {
            anchorUri: part.anchorUri,
            cursor: part.cursor,
            depth: part.depth,
          },
        }
      : {}),
  }
}

/**
 * A lens read's `getReplies` sent to prism directly, as `getThread` is
 * (`direct.ts`: the PDS-proxied client the fallback), for the current
 * account; `undefined` (the proxy) without one.
 */
function lensBranchSender(): BranchSender | undefined {
  const clients = getCurrentClients()
  if (!clients) return undefined
  const {did, prismClient} = clients
  return call =>
    sendLensCall(
      prismClient,
      did,
      LENS_PRIVATE_REPLIES_LXM,
      new AbortController().signal,
      call,
    )
}

/**
 * Start a lens read's private branch page at the read's start, beside
 * `getThread` (2026-10-26, Prism's round 2): `anchor` in DID form, `depth`
 * the request depth. `undefined` when there is nothing to read (not a
 * member, prism not paging replies). Unused when the anchor turns out not
 * to be a post; never rejects.
 */
export function startLensBranches(
  anchor: string,
  depth: number,
): Promise<BranchPage> | undefined {
  return startPrivateBranchPage(anchor, depth, lensBranchSender())
}

/** The most `getReplies` pages one "other replies" read takes. */
export const LENS_OTHER_PAGES = 20

const OTHER_PAGE_LIMIT = 50

/**
 * The lens "other replies" read (5.5, TH-17): the private replies past the
 * snapshot's `privateCursor`, every URI the snapshot holds left out, adapted
 * with the held views' cids. Never `getPostThreadOtherV2`. Nothing without
 * a cursor or when `did` is no longer the current account.
 */
export async function fetchLensOtherReplies(
  snapshot: LensSnapshot,
  {did, sort, signal}: {did: string; sort?: string; signal?: AbortSignal},
): Promise<OtherOutput> {
  const continuation = snapshot.privateCursor
  const clients = getCurrentClients()
  if (!continuation || !clients || clients.did !== did) return {thread: []}
  const seen = new Set(snapshot.nodes.keys())
  const nodes: TreeNode[] = []
  let cursor: string | undefined = continuation.cursor
  let pages = 0
  try {
    while (cursor && pages < LENS_OTHER_PAGES && !signal?.aborted) {
      const asked: string = cursor
      const page = await getPrivateReplies(clients.prismClient, {
        uri: continuation.anchorUri,
        limit: OTHER_PAGE_LIMIT,
        depth: continuation.depth,
        cursor: asked,
      })
      pages++
      for (const raw of page.replies) {
        const node = toTreeNode(raw)
        if (!node || seen.has(node.input.view.uri)) continue
        seen.add(node.input.view.uri)
        nodes.push(node)
      }
      cursor = page.cursor && page.cursor !== asked ? page.cursor : undefined
    }
  } catch (error) {
    logger.warn('thread lens: other private replies unavailable', {
      safeMessage: error,
    })
  }
  if (nodes.length === 0) return {thread: []}
  const cids = new Map<string, string>()
  for (const node of snapshot.nodes.values()) {
    const view = viewOf(node)
    if (view) cids.set(view.uri, view.cid)
  }
  const views = await adaptTree(nodes, clients.appviewClient, uri =>
    cids.get(uri),
  )
  const items = emitPrivateReplies(nodes, 1, {
    sort,
    branchingFactor: undefined,
    views,
  })
  // The two outputs' items differ only in their optional `$type` name.
  return {thread: items as unknown as OtherOutput['thread']}
}
