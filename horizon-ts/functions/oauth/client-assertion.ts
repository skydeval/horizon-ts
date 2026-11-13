/*
 * Cloudflare Pages function: signs Horizon's OAuth client assertions. See
 * src/horizon/oauth-signer/handler.ts.
 */

import {
  handleClientAssertion,
  type SignerEnv,
} from '../../src/horizon/oauth-signer/handler'

type Context = {request: Request; env: SignerEnv}

export const onRequest = (ctx: Context) =>
  handleClientAssertion(ctx.request, ctx.env)
