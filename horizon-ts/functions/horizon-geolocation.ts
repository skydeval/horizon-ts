/*
 * Cloudflare Pages function: the visitor's rough location for Horizon's web
 * app. See src/horizon/geolocation/handler.ts.
 */

import {
  type CloudflareGeo,
  geolocationResponse,
} from '../src/horizon/geolocation/handler'

export const onRequestGet = (ctx: {request: Request & {cf?: CloudflareGeo}}) =>
  geolocationResponse(ctx.request.cf)
