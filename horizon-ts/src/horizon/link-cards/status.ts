/*
 * Link cards (skydeval, 2026-10-27, style D): what Discord and other chat
 * apps show for a Horizon post link. A public post becomes a Mastodon-shaped
 * status, the shape Discord draws its fuller card from (author row, text,
 * up to four images or a video, footer); a kryphocron post always gets the
 * same hidden card and nothing about it is looked up.
 *
 * Pure: the Cloudflare functions in `functions/` fetch, this module decides
 * what shows. Relative imports only, as those functions are bundled without
 * the app's path aliases.
 *
 * Nothing hidden in Horizon is shown here: a content warning shows only its
 * line, spoilers and flagged media are left out, adult-labelled media is
 * left out, and an author who asked not to be shown to signed-out readers
 * gets a card with nothing of theirs on it.
 */

import {CW_SELF_LABEL, MEDIA_SPOILER_FIELD} from '../media-spoilers/nsid'

/*
 * The spoiler facet features, as `spoilers/nsid.ts` names them. Copied, as
 * that module imports `@atproto/lex` (for a type), which the functions'
 * bundle should not pull in.
 */
const SPOILER_FEATURE = 'app.nearhorizon.richtext.facet#spoiler'
const SPOILER_MARKER_FEATURE = 'app.nearhorizon.richtext.facet#spoilerMarker'
const CONTENT_WARNING_FEATURE = 'app.nearhorizon.richtext.facet#contentWarning'

/** The name and colour the cards carry. */
export const CARD_SITE_NAME = 'Horizon'
export const CARD_THEME_COLOR = '#3f9b5a'

/** Labels whose media never goes on a card. */
const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media'])

/** The author's opt-out from being shown to signed-out readers. */
const NO_UNAUTHENTICATED = '!no-unauthenticated'

/** At most this many media items, as Discord's grid. */
const MAX_MEDIA = 4

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** HTML-escapes text for the status content and the page's meta tags. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A post's author, as the card names them. */
export type CardAuthor = {
  did: string
  handle: string
  displayName?: string
  avatar?: string
  banner?: string
  /** Formatted pronouns ("she/they"), when the author has set them. */
  pronouns?: string
}

/** One media item on the card. */
export type CardMedia = {
  type: 'image' | 'video' | 'gifv'
  url: string
  previewUrl?: string
  description?: string
  width?: number
  height?: number
}

/** What a card says about one public post. */
export type PostCard = {
  kind: 'post'
  uri: string
  url: string
  author: CardAuthor
  createdAt: string
  /** The text lines, plain; spoilers already replaced. */
  text: string
  /** A content warning's line; the text and media are then left out. */
  contentWarning?: string
  replyTo?: string
  quote?: {author: string; handle: string; text: string}
  media: CardMedia[]
  /** Why some media was left out, to say so on the card. */
  mediaNote?: string
  counts: {replies: number; reposts: number; likes: number}
  language?: string
}

/** The card for a post that can't be shown. */
export type BlankCard = {
  kind: 'hidden' | 'signedInOnly' | 'missing'
  url: string
}

export type Card = PostCard | BlankCard

/** The hidden card's words (skydeval's chosen layout). */
export function blankCardText(kind: BlankCard['kind']): {
  title: string
  description: string
} {
  switch (kind) {
    case 'hidden':
      return {
        title: '🔒 Private post',
        description:
          'Only the people it was shared with can see this. Open it in Horizon.',
      }
    case 'signedInOnly':
      return {
        title: 'Post on Horizon',
        description:
          'This account asks to be shown only to signed-in people. Open it in Horizon.',
      }
    case 'missing':
      return {
        title: 'Post not found',
        description: 'This post may have been deleted. Open Horizon to look.',
      }
  }
}

/**
 * The text with every spoiler range replaced by a block, from the post's
 * facets (UTF-8 byte ranges). Kept `||` markers go too.
 */
