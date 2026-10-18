/*
 * Hand-written schema for `app.nearhorizon.richtext.facet`, Horizon's own
 * facet features (spoilers design, 3.1). A public `app.bsky.feed.post` and a
 * private `tools.kryphocron.feed.postPrivate` carry the same features (the
 * two spoiler features and the content warning's, 2J design 3.3): the stock
 * facet union is open, and the private one lists them (see `kryphocron.ts`).
 */

import {l} from '@atproto/lex'

const RICHTEXT_FACET = 'app.nearhorizon.richtext.facet'

/**
 * `app.nearhorizon.richtext.facet#spoiler`: the bytes of this facet are
 * spoiler content, hidden until the reader reveals them.
 */
export const spoiler = l.typedObject(RICHTEXT_FACET, 'spoiler', l.object({}))

/**
 * `app.nearhorizon.richtext.facet#spoilerMarker`: the bytes of this facet are
 * one `||` marker (with its line break when it stands alone on a line), kept
 * in the text for clients that do not read spoiler facets.
 */
export const spoilerMarker = l.typedObject(
  RICHTEXT_FACET,
  'spoilerMarker',
  l.object({}),
)

/**
 * `app.nearhorizon.richtext.facet#contentWarning`: the bytes of this facet
 * are part of a content warning's hidden body (2J design, 3.3). Always
 * appears together with `#spoiler`, after it.
 */
export const contentWarning = l.typedObject(
  RICHTEXT_FACET,
  'contentWarning',
  l.object({}),
)
