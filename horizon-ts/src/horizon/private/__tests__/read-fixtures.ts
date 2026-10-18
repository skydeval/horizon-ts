import {type app} from '#/lexicons'
/*
 * Fixtures for the reading tests: prism private post views, public feed
 * items, and fake prism and AppView clients built on `fakeClient`. Tests that
 * use them must unmock `multiformats/cid` and `multiformats/hashes/hasher`
 * (the lex client validates the CIDs in prism's answers).
 */
import {
  BLOB_CID,
  DID,
  fakeClient,
  privateUri,
  RECORD_CID,
  type Reply,
} from './fixtures'

export const PP = 'tools.kryphocron.feed.postPrivate'
export const AUDIENCE_URI = `at://${DID}/tools.kryphocron.policy.audience/3kaudience22`

/** A second CID, for refs that must differ from `RECORD_CID`. */
export const OTHER_CID = BLOB_CID

/**
 * An ISO time `minutes` after a fixed origin.
 */
export function at(minutes: number): string {
  return new Date(
    Date.UTC(2026, 9, 15, 10, 0, 0) + minutes * 60_000,
  ).toISOString()
}

export type Ref = {uri: string; cid?: string}

/**
 * A prism private post view as prism serves it.
 */
export function privateView(
  rkey: string,
  {
    did = DID,
    handle = 'author.test',
    minutes = 0,
    text = `post ${rkey}`,
    reply,
    cid = RECORD_CID,
  }: {
    did?: string
    handle?: string
    minutes?: number
    text?: string
    reply?: {root: Ref; parent: Ref}
    cid?: string
  } = {},
) {
  return {
    uri: privateUri(rkey, did),
    cid,
    author: {did, handle} as app.bsky.actor.defs.ProfileViewBasic,
    record: {
      $type: PP,
      text,
      createdAt: at(minutes),
      audienceList: AUDIENCE_URI,
      ...(reply ? {reply} : {}),
    },
    indexedAt: at(minutes),
    labels: [],
  }
}

export type PrivateView = ReturnType<typeof privateView>

/**
 * A public Following item at `minutes`.
 */
export function publicItem(id: string, minutes: number) {
  return {
    post: {
      uri: `at://did:plc:publicccccccccccccccccccc/app.bsky.feed.post/${id}`,
      cid: RECORD_CID,
      author: {did: 'did:plc:publicccccccccccccccccccc', handle: 'pub.test'},
      record: {
        $type: 'app.bsky.feed.post',
        text: id,
        createdAt: at(minutes),
      },
      indexedAt: at(minutes),
    },
  }
}

/**
 * A fake public AppView: `getProfiles` answers from `profiles`, `getPosts`
 * from `posts`, `getProfile` from `profile`, `resolveHandle` from `handles`.
 */
export function fakeAppview({
  profiles = [],
  posts = [],
  profile,
  handles = {},
  failProfiles = false,
}: {
  profiles?: {did: string; handle: string; [k: string]: unknown}[]
  posts?: {uri: string; [k: string]: unknown}[]
  profile?: Record<string, unknown>
  handles?: Record<string, string>
  failProfiles?: boolean
} = {}) {
  return fakeClient(DID, (call): Reply => {
    switch (call.nsid) {
      case 'app.bsky.actor.getProfiles': {
        if (failProfiles) return {status: 500, body: {error: 'Internal'}}
        const wanted = call.params.getAll('actors')
        return {
          status: 200,
          body: {profiles: profiles.filter(p => wanted.includes(p.did))},
        }
      }
      case 'app.bsky.feed.getPosts': {
        const wanted = call.params.getAll('uris')
        return {
          status: 200,
          body: {posts: posts.filter(p => wanted.includes(p.uri))},
        }
      }
      case 'app.bsky.actor.getProfile':
        return profile
          ? {status: 200, body: profile}
          : {status: 400, body: {error: 'InvalidRequest'}}
      case 'com.atproto.identity.resolveHandle': {
        const did = handles[call.params.get('handle') ?? '']
        return did
          ? {status: 200, body: {did}}
          : {status: 400, body: {error: 'HandleNotFound'}}
      }
      default:
        return {status: 501, body: {error: 'MethodNotImplemented'}}
    }
  })
}

/**
 * A fake prism serving `posts` to `getPosts`.
 */
export function fakePrism({
  posts = [],
  handler,
}: {
  posts?: PrivateView[]
  handler?: (nsid: string, params: URLSearchParams) => Reply | undefined
} = {}) {
  return fakeClient(DID, (call): Reply => {
    const custom = handler?.(call.nsid, call.params)
    if (custom) return custom
    if (call.nsid === 'app.nearhorizon.private.getPosts') {
      const wanted = call.params.getAll('uris')
      return {
        status: 200,
        body: {posts: posts.filter(p => wanted.includes(p.uri))},
      }
    }
    return {status: 501, body: {error: 'MethodNotImplemented'}}
  })
}
