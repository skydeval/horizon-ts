/*
 * Native has no site of its own to read the server clock from
 * (`origin-clock.web.ts` on web): the first token's `iat` teaches it.
 */

/** Whether this platform reads the server clock from its own site. */
export const ORIGIN_CLOCK_AVAILABLE = false

/** Nothing on native. */
export function readOriginClockOffsetSecs(): Promise<number | undefined> {
  return Promise.resolve(undefined)
}