export function maskSpoilers(text: string, facets: unknown): string {
  const ranges: {start: number; end: number; marker: boolean}[] = []
  for (const facet of arr(facets)) {
    const f = obj(facet)
    const index = obj(f?.index)
    if (!index) continue
    const features = arr(f?.features)
    const spoiler = features.some(
      feature =>
        str(obj(feature)?.$type) === SPOILER_FEATURE ||
        str(obj(feature)?.$type) === CONTENT_WARNING_FEATURE,
    )
    const marker = features.some(
      feature => str(obj(feature)?.$type) === SPOILER_MARKER_FEATURE,
    )
    if (!spoiler && !marker) continue
    const start = num(index.byteStart)
    const end = num(index.byteEnd)
    if (end > start) ranges.push({start, end, marker: marker && !spoiler})
  }
  if (ranges.length === 0) return text
  ranges.sort((a, b) => a.start - b.start)
  const bytes = new TextEncoder().encode(text)
  const decoder = new TextDecoder()
  let out = ''
  let at = 0
  for (const range of ranges) {
    if (range.start < at) continue
    out += decoder.decode(bytes.slice(at, range.start))
    if (!range.marker) out += '▒▒▒'
    at = Math.min(range.end, bytes.length)
  }
  out += decoder.decode(bytes.slice(at))
  return out
}

function labelValues(labels: unknown): string[] {
  return arr(labels)
    .map(label => str(obj(label)?.val))
    .filter((val): val is string => !!val)
}

function selfLabelValues(record: Obj | undefined): string[] {
  const labels = obj(record?.labels)
  return arr(labels?.values)
    .map(value => str(obj(value)?.val))
    .filter((val): val is string => !!val)
}

/** The author asked not to be shown to signed-out readers. */
export function isSignedInOnly(author: unknown): boolean {
  return labelValues(obj(author)?.labels).includes(NO_UNAUTHENTICATED)
}

function authorOf(view: Obj | undefined, pronouns?: string): CardAuthor {
  return {
    did: str(view?.did) ?? '',
    handle: str(view?.handle) ?? '',
    displayName: str(view?.displayName)?.trim() || undefined,
    avatar: str(view?.avatar),
    banner: str(view?.banner),
    pronouns: pronouns?.trim() || undefined,
  }
}

/** The CW line: the record's text up to its first line break. */
function contentWarningLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.replace(/\|\|/g, '').trim() || 'Content warning'
}

type MediaResult = {media: CardMedia[]; hiddenFlagged: number}

/**
 * The media of an embed view, with the record's per-item spoiler flags
 * (`app.nearhorizon.spoiler`) leaving flagged items out. `videoUrl` turns a
 * video's blob into something Discord can play (its stream is HLS).
 */
function mediaOf(
  embedView: Obj | undefined,
  embedRecord: Obj | undefined,
  videoUrl: (cid: string) => string | undefined,
): MediaResult {
  const out: MediaResult = {media: [], hiddenFlagged: 0}
  if (!embedView) return out
  const type = str(embedView.$type) ?? ''
  if (type.startsWith('app.bsky.embed.recordWithMedia')) {
    return mediaOf(obj(embedView.media), obj(embedRecord?.media), videoUrl)
  }
  if (type.startsWith('app.bsky.embed.images')) {
    const recordImages = arr(embedRecord?.images)
    arr(embedView.images).forEach((image, i) => {
      const view = obj(image)
      if (!view) return
      if (obj(recordImages[i])?.[MEDIA_SPOILER_FIELD] === true) {
        out.hiddenFlagged++
        return
      }
      const fullsize = str(view.fullsize)
      if (!fullsize) return
      const ratio = obj(view.aspectRatio)
      out.media.push({
        type: 'image',
        url: fullsize,
        previewUrl: str(view.thumb),
        description: str(view.alt) || undefined,
        width: num(ratio?.width) || undefined,
        height: num(ratio?.height) || undefined,
      })
    })
    return out
  }
  if (type.startsWith('app.bsky.embed.video')) {
    if (embedRecord?.[MEDIA_SPOILER_FIELD] === true) {
      out.hiddenFlagged++
      return out
    }
    const cid = str(embedView.cid)
    const url = cid ? videoUrl(cid) : undefined
    const ratio = obj(embedView.aspectRatio)
    if (url) {
      out.media.push({
        type: 'video',
        url,
        previewUrl: str(embedView.thumbnail),
        description: str(embedView.alt) || undefined,
        width: num(ratio?.width) || undefined,
        height: num(ratio?.height) || undefined,
      })
    } else if (str(embedView.thumbnail)) {
      out.media.push({type: 'image', url: str(embedView.thumbnail)!})
    }
    return out
  }
  if (type.startsWith('app.bsky.embed.external')) {
    // A GIF from Bluesky's picker: an external link to a Tenor GIF.
    const external = obj(embedView.external)
    const uri = str(external?.uri) ?? ''
    if (/^https:\/\/media\.tenor\.com\/.+\.gif(\?|$)/.test(uri)) {
      const size = new URL(uri).searchParams
      out.media.push({
        type: 'image',
        url: uri,
        description: str(external?.description) || undefined,
        width: Number(size.get('ww')) || undefined,
        height: Number(size.get('hh')) || undefined,
      })
    } else if (str(external?.thumb)) {
      out.media.push({type: 'image', url: str(external?.thumb)!})
    }
    return out
  }
  return out
}

