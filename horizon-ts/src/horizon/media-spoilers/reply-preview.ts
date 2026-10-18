/*
 * The composer's reply preview images (2J design, 6.13, MS-15). The preview
 * carries no record, so the post is found as the text preview finds it (the
 * query cache, then the post query under the same key, so no second
 * request). The images are left out when the record has spoiler media or a
 * CW, and while no matching record is known (loading, failed, or a record
 * with other text): fail closed.
 */

import {useQueryClient} from '@tanstack/react-query'

import {usePostQuery} from '#/state/queries/post'
import {type ComposerOptsPostRef} from '#/state/shell/composer'
import {
  findCachedPostRecord,
  matchingRecord,
} from '#/horizon/spoilers/reply-preview'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {recordHasMediaSpoilers} from './read'
import {mediaSpoilersOn} from './switches-read'

/**
 * The preview's images are left out, given the matching record if one is
 * known.
 */
export function replyToMediaCovered(record: unknown): boolean {
  if (!mediaSpoilersOn()) return false
  if (record === undefined) return true
  return recordHasMediaSpoilers(record)
}

/**
 * The preview has images to draw.
 */
function hasPreviewImages(embed: ComposerOptsPostRef['embed']): boolean {
  const media = bsky.isType(app.bsky.embed.recordWithMedia.view, embed)
    ? embed.media
    : embed
  return (
    bsky.isType(app.bsky.embed.images.view, media) ||
    bsky.isType(app.bsky.embed.gallery.view, media)
  )
}

/**
 * Hook MS 39.
 */
export function useReplyToMediaCovered(replyTo: ComposerOptsPostRef): boolean {
  const queryClient = useQueryClient()
  const asks = mediaSpoilersOn() && hasPreviewImages(replyTo.embed)
  const cached = asks
    ? findCachedPostRecord(queryClient, replyTo.uri, replyTo.text)
    : undefined
  const query = usePostQuery(asks && !cached ? replyTo.uri : undefined)
  if (!asks) return false
  return replyToMediaCovered(cached ?? matchingRecord(query.data, replyTo.text))
}
