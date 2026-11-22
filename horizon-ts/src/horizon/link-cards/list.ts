/*
 * Link cards for lists: what Discord and other chat apps show for a Horizon
 * list link (`/profile/<name>/lists/<rkey>`). Like a profile card, a list
 * becomes a Mastodon-shaped status: the list's owner (with pronouns) as the
 * author row, the list's name, description, kind and member count as the
 * text, and the list's avatar as the picture. Every other app gets Open
 * Graph tags with the same content.
 *
 * As for posts and profiles: an adult-labelled list's or owner's images are
 * left out. Pure: `fetch.ts` looks things up, this decides what shows.
 * Relative imports only (see `status.ts`).
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

/** What kind of list it is, as the card says it. */
export type ListKind = 'curated' | 'moderation' | 'reference'

/** What a card says about one list. */
export type ListCard = {
  kind: 'list'
  url: string
  uri: string
  name: string
  /** The description, plain. */
  description: string
  listKind: ListKind
  /** Unknown when the AppView doesn't say. */
  memberCount?: number
  /** The list's own avatar. */
  avatar?: string
  /** The list's owner. */
  author: CardAuthor
  createdAt: string
  /** Why the images were left out, to say so on the card. */
  mediaNote?: string
}

/** A list that can't be shown. */
export type MissingListCard = {kind: 'missing-list'; url: string}

function listKind(purpose: string | undefined): ListKind {
  if (purpose === 'app.bsky.graph.defs#modlist') return 'moderation'
  if (purpose === 'app.bsky.graph.defs#referencelist') return 'reference'
  return 'curated'
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
}): ListCard | MissingListCard {
  const view = obj(list)
  const uri = str(view?.uri)
  const name = str(view?.name)?.trim()
  const creator = obj(view?.creator)
  const did = str(creator?.did)
  const handle = str(creator?.handle)
  if (!view || !uri || !name || !did || !handle) {
    return {kind: 'missing-list', url}
  }
  const adult = [...labelVals(view.labels), ...labelVals(creator?.labels)].some(
    label => ADULT_LABELS.has(label),
  )
  const shownPronouns = (pronouns ?? str(creator?.pronouns))?.trim() || undefined
  return {
    kind: 'list',
    url,
    uri,
    name,
    description: str(view.description)?.trim() ?? '',
    listKind: listKind(str(view.purpose)),
    memberCount: num(view.listItemCount),
    ...(adult ? {} : {avatar: str(view.avatar)}),
    author: {
      did,
      handle,
      displayName: str(creator?.displayName)?.trim() || undefined,
      ...(adult ? {} : {avatar: str(creator?.avatar)}),
      ...(shownPronouns ? {pronouns: shownPronouns} : {}),
    },
    createdAt: str(view.indexedAt) ?? '',
    ...(adult ? {mediaNote: 'Images hidden: marked as adult content.'} : {}),
  }
}

const KIND_WORDS: Record<ListKind, string> = {
  curated: 'List',
  moderation: 'Moderation list',
  reference: 'Reference list',
}

/** "Moderation list · 1,234 people" */
export function listLine(card: ListCard): string {
  const parts = [KIND_WORDS[card.listKind]]
  if (card.memberCount !== undefined) {
    const n = card.memberCount
    parts.push(`${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`)
  }
  return parts.join(' · ')
}

function paragraphs(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

/** The status's content HTML: the name, the description, the note, the kind. */
export function listContent(card: ListCard): string {
  const parts = [`<p><b>${escapeHtml(card.name)}</b></p>`]
  if (card.description) parts.push(`<p>${paragraphs(card.description)}</p>`)
  if (card.mediaNote) parts.push(`<p><i>${escapeHtml(card.mediaNote)}</i></p>`)
  parts.push(`<p><b>📋 ${escapeHtml(listLine(card))}</b></p>`)
  return parts.join('')
}

/**
 * The Mastodon-shaped status Discord reads for a list: the owner as the
 * account, the list as the content, the list's avatar as the picture.
 */
export function toMastodonListStatus(
  card: ListCard,
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
    content: listContent(card),
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
    media_attachments: card.avatar
      ? [
          {
            id: `${id}-avatar`,
            type: 'image',
            url: card.avatar,
            preview_url: card.avatar,
            remote_url: null,
            description: `${card.name}'s picture`,
            meta: {},
          },
        ]
      : [],
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    reblog: null,
  }
}

/** The marker that tells a list's status id from a post's or profile's. */
const LIST_MARKER = '@list'

/** The status id for a list: its owner, a marker and its rkey, base64url. */
export function encodeListStatusId(did: string, rkey: string): string {
  const bytes = new TextEncoder().encode(`${did} ${LIST_MARKER} ${rkey}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The owner and rkey a list status id names, or `undefined`. */
export function decodeListStatusId(
  id: string,
): {did: string; rkey: string} | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return undefined
  try {
    const binary = atob(id.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const [did, marker, rkey, extra] = new TextDecoder()
      .decode(bytes)
      .split(' ')
    if (extra !== undefined || marker !== LIST_MARKER || !did || !rkey) {
      return undefined
    }
    if (!/^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(did)) return undefined
    if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(rkey)) return undefined
    return {did, rkey}
  } catch {
    return undefined
  }
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

/**
 * The page a link fetcher gets for a list link: Open Graph tags for every
 * app, and the alternate link that leads Discord to the list's status.
 */
export function listCardPage(
  card: ListCard | MissingListCard,
  origin: string,
): string {
  const head = [
    meta('og:site_name', CARD_SITE_NAME),
    meta('og:url', card.url),
    meta('theme-color', CARD_THEME_COLOR, 'name'),
  ]
  if (card.kind === 'missing-list') {
    const title = 'List not found'
    head.push(
      `<title>${title}</title>`,
      meta('og:title', title),
      meta('og:description', 'This list may not exist. Open Horizon to look.'),
      meta('og:type', 'website'),
      meta('twitter:card', 'summary', 'name'),
      meta('robots', 'noindex', 'name'),
    )
  } else {
    const {author} = card
    const title = `${card.name} – by ${authorLine(author)} (@${author.handle})`
    const description = cut(
      [card.description, listLine(card)].filter(Boolean).join('\n'),
      DESCRIPTION_MAX,
    )
    head.push(
      `<title>${escapeHtml(title)}</title>`,
      meta('og:title', title),
      meta('og:description', description),
      meta('og:type', 'website'),
    )
    const image = card.avatar ?? author.avatar
    if (image) head.push(meta('og:image', image))
    head.push(meta('twitter:card', 'summary', 'name'))
    const rkey = card.uri.split('/').pop() ?? ''
    const id = encodeListStatusId(author.did, rkey)
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
