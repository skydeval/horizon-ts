/*
 * Cloudflare Pages function (link cards): a kryphocron post link fetched by
 * a chat app gets the hidden card, with nothing looked up; everyone else gets
 * the app. See src/horizon/link-cards/handlers.ts.
 */

import {
  handlePrivatePostPage,
  type PagesContext,
} from '../../../../src/horizon/link-cards/handlers'

export const onRequestGet = (ctx: PagesContext) => handlePrivatePostPage(ctx)
