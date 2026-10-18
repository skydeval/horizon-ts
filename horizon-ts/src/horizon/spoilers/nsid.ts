/*
 * The spoiler facet features (spoilers design, 3.1, 3.4), as constants and
 * predicates. The stock facet union types an unknown feature as
 * `l.Unknown$TypedObject`, whose `$type` is branded, so the builders below
 * hold the one cast.
 */

import {type l} from '@atproto/lex'

export const SPOILER_FEATURE = 'app.nearhorizon.richtext.facet#spoiler' as const
export const SPOILER_MARKER_FEATURE =
  'app.nearhorizon.richtext.facet#spoilerMarker' as const
/**
 * The bytes of the facet are part of a content warning's hidden body (2J
 * design, 3.3); always after `#spoiler` on the same facet.
 */
export const CONTENT_WARNING_FEATURE =
  'app.nearhorizon.richtext.facet#contentWarning' as const

function hasType(feature: unknown, type: string): boolean {
  return (
    typeof feature === 'object' &&
    feature !== null &&
    (feature as {$type?: unknown}).$type === type
  )
}

/**
 * The feature marks spoiler content.
 */
export function isSpoilerFeature(feature: unknown): boolean {
  return hasType(feature, SPOILER_FEATURE)
}

/**
 * The feature marks a `||` marker kept in the text.
 */
export function isSpoilerMarkerFeature(feature: unknown): boolean {
  return hasType(feature, SPOILER_MARKER_FEATURE)
}

/**
 * The feature marks part of a content warning's body.
 */
export function isContentWarningFeature(feature: unknown): boolean {
  return hasType(feature, CONTENT_WARNING_FEATURE)
}

/**
 * A `#spoiler` feature, typed for a stock facet's open union.
 */
export function spoilerFeature(): l.Unknown$TypedObject {
  return {$type: SPOILER_FEATURE} as unknown as l.Unknown$TypedObject
}

/**
 * A `#spoilerMarker` feature, typed for a stock facet's open union.
 */
export function spoilerMarkerFeature(): l.Unknown$TypedObject {
  return {$type: SPOILER_MARKER_FEATURE} as unknown as l.Unknown$TypedObject
}

/**
 * A `#contentWarning` feature, typed for a stock facet's open union.
 */
export function contentWarningFeature(): l.Unknown$TypedObject {
  return {$type: CONTENT_WARNING_FEATURE} as unknown as l.Unknown$TypedObject
}
