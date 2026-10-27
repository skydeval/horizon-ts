/*
 * The quote slot (refract client design 4.4, RF-B6a, as changed by skydeval
 * 2026-10-27). While Refract is active, the record embed's `post_not_found`
 * branch and the `recordWithMedia` record render `RestoredQuoteSlot` in
 * place of stock's "Deleted" box:
 *
 * - "Deleted" at once, as stock shows it. Only for an author on a refracted
 *   community's PDS (or one Horizon can't place, `communities.ts`) does one
 *   background ask run (`askSlot` with `now`: within the frame, merged with
 *   the frame's other cards, re-asked while the author is pending);
 * - a returned post replaces it, as a `viewRecord` built from it, through
 *   the stock `QuoteEmbed` and its moderation (passed in as `render`, so
 *   this module doesn't import it);
 * - "Blocked" for an author in the reader's own block set, an author whose
 *   profile in the answer has a block flag, or a URI `withheld` as
 *   `blocked`.
 *
 * Rules in `quote-status.ts`.
 */

import {useEffect, useSyncExternalStore} from 'react'

import {authorOfUri} from '#/horizon/refract/answer'
import {quoteNeedsFill} from '#/horizon/refract/communities'
import {
  askSlot,
  refractStateVersion,
  refractUriState,
  subscribeRefractState,
} from '#/horizon/refract/fill'
import {useRefractActive} from '#/horizon/refract/gate'
import {readRestored} from '#/horizon/refract/marker'
import {
  quoteStatusOf,
  type RestoredQuoteStatus,
} from '#/horizon/refract/quote-status'
import {
  readRestoredPost,
  restoredStoreVersion,
  subscribeRestoredStore,
} from '#/horizon/refract/store'
import {type app} from '#/lexicons'
import {type EmbedType} from '#/types/bsky/post'

type PostView = app.bsky.feed.defs.PostView

const quoteEmbeds = new WeakMap<PostView, EmbedType<'post'>>()

/** A restored post as the stock parsed quote embed, one per store object. */
export function toRestoredQuoteEmbed(post: PostView): EmbedType<'post'> {
  const cached = quoteEmbeds.get(post)
  if (cached) return cached
  const marker = readRestored(post)
  const embed: EmbedType<'post'> = {
    type: 'post',
    view: {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: post.uri,
      cid: post.cid,
      author: post.author,
      value: post.record,
      labels: post.labels,
      indexedAt: post.indexedAt,
      embeds: post.embed ? [post.embed] : undefined,
      likeCount: post.likeCount,
      replyCount: post.replyCount,
      repostCount: post.repostCount,
      quoteCount: post.quoteCount,
      ...(marker ? {restored: (post as {restored?: unknown}).restored} : {}),
    },
  }
  quoteEmbeds.set(post, embed)
  return embed
}

/**
 * Whether the quote slot replaces stock's "Deleted" box for `uri`, given
 * {@link useRestoredQuoteSlots}. Reads no store itself: a plain store read in
 * render is cached by React Compiler, and refract's gate is often still
 * closed at a fresh page load's first render (prism's membership answer not
 * in yet), which kept a restored quote on "Deleted" after a refresh.
 */
export function restoredQuoteSlotActive(
  uri: string,
  slotsActive: boolean,
): boolean {
  return slotsActive && !!authorOfUri(uri)
}

/** Whether quote slots are on, re-rendering when refract's gate opens. */
export function useRestoredQuoteSlots(): boolean {
  return useRefractActive()
}

/** The slot's status, re-rendering on store and answer changes. */
export function useRestoredPost(uri: string): RestoredQuoteStatus {
  const storeVersion = useSyncExternalStore(subscribeRestoredStore, () =>
    restoredStoreVersion([uri]),
  )
  const answerVersion = useSyncExternalStore(
    subscribeRefractState,
    refractStateVersion,
  )

  useEffect(() => {
    if (readRestoredPost(uri)) return
    const author = authorOfUri(uri)
    if (!author) return
    let mounted = true
    // Only a community author's post can come back (communities.ts).
    void quoteNeedsFill(author).then(needed => {
      if (!needed || !mounted) return
      askSlot(uri, {
        foreground: false,
        now: true,
        live: () => mounted,
      }).catch(() => {})
    })
    return () => {
      mounted = false
    }
  }, [uri])

  // The versions are read so the status follows the store and the answers.
  void storeVersion
  void answerVersion
  return quoteStatusOf(uri, readRestoredPost(uri), refractUriState(uri))
}

/**
 * The quote slot. `render` draws a quote through the stock `QuoteEmbed`;
 * `placeholder` draws stock's "Deleted" or "Blocked" box.
 */
export function RestoredQuoteSlot({
  uri,
  render,
  placeholder,
}: {
  uri: string
  render: (quote: EmbedType<'post'>) => React.ReactNode
  placeholder: (kind: 'deleted' | 'blocked') => React.ReactNode
}) {
  const status = useRestoredPost(uri)
  switch (status.kind) {
    case 'post':
      return render(toRestoredQuoteEmbed(status.post))
    case 'deleted':
      return placeholder('deleted')
    case 'blocked':
      return placeholder('blocked')
  }
}
