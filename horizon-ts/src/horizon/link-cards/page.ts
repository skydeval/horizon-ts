/*
 * The page a link fetcher (Discord, Slack, Telegram and the like) gets for
 * a Horizon post link: Open Graph tags for every app, plus, for a public
 * post, the alternate link that leads Discord to the Mastodon-shaped status
 * (`status.ts`). People get the app as usual; only link fetchers are served
 * this page. Relative imports only (see `status.ts`).
 */

import {
  authorLine,
  blankCardText,
  type Card,
  CARD_SITE_NAME,
  CARD_THEME_COLOR,
  encodeStatusId,
  escapeHtml,
  type PostCard,
} from './status'

/*
 * User agents of the apps that fetch a link to draw its card. Matched as
 * words, case-insensitively; a person's browser matches none.
 */
const LINK_FETCHERS = [
  'discordbot',
  'twitterbot',
  'telegrambot',
  'slackbot',
  'slack-imgproxy',
  'facebookexternalhit',
  'whatsapp',
  'skypeuripreview',
  'linkedinbot',
  'mastodon',
  'akkoma',
  'pleroma',
  'misskey',
  'iframely',
  'embedly',
  'redditbot',
  'cardyb',
  'matrix-synapse',
  'vkshare',
]

/** Whether `userAgent` is an app fetching a link to draw its card. */
export function isLinkFetcher(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? '').toLowerCase()
  if (!ua) return false
  return LINK_FETCHERS.some(name => ua.includes(name))
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

function pageHtml(head: string[], url: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    ...head,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    '</head><body>',
    `<p><a href="${escapeHtml(url)}">Open in ${CARD_SITE_NAME}</a></p>`,
    '</body></html>',
  ].join('\n')
}

/** The description line of a post card's tags. */
function postDescription(card: PostCard): string {
  const lines: string[] = []
  if (card.replyTo) {
    lines.push(
      `↳ replying to ${card.replyTo.includes('.') ? `@${card.replyTo}` : card.replyTo}`,
    )
  }
  if (card.contentWarning) lines.push(`⚠️ ${card.contentWarning}`)
  else if (card.text) lines.push(card.text)
  if (card.quote) lines.push(`❝ ${card.quote.author}: ${card.quote.text}`)
  if (card.mediaNote) lines.push(card.mediaNote)
  const {replies, reposts, likes} = card.counts
  lines.push(`💬 ${replies}   🔁 ${reposts}   ❤️ ${likes}`)
  return cut(lines.join('\n'), DESCRIPTION_MAX)
}

/**
 * The page for `card`. `origin` is the site's own (the alternate link and
 * the status live there).
 */
export function linkCardPage(card: Card, origin: string): string {
  const head = [
    meta('og:site_name', CARD_SITE_NAME),
    meta('og:url', card.url),
    meta('theme-color', CARD_THEME_COLOR, 'name'),
  ]
  if (card.kind !== 'post') {
    const {title, description} = blankCardText(card.kind)
    head.push(
      `<title>${escapeHtml(title)}</title>`,
      meta('og:title', title),
      meta('og:description', description),
      meta('og:type', 'website'),
      meta('twitter:card', 'summary', 'name'),
      // No search engine keeps a card that says nothing.
      meta('robots', 'noindex', 'name'),
    )
    return pageHtml(head, card.url)
  }

  const title = `${authorLine(card.author)} (@${card.author.handle})`
  const description = postDescription(card)
  head.push(
    `<title>${escapeHtml(title)}</title>`,
    meta('og:title', title),
    meta('og:description', description),
    meta('og:type', 'article'),
    meta('article:published_time', card.createdAt),
  )
  const image = card.media.find(item => item.type === 'image')
  const video = card.media.find(item => item.type === 'video')
  if (image) {
    head.push(
      meta('og:image', image.url),
      meta('twitter:card', 'summary_large_image', 'name'),
    )
    if (image.description) head.push(meta('og:image:alt', image.description))
  } else if (video?.previewUrl) {
    head.push(
      meta('og:image', video.previewUrl),
      meta('twitter:card', 'summary_large_image', 'name'),
    )
  } else {
    if (card.author.avatar) head.push(meta('og:image', card.author.avatar))
    head.push(meta('twitter:card', 'summary', 'name'))
  }
  if (video) {
    head.push(meta('og:video', video.url), meta('og:video:type', 'video/mp4'))
    if (video.width && video.height) {
      head.push(
        meta('og:video:width', String(video.width)),
        meta('og:video:height', String(video.height)),
      )
    }
  }
  const rkey = card.uri.split('/').pop() ?? ''
  const id = encodeStatusId(card.author.did, rkey)
  const handle = encodeURIComponent(card.author.handle || card.author.did)
  head.push(
    `<link rel="alternate" type="application/activity+json" href="${escapeHtml(
      `${origin}/users/${handle}/statuses/${id}`,
    )}">`,
  )
  return pageHtml(head, card.url)
}
