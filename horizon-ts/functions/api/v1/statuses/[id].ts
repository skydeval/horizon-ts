/*
 * Cloudflare Pages function (link cards): the Mastodon-shaped status Discord
 * reads for a post link's richer card. See
 * src/horizon/link-cards/handlers.ts.
 */

import {
  handleStatus,
  type PagesContext,
} from '../../../../src/horizon/link-cards/handlers'

export const onRequestGet = (ctx: PagesContext) => handleStatus(ctx)
