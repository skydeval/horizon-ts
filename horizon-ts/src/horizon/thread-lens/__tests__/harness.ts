/*
 * Fixtures for the Thread Lens tests: post views, prism lens nodes, and fake
 * prism and AppView servers whose replies can carry headers (the 429 wait
 * reads `Retry-After` and `ratelimit-reset`). Tests that use the servers
 * must unmock `multiformats/cid` and `multiformats/hashes/hasher` (the lex
 * client validates the CIDs in the AppView's answers).
 */

import {type Client} from '@atproto/lex'
import {type ModerationOpts} from '@bsky/sdk/moderation'
import {QueryClient} from '@tanstack/react-query'

import {createLexClient} from '#/lib/lexClient'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {type app} from '#/lexicons'

type PostView = app.bsky.feed.defs.PostView

/** The reader. */
export const READER = 'did:plc:readeraaaaaaaaaaaaaaaaaa'
/** A second account, for account switches. */
export const OTHER_READER = 'did:plc:otherreaderbbbbbbbbbbbbb'
/** The thread's author. */
export const AUTHOR = 'did:plc:authorcccccccccccccccccc'
/** Someone in a block with the reader. */
export const BLOCKED = 'did:plc:blockedddddddddddddddddd'

/** A dag-cbor CID, as records have. */
export const RECORD_CID =
  'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'

/** An ISO time `minutes` after a fixed origin. */
export function at(minutes: number): string {
  return new Date(
    Date.UTC(2026, 9, 15, 10, 0, 0) + minutes * 60_000,
  ).toISOString()
}

/** A public post URI. */
export function uriOf(rkey: string, did = AUTHOR): string {
  return `at://${did}/app.bsky.feed.post/${rkey}`
}

/** A private post URI. */
export function privateUriOf(rkey: string, did = AUTHOR): string {
  return `at://${did}/tools.kryphocron.feed.postPrivate/${rkey}`
}

/** A public post view. */
export function view(
  rkey: string,
  {
    did = AUTHOR,
    minutes = 0,
    parent,
    root,
    likeCount = 0,
    replyCount = 0,
    labels,
    authorViewer,
    threadgate,
    extra = {},
  }: {
    did?: string
    minutes?: number
    parent?: string
    root?: string
    likeCount?: number
    replyCount?: number
    labels?: {val: string; src?: string}[]
    authorViewer?: Record<string, unknown>
    threadgate?: Record<string, unknown>
    extra?: Record<string, unknown>
  } = {},
): PostView {
  const uri = uriOf(rkey, did)
  return {
    uri,
    cid: RECORD_CID,
    author: {
      did,
      handle: `${did.slice(8, 14)}.test`,
      ...(authorViewer ? {viewer: authorViewer} : {}),
    },
    record: {
      $type: 'app.bsky.feed.post',
      text: `post ${rkey}`,
      createdAt: at(minutes),
      ...(parent
        ? {
            reply: {
              parent: {uri: parent, cid: RECORD_CID},
              root: {uri: root ?? parent, cid: RECORD_CID},
            },
          }
        : {}),
    },
    indexedAt: at(minutes),
    likeCount,
    replyCount,
    repostCount: 0,
    quoteCount: 0,
    labels: (labels ?? []).map(label => ({
      src: label.src ?? 'did:plc:labelereeeeeeeeeeeeeeeee',
      uri,
      val: label.val,
      cts: at(0),
    })),
    ...(threadgate ? {threadgate} : {}),
    ...extra,
  } as unknown as PostView
}

/** A prism post node for `post`. */
export function postNode(
  post: PostView,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const parent = (post.record as {reply?: {parent: {uri: string}}}).reply
    ?.parent.uri
  return {
    uri: post.uri,
    ...(parent ? {parentUri: parent} : {}),
    post,
    ...extra,
  }
}

/** A prism gap node. */
export function gapNode(
  uri: string,
  gap: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {uri, gap, ...extra}
}

