/*
 * The Cloudflare Pages functions behind link cards, as plain request
 * handlers (the files in `functions/` only call these):
 *
 * - `/profile/:name/post/:rkey`: a link fetcher gets the card page; anyone
 *   else gets the app, untouched.
 * - `/profile/:name/ppost/:rkey`: a link fetcher gets the hidden card. A
 *   kryphocron post is never looked up, not even its author.
 * - `/api/v1/statuses/:id`: the Mastodon-shaped status the card page's
 *   alternate link leads Discord to; public posts only.
 *
 * A failure on the card side falls back to the app (pages) or a 404
 * (status), never an error page. Relative imports only (see `status.ts`).
 */

import {loadPostCard} from './fetch'
import {isLinkFetcher, linkCardPage} from './page'
import {decodeStatusId, toMastodonStatus} from './status'

/** The parts of a Pages function context the handlers use. */
export type PagesContext = {
  request: Request
  params: Record<string, string | string[] | undefined>
  next: () => Promise<Response>
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** How long a fetched card may be reused, in seconds. */
const CARD_MAX_AGE = 300

function param(ctx: PagesContext, key: string): string {
  const value = ctx.params[key]
  return typeof value === 'string' ? value : ''
}

function cardResponse(html: string): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=${CARD_MAX_AGE}`,
      vary: 'user-agent',
    },
  })
}

/** `/profile/:name/post/:rkey` */
export async function handlePostPage(
  ctx: PagesContext,
  fetchImpl: Fetch = fetch,
): Promise<Response> {
  if (!isLinkFetcher(ctx.request.headers.get('user-agent'))) return ctx.next()
  try {
    const origin = new URL(ctx.request.url).origin
    const name = param(ctx, 'name')
    const rkey = param(ctx, 'rkey')
    const url = `${origin}/profile/${encodeURIComponent(name)}/post/${encodeURIComponent(rkey)}`
    const card = await loadPostCard({name, rkey, url, fetchImpl})
    return cardResponse(linkCardPage(card, origin))
  } catch {
    return ctx.next()
  }
}

/** `/profile/:name/ppost/:rkey` */
export async function handlePrivatePostPage(
  ctx: PagesContext,
): Promise<Response> {
  if (!isLinkFetcher(ctx.request.headers.get('user-agent'))) return ctx.next()
  const requestUrl = new URL(ctx.request.url)
  const url = `${requestUrl.origin}${requestUrl.pathname}`
  return cardResponse(linkCardPage({kind: 'hidden', url}, requestUrl.origin))
}

/** `/api/v1/statuses/:id` */
export async function handleStatus(
  ctx: PagesContext,
  fetchImpl: Fetch = fetch,
): Promise<Response> {
  const notFound = () =>
    new Response(JSON.stringify({error: 'Record not found'}), {
      status: 404,
      headers: {'content-type': 'application/json'},
    })
  const id = param(ctx, 'id')
  const decoded = decodeStatusId(id)
  if (!decoded) return notFound()
  try {
    const origin = new URL(ctx.request.url).origin
    const card = await loadPostCard({
      name: decoded.did,
      rkey: decoded.rkey,
      url: '',
      fetchImpl,
    })
    if (card.kind !== 'post') return notFound()
    card.url = `${origin}/profile/${encodeURIComponent(
      card.author.handle || card.author.did,
    )}/post/${encodeURIComponent(decoded.rkey)}`
    return new Response(JSON.stringify(toMastodonStatus(card, {id, origin})), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${CARD_MAX_AGE}`,
        'access-control-allow-origin': '*',
      },
    })
  } catch {
    return notFound()
  }
}
