/*
 * The write fallbacks' entry points for the stock write path (refract client
 * design 9.3, 9.4). `lib/api` imports only this file, which imports
 * nothing, so the write path and its tests don't load the batcher; the
 * fallbacks register themselves from `writes.ts`, which `RefractHost`
 * loads. Until they register, the stock behaviour stands.
 */

type StrongRef = {uri: string; cid: string}

type ReplyFallback = (
  parentUri: string,
) => Promise<{root: StrongRef; parent: StrongRef} | undefined>

type LinkFallback = (uri: string) => Promise<unknown>

let replyFallback: ReplyFallback | undefined
let linkFallback: LinkFallback | undefined

/** Register the fallbacks (`writes.ts`). */
export function registerRefractWriteFallbacks(fallbacks: {
  reply: ReplyFallback
  link: LinkFallback
}) {
  replyFallback = fallbacks.reply
  linkFallback = fallbacks.link
}

/** `resolveReply`'s fallback; `undefined` leaves `ReplyDeletedError`. */
export function refractReplyFallbackHook<T>(
  parentUri: string,
): Promise<T | undefined> {
  if (!replyFallback) return Promise.resolve(undefined)
  return replyFallback(parentUri) as Promise<T | undefined>
}

/** `resolveLink`'s `getPost` fallback; `undefined` leaves stock's error. */
export function refractLinkFallbackHook<T>(
  uri: string,
): Promise<T | undefined> {
  if (!linkFallback) return Promise.resolve(undefined)
  return linkFallback(uri) as Promise<T | undefined>
}
