/*
 * The encoded content's generation mark (2K design 5.2, PA-16):
 * `<codec>/<unix seconds, 20 digits>/<64 hex>`. The mark is client- or
 * host-asserted and never verified; Horizon reads only its seconds, to
 * schedule a post's re-encode. The slug is never read (D-0.8).
 *
 * The codec's name is not matched: only `private/encoder/` names the
 * encoder's parts.
 */

const MARK = /^[a-z0-9][a-z0-9.-]*\/(\d{20})\/[0-9a-f]{64}$/

/**
 * The mark's time in unix seconds, or `undefined` when it does not parse.
 */
export function parseGenerationSecs(mark: unknown): number | undefined {
  if (typeof mark !== 'string') return undefined
  const match = MARK.exec(mark)
  if (!match) return undefined
  const secs = Number(match[1])
  return Number.isSafeInteger(secs) ? secs : undefined
}
