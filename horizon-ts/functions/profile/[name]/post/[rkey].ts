/*
 * Cloudflare Pages function (link cards): a post link fetched by Discord or
 * another chat app gets its card; everyone else gets the app. See
 * src/horizon/link-cards/handlers.ts.
 */

import {
  handlePostPage,
  type PagesContext,
} from '../../../../src/horizon/link-cards/handlers'

export const onRequestGet = (ctx: PagesContext) => handlePostPage(ctx)
