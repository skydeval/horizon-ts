/*
 * Cloudflare Pages function (link cards): a list link fetched by Discord or
 * another chat app gets its card; everyone else gets the app. See
 * src/horizon/link-cards/handlers.ts.
 */

import {
  handleListPage,
  type PagesContext,
} from '../../../../src/horizon/link-cards/handlers'

export const onRequestGet = (ctx: PagesContext) => handleListPage(ctx)
