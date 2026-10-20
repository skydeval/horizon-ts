/*
 * The profile Media tab as a grid (change list item 6): which feed it
 * applies to, how many tiles a row holds, and what a post's tile shows.
 * Pure; the tile is `MediaGridTile.tsx`, hooked into the stock `PostFeed`
 * through its video grid rows.
 *
 * The grid reads the post views the stock media feed gives, and the private
 * views the adapter builds, so once change list item 4 merges private media
 * into the tab their tiles need nothing more (the lock is drawn by URI).
 */

import {MEDIA_GRID} from '#/horizon/switches'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

const MEDIA_FEED = /^author\|[^|]+\|posts_with_media$/

/** The feed is a profile's Media tab, drawn as a grid. */
export function isMediaGridFeed(feed: string | undefined): boolean {
  return MEDIA_GRID && !!feed && MEDIA_FEED.test(feed)
}

/** Tiles to a row: 3 on a phone-width column, 4 from 800px. */
export function mediaGridColumns(gtMobile: boolean): number {
  return gtMobile ? 4 : 3
}

/**
 * What a tile shows: the first thumbnail (`undefined` for a video without
 * one), its alt text, how many media the post has, and whether it is a
 * video.
 */
export type GridMedia = {
  kind: 'image' | 'video'
  thumb: string | undefined
  alt: string
  count: number
}

function fromMedia(media: unknown): GridMedia | undefined {
  if (bsky.isType(app.bsky.embed.images.view, media)) {
    const first = media.images[0]
    if (!first) return undefined
    return {
      kind: 'image',
      thumb: first.thumb,
      alt: first.alt,
      count: media.images.length,
    }
  }
  if (bsky.isType(app.bsky.embed.gallery.view, media)) {
    const images = media.items.filter(item =>
      bsky.isType(app.bsky.embed.gallery.viewImage, item),
    )
    const first = images[0]
    if (!first) return undefined
    return {
      kind: 'image',
      thumb: first.thumbnail,
      alt: first.alt,
      count: images.length,
    }
  }
  if (bsky.isType(app.bsky.embed.video.view, media)) {
    return {
      kind: 'video',
      thumb: media.thumbnail,
      alt: media.alt ?? '',
      count: 1,
    }
  }
  return undefined
}

/**
 * A post's tile, from its embed view: images, a gallery or a video, top
 * level or in a quote with media. `undefined` for a post without media,
 * which the grid leaves out.
 */
export function gridMediaOf(embed: unknown): GridMedia | undefined {
  if (bsky.isType(app.bsky.embed.recordWithMedia.view, embed)) {
    return fromMedia(embed.media)
  }
  return fromMedia(embed)
}

/** The post has a tile on the grid. */
export function hasGridMedia(post: {embed?: unknown}): boolean {
  return gridMediaOf(post.embed) !== undefined
}
