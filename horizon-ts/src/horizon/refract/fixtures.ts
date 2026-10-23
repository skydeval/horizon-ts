/*
 * Synthetic restored-account fixtures (refract client design 11.1, 11.3).
 * Every id, name and text here is made up; none is a real account's data.
 * Shared by the Jest suites and the development fixtures. Each builder
 * returns a fresh object, since the normalizer edits answers in place.
 */

export const RF_DID = 'did:plc:rfxrestored000000000000001'
export const RF_DID_2 = 'did:plc:rfxrestored000000000000002'
export const RF_STOCK_DID = 'did:plc:rfxstock0000000000000000001'
export const RF_READER_DID = 'did:plc:rfxreader000000000000000001'
export const RF_COMMUNITY = 'rfxcommunity'
export const RF_LABELER = 'did:plc:rfxlabeler00000000000000001'

export function rfUri(rkey: string, did: string = RF_DID) {
  return `at://${did}/app.bsky.feed.post/${rkey}`
}

const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NOW = '2026-10-23T10:00:00.000Z'

export function rfMarker(): Record<string, unknown> {
  return {community: RF_COMMUNITY, tier: 1, labeler: RF_LABELER}
}

export function rfProfileBasic(
  did: string = RF_DID,
  {restored = true, viewer}: {restored?: boolean; viewer?: object} = {},
): Record<string, unknown> {
  return {
    did,
    handle: `${did.slice(-6)}.example.test`,
    displayName: 'Synthetic Person',
    viewer: viewer ?? {muted: false, blockedBy: false},
    labels: [],
    ...(restored ? {restored: rfMarker()} : {}),
  }
}

export function rfProfile(
  did: string = RF_DID,
  options: {restored?: boolean; viewer?: object} = {},
): Record<string, unknown> {
  return {
    ...rfProfileBasic(did, options),
    description: 'A synthetic profile for tests.',
    followersCount: 12,
    followsCount: 7,
    postsCount: 3,
    indexedAt: NOW,
  }
}

export function rfPost(
  rkey: string,
  {
    did = RF_DID,
    restored = true,
    reply,
    createdAt = NOW,
    likeCount = 1,
    viewer,
  }: {
    did?: string
    restored?: boolean
    reply?: {parent: string; root: string}
    createdAt?: string
    likeCount?: number
    viewer?: object
  } = {},
): Record<string, unknown> {
  return {
    uri: rfUri(rkey, did),
    cid: CID,
    author: rfProfileBasic(did, {restored}),
    record: {
      $type: 'app.bsky.feed.post',
      text: `synthetic post ${rkey}`,
      createdAt,
      ...(reply
        ? {
            reply: {
              parent: {uri: reply.parent, cid: CID},
              root: {uri: reply.root, cid: CID},
            },
          }
        : {}),
    },
    replyCount: 0,
    repostCount: 0,
    likeCount,
    quoteCount: 0,
    indexedAt: createdAt,
    viewer: viewer ?? {},
    labels: [],
    ...(restored ? {restored: rfMarker()} : {}),
  }
}

/** A `fill` answer. */
export function rfFillAnswer({
  profiles = [],
  posts = [],
  pending = [],
  withheld,
  servedAs,
  viewerChecked,
}: {
  profiles?: Record<string, unknown>[]
  posts?: Record<string, unknown>[]
  pending?: string[]
  withheld?: {id: string; reason: string}[]
  servedAs?: 'member' | 'visitor'
  viewerChecked?: {posts: string[]; actors: string[]; roots: string[]}
} = {}): Record<string, unknown> {
  return {
    profiles,
    posts,
    pending,
    ...(withheld ? {withheld} : {}),
    ...(servedAs ? {servedAs} : {}),
    ...(viewerChecked ? {viewerChecked} : {}),
  }
}

/** A `getAuthorFeed` page with a repost of a stock post. */
export function rfAuthorFeedPage(): Record<string, unknown> {
  return {
    feed: [
      {post: rfPost('rf1')},
      {
        post: rfPost('stock1', {did: RF_STOCK_DID, restored: false}),
        reason: {
          $type: 'app.bsky.feed.defs#reasonRepost',
          by: rfProfileBasic(),
          indexedAt: NOW,
        },
      },
    ],
    cursor: 'rf-cursor-1',
  }
}

/** A v1 `threadViewPost` for a restored anchor with one reply. */
export function rfThread(): Record<string, unknown> {
  return {
    thread: {
      $type: 'app.bsky.feed.defs#threadViewPost',
      post: rfPost('rf1'),
      replies: [
        {
          $type: 'app.bsky.feed.defs#threadViewPost',
          post: rfPost('stockreply', {
            did: RF_STOCK_DID,
            restored: false,
            reply: {parent: rfUri('rf1'), root: rfUri('rf1')},
          }),
          replies: [],
        },
      ],
    },
  }
}
