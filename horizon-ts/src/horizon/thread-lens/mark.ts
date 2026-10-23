/*
 * The lens gap mark (Phase 4 design 8.4, TL-33): `lens=gap` on a post thread
 * link the lens itself draws to a gap (the stock read-more rows on a gap
 * node). A query parameter on web and a route param on native, from the
 * same `href`: the app's router folds query parameters into the params and
 * writes them back, so the mark survives an in-app push, a reload and a tab
 * opened without an opener, with no storage.
 *
 * It can only make a screen stricter: a marked anchor is lens-only even with
 * an empty registry, and the mark is part of the lens key. It is honoured
 * only with `THREAD_LENS` on, signed in and a public anchor; the caller
 * gates it (`useThreadLensRead`).
 */

import {useContext} from 'react'
import {NavigationRouteContext} from '@react-navigation/native'

/** The route parameter's name. */
export const LENS_GAP_PARAM = 'lens'

/** The route parameter's value. */
export const LENS_GAP_VALUE = 'gap'

/** `href` with the lens gap mark appended (once). */
export function withLensGapMark(href: string): string {
  const [path, hash] = href.split('#', 2)
  const query = path.split('?', 2)[1]
  if (
    query
      ?.split('&')
      .some(part => part === `${LENS_GAP_PARAM}=${LENS_GAP_VALUE}`)
  ) {
    return href
  }
  const marked = `${path}${query === undefined ? '?' : '&'}${LENS_GAP_PARAM}=${LENS_GAP_VALUE}`
  return hash === undefined ? marked : `${marked}#${hash}`
}

/** Whether route params carry the mark. */
export function isLensGapMarked(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false
  return (params as Record<string, unknown>)[LENS_GAP_PARAM] === LENS_GAP_VALUE
}

/**
 * Whether the current route carries the mark. Route params are React state;
 * read through the route context, so a hook outside a navigator reads
 * `false` rather than throwing. The params are typed as unknown here, so the
 * stock `PostThread: {name, rkey}` type is not widened.
 */
export function useLensGapMark(): boolean {
  const route = useContext(NavigationRouteContext)
  return isLensGapMarked(route?.params)
}
