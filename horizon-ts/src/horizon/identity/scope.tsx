/*
 * The post a component draws, for its author line, avatar and anchor
 * (Phase 5 design PP-15, 11): each post component wraps its author area in
 * `PostFrontersScope` with the post's URI, author DID and record, so no
 * stock prop or type changes. Every reader checks the author DID: a scope
 * read for any other DID (a quoted post's author drawn inside the quoting
 * post's scope, a reply parent's name) gives nothing, so the caller shows
 * its stock fallback (P5R1-N1).
 */

import {createContext, useContext} from 'react'

/** What a scope holds. */
export type PostFrontersScopeValue = {
  uri: string
  authorDid: string
  /** The post record as the view carries it. */
  record: unknown
}

const ScopeContext = createContext<PostFrontersScopeValue | undefined>(
  undefined,
)

/**
 * Wrap a post's author area. `post` is the post view (or any value with its
 * URI, author DID and record).
 */
export function PostFrontersScope({
  post,
  children,
}: {
  post: {uri: string; author: {did: string}; record: unknown}
  children: React.ReactNode
}) {
  const value = {uri: post.uri, authorDid: post.author.did, record: post.record}
  return <ScopeContext value={value}>{children}</ScopeContext>
}

/**
 * The scope around this component when it is drawing its author `did`,
 * else `undefined` (no scope, or the scope of another DID).
 */
export function usePostFrontersScope(
  did: string | undefined,
): PostFrontersScopeValue | undefined {
  const scope = useContext(ScopeContext)
  if (!scope || !did || scope.authorDid !== did) return undefined
  return scope
}
