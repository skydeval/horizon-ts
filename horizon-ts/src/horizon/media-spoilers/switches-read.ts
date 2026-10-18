/*
 * The two 2J switches as functions (2J design, 8), so every reader goes
 * through one place and a content warning is only effective while spoiler
 * tags are on: the CW body is written and rendered as a spoiler.
 */

import {
  CONTENT_WARNINGS,
  MEDIA_SPOILERS,
  SPOILER_TAGS,
} from '#/horizon/switches'

/**
 * Per-item media spoilers are on.
 */
export function mediaSpoilersOn(): boolean {
  return MEDIA_SPOILERS
}

/**
 * Whole-post content warnings are on (and so are spoiler tags).
 */
export function contentWarningsOn(): boolean {
  return CONTENT_WARNINGS && SPOILER_TAGS
}
