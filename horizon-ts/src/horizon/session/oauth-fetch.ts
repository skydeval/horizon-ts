/*
 * The fetch the app's OAuth client sends through.
 *
 * Expo's global fetch returns streaming responses. On those, the OAuth
 * library's DPoP nonce check (`peekJson` in `@atproto-labs/fetch`) wraps the
 * response in a `TransformedResponse`, which can't be built over React
 * Native's `Response` (whatwg-fetch sets `type`, `url` and `statusText` as
 * own properties, the subclass defines them as getters). The check swallows
 * the error as "not a nonce error", so the retry with the server's nonce never
 * runs and the first sign-in fails with `use_dpop_nonce`
 * (bluesky-social/atproto#5627, open).
 *
 * Handing the library a buffered response with no stream body sends it down
 * its plain path (`clone().json()`), which works. OAuth and PDS responses are
 * small JSON, so reading them whole costs nothing.
 */

/**
 * `fetch`, with the response read whole into a plain `Response`.
 */
export async function bufferedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await globalThis.fetch(input, init)
  const body = await response.arrayBuffer()
  /*
   * As pairs: whatwg-fetch copies a `Headers` only of its own class, and would
   * drop another implementation's (the DPoP nonce with them)
   */
  const headers: [string, string][] = []
  response.headers.forEach((value, name) => headers.push([name, value]))
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
