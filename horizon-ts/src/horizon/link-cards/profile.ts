/*
 * Link cards for profiles: what Discord and other chat apps show for a
 * Horizon profile link (`/profile/<name>`). Like a post card, a profile
 * becomes a Mastodon-shaped status, the shape Discord draws its fuller card
 * from: the avatar and name (with pronouns) as the author row, the bio and
 * the follower, following and post counts as the text, and the banner as the
 * picture. Every other app gets Open Graph tags with the same content.
 *
 * As for posts: an adult-labelled account's avatar and banner are left out,
 * and like bsky.app's cards, a profile shows whatever its owner's signed-out
 * setting. Pure: `fetch.ts` looks things up, this decides what shows.
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

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** What a card says about one profile. */
export type ProfileCard = {
  kind: 'profile'
  url: string
  author: CardAuthor
  /** The bio, plain. */
  bio: string
  counts: {followers: number; follows: number; posts: number}
  createdAt: string
  /** Why the avatar and banner were left out, to say so on the card. */
  mediaNote?: string
}

/** A profile that can't be shown. */
export type MissingProfileCard = {kind: 'missing-profile'; url: string}

/**
 * The card for a profile, from the public AppView's `getProfile` answer and
 * the pronouns to show (Horizon's record, else Bluesky's field).
 */
export function buildProfileCard({
  profile,
  url,
  pronouns,
}: {
  profile: unknown
  url: string
  pronouns?: string
}): ProfileCard | MissingProfileCard {
  const view = obj(profile)
  const did = str(view?.did)
  const handle = str(view?.handle)
  if (!view || !did || !handle) return {kind: 'missing-profile', url}
  const labels = (Array.isArray(view.labels) ? view.labels : [])
    .map(label => str(obj(label)?.val))
    .filter((val): val is string => !!val)
  const adult = labels.some(label => ADULT_LABELS.has(label))
  const shownPronouns = (pronouns ?? str(view.pronouns))?.trim() || undefined
  return {
    kind: 'profile',
    url,
    author: {
      did,
      handle,
      displayName: str(view.displayName)?.trim() || undefined,
      ...(adult ? {} : {avatar: str(view.avatar), banner: str(view.banner)}),
      ...(shownPronouns ? {pronouns: shownPronouns} : {}),
    },
    bio: str(view.description)?.trim() ?? '',
    counts: {
      followers: num(view.followersCount),
      follows: num(view.followsCount),
      posts: num(view.postsCount),
    },
    createdAt: str(view.createdAt) ?? str(view.indexedAt) ?? '',
    ...(adult ? {mediaNote: 'Images hidden: marked as adult content.'} : {}),
  }
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** "1,234 followers · 56 following · 789 posts" */
export function countsLine(counts: ProfileCard['counts']): string {
  return [
    count(counts.followers, 'follower', 'followers'),
    `${counts.follows.toLocaleString('en-US')} following`,
    count(counts.posts, 'post', 'posts'),
  ].join(' · ')
}

function paragraphs(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

/** The status's content HTML: the bio, the note, the counts. */
export function profileContent(card: ProfileCard): string {
  const parts: string[] = []
  if (card.bio) parts.push(`<p>${paragraphs(card.bio)}</p>`)
  if (card.mediaNote) parts.push(`<p><i>${escapeHtml(card.mediaNote)}</i></p>`)
  parts.push(`<p><b>👥 ${escapeHtml(countsLine(card.counts))}</b></p>`)
  return parts.join('')
}

/**
 * The Mastodon-shaped status Discord reads for a profile: the profile as the
 * account, the bio and counts as the content, the banner as the picture.
 */
export function toMastodonProfileStatus(
  card: ProfileCard,
  {id, origin}: {id: string; origin: string},
): Obj {
  const {author} = card
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
    content: profileContent(card),
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    application: {name: CARD_SITE_NAME, website: origin},
    account: {
      id: author.did,
      username: author.handle,
      acct: author.handle,
      display_name: authorLine(author),
      url: card.url,
      uri: card.url,
      avatar: author.avatar ?? '',
      avatar_static: author.avatar ?? '',
      header: author.banner ?? '',
      header_static: author.banner ?? '',
      locked: false,
      bot: false,
      group: false,
      discoverable: true,
      created_at: card.createdAt,
      followers_count: card.counts.followers,
      following_count: card.counts.follows,
      statuses_count: card.counts.posts,
      note: '',
      emojis: [],
      fields: [],
    },
    media_attachments: author.banner
      ? [
          {
            id: `${id}-banner`,
            type: 'image',
            url: author.banner,
            preview_url: author.banner,
            remote_url: null,
            description: `${authorLine(author)}'s banner`,
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

/** The marker that tells a profile's status id from a post's. */
const PROFILE_MARKER = '@profile'

/** The status id for a profile: its DID and a marker, base64url-encoded. */
export function encodeProfileStatusId(did: string): string {
  const bytes = new TextEncoder().encode(`${did} ${PROFILE_MARKER}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The DID a profile status id names, or `undefined` if it is not one. */
export function decodeProfileStatusId(id: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return undefined
  try {
    const binary = atob(id.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const [did, marker, extra] = new TextDecoder().decode(bytes).split(' ')
    if (extra !== undefined || marker !== PROFILE_MARKER || !did)
      return undefined
    return /^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(did) ? did : undefined
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
 * The page a link fetcher gets for a profile link: Open Graph tags for every
 * app, and the alternate link that leads Discord to the profile's status.
 */
export function profileCardPage(
  card: ProfileCard | MissingProfileCard,
  origin: string,
): string {
  const head = [
    meta('og:site_name', CARD_SITE_NAME),
    meta('og:url', card.url),
    meta('theme-color', CARD_THEME_COLOR, 'name'),
  ]
  if (card.kind === 'missing-profile') {
    const title = 'Profile not found'
    head.push(
      `<title>${title}</title>`,
      meta('og:title', title),
      meta(
        'og:description',
        'This account may not exist. Open Horizon to look.',
      ),
      meta('og:type', 'website'),
      meta('twitter:card', 'summary', 'name'),
      meta('robots', 'noindex', 'name'),
    )
  } else {
    const {author} = card
    const title = `${authorLine(author)} (@${author.handle})`
    const description = cut(
      [card.bio, countsLine(card.counts)].filter(Boolean).join('\n'),
      DESCRIPTION_MAX,
    )
    head.push(
      `<title>${escapeHtml(title)}</title>`,
      meta('og:title', title),
      meta('og:description', description),
      meta('og:type', 'profile'),
      meta('profile:username', author.handle),
    )
    if (author.banner) {
      head.push(
        meta('og:image', author.banner),
        meta('twitter:card', 'summary_large_image', 'name'),
      )
    } else {
      if (author.avatar) head.push(meta('og:image', author.avatar))
      head.push(meta('twitter:card', 'summary', 'name'))
    }
    const id = encodeProfileStatusId(author.did)
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
