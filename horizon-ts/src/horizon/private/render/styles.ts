import {type ViewStyle} from 'react-native'
import {type Theme} from '@bsky.app/alf'

import {isPrivateDisplay} from '#/horizon/private/render/controls'

/**
 * The highlighted border a private post carries in every renderer (Mark
 * 2-7): a 3px stripe on the left edge in the theme's primary colour. It is
 * drawn as an inset shadow, not a border, so it takes no layout space and the
 * post's content (and the thread line through the avatars) stays aligned with
 * public posts. `undefined` for any other post, so appending it to a style
 * array changes nothing.
 *
 * No renderer calls it since v2 round 2 (fix 4): skydeval removed the stripe
 * everywhere, the thread anchor included, as a trial look. Its hooks (Mark
 * 2-7, a style-array entry in `Post`, `PostFeedItem`, `ThreadItemPost`,
 * `ThreadItemTreePost`, `ThreadItemAnchor` and the quote card in `Embed`)
 * were taken out rather than left calling a no-op; bringing the border back
 * is restoring those six one-line hooks.
 */
export function privatePostStyle(
  uri: string | undefined,
  t: Theme,
): ViewStyle | undefined {
  if (!isPrivateDisplay(uri)) return undefined
  return {boxShadow: `inset 3px 0 0 0 ${t.palette.primary_500}`}
}