/** One request a fake server received. */
export type Call = {
  nsid: string
  params: URLSearchParams
  body: Record<string, unknown> | undefined
  /** The request's headers, as the client sent them. */
  headers: Headers
}

/** A fake server's reply: status, JSON body and headers, or a network error. */
export type Reply =
  {status: number; body?: unknown; headers?: Record<string, string>} | Error

/** A lex client whose requests go to `handler`, each recorded in `calls`. */
export function server(
  did: string,
  handler: (call: Call) => Reply | undefined | Promise<Reply | undefined>,
): {client: Client; calls: Call[]} {
  const calls: Call[] = []
  const client = createLexClient(
    {
      did: did as `did:${string}:${string}`,
      fetchHandler: async (path: string, init: RequestInit) => {
        const url = new URL(path, 'https://server.example')
        const nsid = url.pathname.replace('/xrpc/', '')
        let body: Record<string, unknown> | undefined
        if (typeof init.body === 'string') {
          body = JSON.parse(init.body) as Record<string, unknown>
        } else if (init.body instanceof Uint8Array) {
          body = JSON.parse(new TextDecoder().decode(init.body)) as Record<
            string,
            unknown
          >
        }
        const call = {
          nsid,
          params: url.searchParams,
          body,
          headers: new Headers(init.headers),
        }
        calls.push(call)
        const reply = (await handler(call)) ?? {
          status: 501,
          body: {error: 'MethodNotImplemented'},
        }
        if (reply instanceof Error) throw reply
        return new Response(JSON.stringify(reply.body ?? {}), {
          status: reply.status,
          headers: {'content-type': 'application/json', ...reply.headers},
        })
      },
    },
    {appLabelers: null},
  )
  return {client, calls}
}

/** A `getThread` answer body. */
export function lensAnswer(
  anchor: string,
  nodes: unknown[],
  bridging = 'full',
) {
  return {status: 200, body: {anchor, nodes, truncated: false, bridging}}
}

/**
 * A fake public AppView: `getPosts` answers from `posts` (by URI, read at
 * call time, so a test may add to the array later), or fails with a 500
 * while `fail()` says so.
 */
export function fakeAppview({
  posts = [],
  fail = () => false,
}: {
  posts?: PostView[]
  fail?: () => boolean
} = {}) {
  return server(READER, call => {
    if (call.nsid === 'app.bsky.feed.getPosts') {
      if (fail()) return {status: 500, body: {error: 'InternalServerError'}}
      const wanted = call.params.getAll('uris')
      return {
        status: 200,
        body: {
          posts: wanted
            .map(uri => posts.find(post => post.uri === uri))
            .filter((post): post is PostView => !!post),
        },
      }
    }
    if (call.nsid === 'app.bsky.actor.getProfiles') {
      return {status: 200, body: {profiles: []}}
    }
    return undefined
  })
}

/** A promise resolved from outside, for held requests. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return {promise, resolve}
}

/** Wait (real timers) until `check` holds. */
export async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('until: timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Publish `did`'s clients with a fresh query client, which is returned. */
export function publishClients({
  did = READER,
  prism,
  appview,
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, structuralSharing: false}},
  }),
}: {
  did?: string
  prism: Client
  appview: Client
  queryClient?: QueryClient
}): QueryClient {
  clearCurrentClients()
  publishCurrentClients({
    did,
    handle: 'reader.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: prism,
    appviewClient: appview,
    queryClient,
  })
  return queryClient
}

/** Moderation options with nothing set, for the real traversal. */
export const MODERATION_OPTS: ModerationOpts = {
  userDid: READER,
  prefs: {
    adultContentEnabled: false,
    labels: {},
    labelers: [],
    mutedWords: [],
    hiddenPosts: [],
  },
  labelDefs: {},
}

/** Wait for every pending promise callback (no timers). */
export async function flush(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