/** The quoted post of an embed view, when it is a viewable record. */
function quoteOf(embedView: Obj | undefined): PostCard['quote'] {
  if (!embedView) return undefined
  const type = str(embedView.$type) ?? ''
  const record = type.startsWith('app.bsky.embed.recordWithMedia')
    ? obj(obj(embedView.record)?.record)
    : type.startsWith('app.bsky.embed.record')
      ? obj(embedView.record)
      : undefined
  if (!record || str(record.$type) !== 'app.bsky.embed.record#viewRecord') {
    return undefined
  }
  const author = obj(record.author)
  if (isSignedInOnly(author)) return undefined
  const value = obj(record.value)
  if (selfLabelValues(value).includes(CW_SELF_LABEL)) {
    return {
      author: str(author?.displayName) || str(author?.handle) || '',
      handle: str(author?.handle) ?? '',
      text: `⚠️ ${contentWarningLine(str(value?.text) ?? '')}`,
    }
  }
  return {
    author: str(author?.displayName) || str(author?.handle) || '',
    handle: str(author?.handle) ?? '',
    text: maskSpoilers(str(value?.text) ?? '', value?.facets),
  }
}

/**
 * The card for a public post, from the AppView's thread view of it (`post`
 * with its `parent`) and the author's pronouns.
 */
export function buildPostCard({
  thread,
  url,
  pronouns,
  videoUrl = () => undefined,
}: {
  thread: unknown
  url: string
  pronouns?: string
  videoUrl?: (cid: string) => string | undefined
}): Card {
  const threadView = obj(thread)
  const post = obj(threadView?.post)
  if (!post) return {kind: 'missing', url}
  const author = obj(post.author)
  if (isSignedInOnly(author)) return {kind: 'signedInOnly', url}
  const record = obj(post.record)
  const text = str(record?.text) ?? ''
  const labels = [...labelValues(post.labels), ...selfLabelValues(record)]
  const parentAuthor = obj(obj(obj(threadView?.parent)?.post)?.author)
  const replyTo = obj(record?.reply)
    ? str(parentAuthor?.handle) || 'a post'
    : undefined

  const card: PostCard = {
    kind: 'post',
    uri: str(post.uri) ?? '',
    url,
    author: authorOf(author, pronouns),
    createdAt: str(record?.createdAt) ?? str(post.indexedAt) ?? '',
    text: '',
    replyTo,
    media: [],
    counts: {
      replies: num(post.replyCount),
      reposts: num(post.repostCount) + num(post.quoteCount),
      likes: num(post.likeCount),
    },
    language: str(arr(record?.langs)[0]),
  }

  if (labels.includes(CW_SELF_LABEL)) {
    card.contentWarning = contentWarningLine(text)
    card.mediaNote = 'Open the post to see what the warning covers.'
    return card
  }

  card.text = maskSpoilers(text, record?.facets)
  card.quote = quoteOf(obj(post.embed))
  const adult = labels.some(label => ADULT_LABELS.has(label))
  const {media, hiddenFlagged} = mediaOf(
    obj(post.embed),
    obj(record?.embed),
    videoUrl,
  )
  if (adult && media.length + hiddenFlagged > 0) {
    card.mediaNote = 'Media hidden: marked as adult content.'
  } else {
    card.media = media.slice(0, MAX_MEDIA)
    if (hiddenFlagged > 0) {
      card.mediaNote =
        hiddenFlagged === 1
          ? '1 item hidden as a spoiler.'
          : `${hiddenFlagged} items hidden as spoilers.`
    }
  }
  return card
}

