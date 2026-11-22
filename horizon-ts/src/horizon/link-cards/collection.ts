/*
 * Link cards for lists, custom feeds and starter packs: what Discord and
 * other chat apps show for those Horizon links. Like a profile card, each
 * becomes a Mastodon-shaped status: the owner (with pronouns) as the author
 * row, the name, description and a line of facts (kind, size) as the text,
 * and the picture (a list's or feed's avatar, a starter pack's first
 * members) as the media. Every other app gets Open Graph tags with the same
 * content.
 *
 * As for posts and profiles: adult-labelled images are left out. Pure:
 * `fetch.ts` looks things up, this decides what shows. Relative imports
 * only (see `status.ts`).
 */

import {
  ADULT_LABELS,
  authorLine,
  CARD_SITE_NAME,
  CARD_THEME_COLOR,
  type CardAuthor,
  escapeHtml,
} from './status'

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function labelVals(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map(label => str(obj(label)?.val))
    .filter((val): val is string => !!val)
}

function isAdult(...labels: unknown[]): boolean {
  return labels.some(value =>
    labelVals(value).some(label => ADULT_LABELS.has(label)),
  )
}

/** Which kind of link the card is for. */
export type CollectionType = 'list' | 'feed' | 'starter-pack'

/** What a card says about one list, feed or starter pack. */
export type CollectionCard = {
  kind: 'collection'
  type: CollectionType
  url: string
  uri: string
  name: string
  /** The description, plain. */
  description: string
  /** The facts line, e.g. "Moderation list · 1,234 people". */
  facts: string
  /** The pictures: a list's or feed's avatar, a pack's first members. */
  images: {url: string; description: string}[]
  /** The owner. */
  author: CardAuthor
  createdAt: string
  /** Why the images were left out, to say so on the card. */
  mediaNote?: string
}

