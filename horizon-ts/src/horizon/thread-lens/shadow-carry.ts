/*
 * The hand-off between the post shadow cache and the lens counts
 * (`counts.ts`): a patched view replaces the object a shadow is keyed by,
 * so the shadow moves with it. `state/cache/post-shadow.ts` registers the
 * mover on load; this module imports nothing, so the lens reads stay free
 * of the shadow cache's UI imports.
 */

type Carrier = (from: object, to: object) => void

let carrier: Carrier | undefined

/** Called by the post shadow cache when it loads. */
export function setLensShadowCarrier(next: Carrier | undefined) {
  carrier = next
}

/** Move the shadow `from` holds onto `to`, when the cache is loaded. */
export function carryLensShadow(from: object, to: object) {
  carrier?.(from, to)
}
