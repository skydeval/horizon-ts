/*
 * Cloudflare Pages function: the Android app's OAuth return address. See
 * src/horizon/oauth-signer/app-callback.ts.
 */

import {handleAppCallback} from '../../../src/horizon/oauth-signer/app-callback'

export const onRequestGet = (ctx: {request: Request}) =>
  handleAppCallback(ctx.request)