/** A list, feed or starter pack that can't be shown. */
export type MissingCollectionCard = {
  kind: 'missing-collection'
  type: CollectionType
  url: string
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

function owner(creator: Obj | undefined, pronouns: string | undefined) {
  const did = str(creator?.did)
  const handle = str(creator?.handle)
  if (!did || !handle) return undefined
  const shown = (pronouns ?? str(creator?.pronouns))?.trim() || undefined
  return {
    did,
    handle,
    displayName: str(creator?.displayName)?.trim() || undefined,
    avatar: str(creator?.avatar),
    ...(shown ? {pronouns: shown} : {}),
  } satisfies CardAuthor
}

const ADULT_NOTE = 'Images hidden: marked as adult content.'

function finish(
  base: Omit<CollectionCard, 'kind' | 'images' | 'mediaNote'>,
  images: CollectionCard['images'],
  adult: boolean,
): CollectionCard {
  if (!adult) return {kind: 'collection', ...base, images}
  const {avatar: _, ...author} = base.author
  return {
    kind: 'collection',
    ...base,
    author,
    images: [],
    mediaNote: ADULT_NOTE,
  }
}

const LIST_KIND: Record<string, string> = {
  'app.bsky.graph.defs#modlist': 'Moderation list',
  'app.bsky.graph.defs#referencelist': 'Reference list',
}

/**
 * The card for a list, from the public AppView's `getList` answer and the
 * owner's pronouns to show (Horizon's record, else Bluesky's field).
 */
export function buildListCard({
  list,
  url,
  pronouns,
}: {
  list: unknown
  url: string
  pronouns?: string
}): CollectionCard | MissingCollectionCard {
  const view = obj(list)
  const creator = obj(view?.creator)
  const uri = str(view?.uri)
  const name = str(view?.name)?.trim()
  const author = owner(creator, pronouns)
  if (!view || !uri || !name || !author) {
    return {kind: 'missing-collection', type: 'list', url}
  }
  const facts = [LIST_KIND[str(view.purpose) ?? ''] ?? 'List']
  const members = num(view.listItemCount)
  if (members !== undefined) facts.push(count(members, 'person', 'people'))
  const avatar = str(view.avatar)
  return finish(
    {
      type: 'list',
      url,
      uri,
      name,
      description: str(view.description)?.trim() ?? '',
      facts: facts.join(' · '),
      author,
      createdAt: str(view.indexedAt) ?? '',
    },
    avatar ? [{url: avatar, description: `${name}'s picture`}] : [],
    isAdult(view.labels, creator?.labels),
  )
}

/** The card for a custom feed, from `getFeedGenerator`'s `view`. */
export function buildFeedCard({
  feed,
  url,
  pronouns,
}: {
  feed: unknown
  url: string
  pronouns?: string
}): CollectionCard | MissingCollectionCard {
  const view = obj(feed)
  const creator = obj(view?.creator)
  const uri = str(view?.uri)
  const name = str(view?.displayName)?.trim()
  const author = owner(creator, pronouns)
  if (!view || !uri || !name || !author) {
    return {kind: 'missing-collection', type: 'feed', url}
  }
  const facts = ['Feed']
  const likes = num(view.likeCount)
  if (likes !== undefined) facts.push(count(likes, 'like', 'likes'))
  const avatar = str(view.avatar)
  return finish(
    {
      type: 'feed',
      url,
      uri,
      name,
      description: str(view.description)?.trim() ?? '',
      facts: facts.join(' · '),
      author,
      createdAt: str(view.indexedAt) ?? '',
    },
    avatar ? [{url: avatar, description: `${name}'s picture`}] : [],
    isAdult(view.labels, creator?.labels),
  )
}

/** At most this many member avatars on a starter pack's card. */
const PACK_FACES = 4

/** The card for a starter pack, from `getStarterPack`'s `starterPack`. */
export function buildStarterPackCard({
  pack,
  url,
  pronouns,
}: {
  pack: unknown
  url: string
  pronouns?: string
}): CollectionCard | MissingCollectionCard {
  const view = obj(pack)
  const record = obj(view?.record)
  const creator = obj(view?.creator)
  const uri = str(view?.uri)
  const name = str(record?.name)?.trim()
  const author = owner(creator, pronouns)
  if (!view || !uri || !name || !author) {
    return {kind: 'missing-collection', type: 'starter-pack', url}
  }
  const facts = ['Starter pack']
  const members = num(obj(view.list)?.listItemCount)
  if (members !== undefined) facts.push(count(members, 'person', 'people'))
  const feeds = Array.isArray(view.feeds) ? view.feeds.length : 0
  if (feeds > 0) facts.push(count(feeds, 'feed', 'feeds'))
  const joined = num(view.joinedAllTimeCount)
  if (joined) facts.push(`${joined.toLocaleString('en-US')} joined`)
  const faces: CollectionCard['images'] = []
  for (const item of Array.isArray(view.listItemsSample)
    ? view.listItemsSample
    : []) {
    if (faces.length >= PACK_FACES) break
    const subject = obj(obj(item)?.subject)
    const avatar = str(subject?.avatar)
    if (!avatar || isAdult(subject?.labels)) continue
    faces.push({
      url: avatar,
      description: `${str(subject?.displayName)?.trim() || str(subject?.handle) || 'A member'}'s avatar`,
    })
  }
  return finish(
    {
      type: 'starter-pack',
      url,
      uri,
      name,
      description: str(record?.description)?.trim() ?? '',
      facts: facts.join(' · '),
      author,
      createdAt: str(record?.createdAt) ?? str(view.indexedAt) ?? '',
    },
    faces,
    isAdult(view.labels, creator?.labels),
  )
}

function paragraphs(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

const FACTS_ICON: Record<CollectionType, string> = {
  list: '📋',
  feed: '📰',
  'starter-pack': '🎒',
}

/** The status's content HTML: the name, description, note and facts. */
export function collectionContent(card: CollectionCard): string {
  const parts = [`<p><b>${escapeHtml(card.name)}</b></p>`]
  if (card.description) parts.push(`<p>${paragraphs(card.description)}</p>`)
  if (card.mediaNote) parts.push(`<p><i>${escapeHtml(card.mediaNote)}</i></p>`)
  parts.push(`<p><b>${FACTS_ICON[card.type]} ${escapeHtml(card.facts)}</b></p>`)
  return parts.join('')
}

/**
 * The Mastodon-shaped status Discord reads for a list, feed or starter
 * pack: the owner as the account, the card as the content, its pictures as
 * the media.
 */
export function toMastodonCollectionStatus(
  card: CollectionCard,
  {id, origin}: {id: string; origin: string},
): Obj {
  const {author} = card
  const ownerUrl = `${origin}/profile/${encodeURIComponent(
    author.handle || author.did,
  )}`
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
    language: null,
    content: collectionContent(card),
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    application: {name: CARD_SITE_NAME, website: origin},
    account: {
      id: author.did,
      username: author.handle,
      acct: author.handle,
      display_name: authorLine(author),
      url: ownerUrl,
      uri: ownerUrl,
      avatar: author.avatar ?? '',
      avatar_static: author.avatar ?? '',
      header: '',
      header_static: '',
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
    media_attachments: card.images.map((image, index) => ({
      id: `${id}-${index}`,
      type: 'image',
      url: image.url,
      preview_url: image.url,
      remote_url: null,
      description: image.description,
      meta: {},
    })),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    reblog: null,
  }
}

/** The markers that tell these status ids from a post's or profile's. */
const MARKERS: Record<CollectionType, string> = {
  list: '@list',
  feed: '@feed',
  'starter-pack': '@pack',
}

/** The status id for a list, feed or pack: owner, marker, rkey, base64url. */
export function encodeCollectionStatusId(
  type: CollectionType,
  did: string,
  rkey: string,
): string {
  const bytes = new TextEncoder().encode(`${did} ${MARKERS[type]} ${rkey}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** What a list, feed or pack status id names, or `undefined`. */
export function decodeCollectionStatusId(
  id: string,
): {type: CollectionType; did: string; rkey: string} | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return undefined
  try {
    const binary = atob(id.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const [did, marker, rkey, extra] = new TextDecoder()
      .decode(bytes)
      .split(' ')
    const type = (Object.keys(MARKERS) as CollectionType[]).find(
      key => MARKERS[key] === marker,
    )
    if (extra !== undefined || !type || !did || !rkey) return undefined
    if (!/^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(did)) return undefined
    if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(rkey)) return undefined
    return {type, did, rkey}
  } catch {
    return undefined
  }
}

/** The link to a list, feed or pack on `origin`. */
export function collectionUrl(
  type: CollectionType,
  origin: string,
  name: string,
  rkey: string,
): string {
  const n = encodeURIComponent(name)
  const r = encodeURIComponent(rkey)
  if (type === 'list') return `${origin}/profile/${n}/lists/${r}`
  if (type === 'feed') return `${origin}/profile/${n}/feed/${r}`
  return `${origin}/starter-pack/${n}/${r}`
}

/** The longest description a card's tags carry. */
const DESCRIPTION_MAX = 300

function cut(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

function meta(property: string, content: string, attr = 'property'): string {
  return `<meta ${attr}="${property}" content="${escapeHtml(content)}">`
}

const MISSING_WORDS: Record<CollectionType, [string, string]> = {
  list: ['List not found', 'This list may not exist. Open Horizon to look.'],
  feed: ['Feed not found', 'This feed may not exist. Open Horizon to look.'],
  'starter-pack': [
    'Starter pack not found',
    'This starter pack may not exist. Open Horizon to look.',
  ],
}

/**
 * The page a link fetcher gets for a list, feed or starter pack link: Open
 * Graph tags for every app, and the alternate link that leads Discord to
 * the card's status.
 */
export function collectionCardPage(
  card: CollectionCard | MissingCollectionCard,
  origin: string,
): string {
  const head = [
    meta('og:site_name', CARD_SITE_NAME),
    meta('og:url', card.url),
    meta('theme-color', CARD_THEME_COLOR, 'name'),
  ]
  if (card.kind === 'missing-collection') {
    const [title, description] = MISSING_WORDS[card.type]
    head.push(
      `<title>${title}</title>`,
      meta('og:title', title),
      meta('og:description', description),
      meta('og:type', 'website'),
      meta('twitter:card', 'summary', 'name'),
      meta('robots', 'noindex', 'name'),
    )
  } else {
    const {author} = card
    const title = `${card.name} – by ${authorLine(author)} (@${author.handle})`
    const description = cut(
      [card.description, card.facts].filter(Boolean).join('\n'),
      DESCRIPTION_MAX,
    )
    head.push(
      `<title>${escapeHtml(title)}</title>`,
      meta('og:title', title),
      meta('og:description', description),
      meta('og:type', 'website'),
    )
    const image = card.images[0]?.url ?? author.avatar
    if (image) head.push(meta('og:image', image))
    head.push(meta('twitter:card', 'summary', 'name'))
    const rkey = card.uri.split('/').pop() ?? ''
    const id = encodeCollectionStatusId(card.type, author.did, rkey)
    const handle = encodeURIComponent(author.handle || author.did)
    head.push(
      `<link rel="alternate" type="application/activity+json" href="${escapeHtml(
        `${origin}/users/${handle}/statuses/${id}`,
      )}">`,
    )
  }
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    ...head,
    `<link rel="canonical" href="${escapeHtml(card.url)}">`,
    '</head><body>',
    `<p><a href="${escapeHtml(card.url)}">Open in ${CARD_SITE_NAME}</a></p>`,
    '</body></html>',
  ].join('\n')
}
