/*
 * The media spoiler scope around one media embed (2J design, 6.2): which of
 * its items are flagged and which are still covered, and the reveals. The
 * cells, the lightbox call and the video's autoplay read it. Reveals are
 * kept by thumbnail (a video's by thumbnail or playlist), not by index, so a
 * reveal cannot move to another item when the view is rebuilt under the same
 * post URI, and start over when the URI changes. There is no re-hide (MS-7).
 *
 * Image cells do not know their index, so they look up by thumbnail; a video
 * scope has one item, which a video cell looks up as item 0, never by its
 * optional thumbnail.
 */

import {createContext, useContext, useState} from 'react'
import {useLingui} from '@lingui/react/macro'

import {IS_WEB} from '#/env'
import {type app} from '#/lexicons'
import {
  mediaItemKeys,
  mediaSpoilerState,
  type MediaView,
  shownFlags,
} from './read'
import {mediaSpoilersOn} from './switches-read'

export type MediaSpoilerScopeValue = {
  flaggedAt: (index: number) => boolean
  coveredAt: (index: number) => boolean
  revealAt: (index: number) => void
  /** Any flagged item has this thumbnail. */
  flaggedThumb: (uri: string) => boolean
  /** Any flagged item with this thumbnail is still covered. */
  coveredThumb: (uri: string) => boolean
  revealThumb: (uri: string) => void
  /** The post is a CW post: the pills read "Content warning". */
  contentWarning: boolean
  /** Per item, whether it may be shown: not flagged, or revealed. */
  revealedFlags: () => boolean[]
}

const MediaSpoilerContext = createContext<MediaSpoilerScopeValue | undefined>(
  undefined,
)
MediaSpoilerContext.displayName = 'HorizonMediaSpoilerContext'

type RevealState = {uri: string | undefined; keys: readonly string[]}

/**
 * Hooks MS 20 and MS 21. With `MEDIA_SPOILERS` off it renders only its
 * children and provides nothing, so every reader gets the stock answer.
 */
export function MediaSpoilerScope({
  post,
  embed,
  children,
}: {
  post?: app.bsky.feed.defs.PostView
  embed: {view: MediaView}
  children: React.ReactNode
}) {
  if (!mediaSpoilersOn()) return <>{children}</>
  return (
    <MediaSpoilerScopeInner post={post} view={embed.view}>
      {children}
    </MediaSpoilerScopeInner>
  )
}

function MediaSpoilerScopeInner({
  post,
  view,
  children,
}: {
  post?: app.bsky.feed.defs.PostView
  view: MediaView
  children: React.ReactNode
}) {
  const uri = post?.uri
  const [reveal, setReveal] = useState<RevealState>(() => ({uri, keys: []}))
  let current = reveal
  // A derived reset during render, as the text spoilers' state does.
  if (reveal.uri !== uri) {
    current = {uri, keys: []}
    setReveal(current)
  }

  // Without a post, nothing is flagged.
  const {flags, contentWarning} = mediaSpoilerState(post?.record, view)
  const keys = mediaItemKeys(view)
  const revealed = new Set(current.keys)
  const revealKey = (key: string | undefined) => {
    if (key === undefined) return
    setReveal(s =>
      s.keys.includes(key) ? s : {uri: s.uri, keys: [...s.keys, key]},
    )
  }
  const flaggedAt = (i: number) => flags[i] === true
  const coveredAt = (i: number) => flaggedAt(i) && !revealed.has(keys[i])
  const withThumb = (uri: string) =>
    keys.flatMap((key, i) => (key === uri ? [i] : []))

  const value: MediaSpoilerScopeValue = {
    flaggedAt,
    coveredAt,
    revealAt: i => revealKey(keys[i]),
    flaggedThumb: thumb => withThumb(thumb).some(flaggedAt),
    coveredThumb: thumb => withThumb(thumb).some(coveredAt),
    revealThumb: thumb => revealKey(thumb),
    contentWarning,
    revealedFlags: () => shownFlags(flags, keys, revealed),
  }
  return (
    <MediaSpoilerContext.Provider value={value}>
      {children}
    </MediaSpoilerContext.Provider>
  )
}

/**
 * The enclosing scope, if any (hook MS 22).
 */
export function useMediaSpoilerScope(): MediaSpoilerScopeValue | undefined {
  return useContext(MediaSpoilerContext)
}

export type MediaSpoilerCellState = {
  flagged: boolean
  covered: boolean
  contentWarning: boolean
  /** The cover's screen-reader label (6.7). */
  coverLabel: string
  coverHint: string
  reveal: () => void
}

/**
 * One cell's state: an image by its thumbnail, a video as item 0. Outside a
 * scope nothing is flagged.
 */
export function useMediaSpoilerCell(
  thumb: string | undefined,
  kind: 'image' | 'video' = 'image',
): MediaSpoilerCellState {
  const {t: l} = useLingui()
  const scope = useMediaSpoilerScope()
  const flagged = !scope
    ? false
    : kind === 'video'
      ? scope.flaggedAt(0)
      : thumb !== undefined && scope.flaggedThumb(thumb)
  const covered =
    flagged && !!scope
      ? kind === 'video'
        ? scope.coveredAt(0)
        : thumb !== undefined && scope.coveredThumb(thumb)
      : false
  const contentWarning = scope?.contentWarning ?? false

  let coverLabel: string
  if (kind === 'video') {
    coverLabel = contentWarning
      ? IS_WEB
        ? l({
            message: 'Video behind a content warning, tap to reveal',
            comment: 'Screen reader label of a covered video, on web',
          })
        : l({
            message: 'Video behind a content warning',
            comment: 'Screen reader label of a covered video',
          })
      : IS_WEB
        ? l({
            message: 'Spoiler video, tap to reveal',
            comment: 'Screen reader label of a covered video, on web',
          })
        : l({
            message: 'Spoiler video',
            comment: 'Screen reader label of a covered video',
          })
  } else {
    coverLabel = contentWarning
      ? IS_WEB
        ? l({
            message: 'Image behind a content warning, tap to reveal',
            comment: 'Screen reader label of a covered image, on web',
          })
        : l({
            message: 'Image behind a content warning',
            comment: 'Screen reader label of a covered image',
          })
      : IS_WEB
        ? l({
            message: 'Spoiler image, tap to reveal',
            comment: 'Screen reader label of a covered image, on web',
          })
        : l({
            message: 'Spoiler image',
            comment: 'Screen reader label of a covered image',
          })
  }

  return {
    flagged,
    covered,
    contentWarning,
    coverLabel,
    coverHint: l({
      message: 'Tap to reveal',
      comment: 'Screen reader hint of a covered image or video',
    }),
    reveal: () => {
      if (!scope) return
      if (kind === 'video') scope.revealAt(0)
      else if (thumb !== undefined) scope.revealThumb(thumb)
    },
  }
}

/**
 * The video's autoplay is held: item 0 of the scope is flagged, covered or
 * revealed (6.5). Hooks MS 32 and MS 34.
 */
export function useMediaSpoilerHoldsAutoplay(): boolean {
  return useMediaSpoilerScope()?.flaggedAt(0) ?? false
}