/** "Wren · she/they", or the handle when there is no display name. */
export function authorLine(author: CardAuthor): string {
  const name = author.displayName || author.handle
  return author.pronouns ? `${name} · ${author.pronouns}` : name
}

function paragraphs(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

/** The status's content HTML: reply line, text, quote, note, counts. */
export function statusContent(card: PostCard): string {
  const parts: string[] = []
  if (card.replyTo) {
    parts.push(
      `<p>↳ replying to ${escapeHtml(
        card.replyTo.includes('.') ? `@${card.replyTo}` : card.replyTo,
      )}</p>`,
    )
  }
  if (card.contentWarning) {
    parts.push(`<p><b>⚠️ ${escapeHtml(card.contentWarning)}</b></p>`)
  } else if (card.text) {
    parts.push(`<p>${paragraphs(card.text)}</p>`)
  }
  if (card.quote) {
    parts.push(
      `<blockquote><b>${escapeHtml(card.quote.author)}</b> (@${escapeHtml(
        card.quote.handle,
      )})<br>${paragraphs(card.quote.text)}</blockquote>`,
    )
  }
  if (card.mediaNote) parts.push(`<p><i>${escapeHtml(card.mediaNote)}</i></p>`)
  const {replies, reposts, likes} = card.counts
  parts.push(`<p><b>💬 ${replies}   🔁 ${reposts}   ❤️ ${likes}</b></p>`)
  return parts.join('')
}

/**
 * The Mastodon-shaped status Discord reads (`GET /api/v1/statuses/:id`).
 * `id` is the status id the page's alternate link carried.
 */
export function toMastodonStatus(
  card: PostCard,
  {id, origin}: {id: string; origin: string},
): Obj {
  const profileUrl = `${origin}/profile/${card.author.handle || card.author.did}`
  return {
    id,
    url: card.url,
    uri: card.url,
    created_at: card.createdAt,
    edited_at: null,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: false,
    spoiler_text: '',
    visibility: 'public',
    language: card.language ?? null,
    content: statusContent(card),
    replies_count: card.counts.replies,
    reblogs_count: card.counts.reposts,
    favourites_count: card.counts.likes,
    application: {name: CARD_SITE_NAME, website: origin},
    account: {
      id: card.author.did,
      username: card.author.handle,
      acct: card.author.handle,
      display_name: authorLine(card.author),
      url: profileUrl,
      uri: profileUrl,
      avatar: card.author.avatar ?? '',
      avatar_static: card.author.avatar ?? '',
      header: card.author.banner ?? '',
      header_static: card.author.banner ?? '',
      locked: false,
      bot: false,
      group: false,
      discoverable: true,
      created_at: card.createdAt,
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      note: '',
      emojis: [],
      fields: [],
    },
    media_attachments: card.media.map((item, i) => ({
      id: `${id}-${i + 1}`,
      type: item.type,
      url: item.url,
      preview_url: item.previewUrl ?? item.url,
      remote_url: null,
      description: item.description ?? null,
      meta:
        item.width && item.height
          ? {original: {width: item.width, height: item.height}}
          : {},
    })),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    reblog: null,
  }
}

/** The status id for a post: its DID and rkey, base64url-encoded. */
export function encodeStatusId(did: string, rkey: string): string {
  const bytes = new TextEncoder().encode(`${did} ${rkey}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The DID and rkey a status id names, or `undefined` if it is not one. */
export function decodeStatusId(
  id: string,
): {did: string; rkey: string} | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return undefined
  try {
    const binary = atob(id.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const [did, rkey, extra] = new TextDecoder().decode(bytes).split(' ')
    if (extra !== undefined || !did || !rkey) return undefined
    if (!/^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(did)) return undefined
    if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(rkey)) return undefined
    return {did, rkey}
  } catch {
    return undefined
  }
}
