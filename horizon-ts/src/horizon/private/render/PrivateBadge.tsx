import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme, web} from '#/alf'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Text} from '#/components/Typography'
import {isPrivateBadgeHref} from '#/horizon/private/render/controls'

/**
 * The mark of a private post on the thread anchor (7.1): a small lock and
 * the word "Private" in the medium-contrast text colour.
 */
export function PrivateMark({
  size = 'md',
}: {
  /** `md` beside a post's timestamp, `sm` in the thread anchor's date row. */
  size?: 'sm' | 'md'
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  return (
    <View
      testID="privatePostBadge"
      accessible
      accessibilityLabel={l`Private post`}
      accessibilityHint={l`Only its audience can see this post`}
      style={[
        a.flex_row,
        a.align_center,
        a.gap_2xs,
        a.flex_shrink_0,
        size === 'md' && a.pl_xs,
        web({whiteSpace: 'nowrap'}),
      ]}>
      <LockIcon size="xs" style={[t.atoms.text_contrast_medium]} />
      <Text
        style={[
          size === 'md' ? a.text_md : a.text_sm,
          a.leading_tight,
          t.atoms.text_contrast_medium,
        ]}>
        <Trans>Private</Trans>
      </Text>
    </View>
  )
}

/**
 * The mark in a post's header row (Mark 1, v2 round 2 fix 4): the lock alone,
 * pinned to the row's right end, at the post's top right corner, on every
 * rendering with a post meta row (feed rows, thread replies, lists, Saved,
 * quotes) when the post's link is a `ppost` path. The thread anchor has no
 * meta row and carries its own details (Mark 8).
 *
 * A fixed slot: it does not shrink, and `margin-left: auto` puts it at the
 * end of the row, so the name, handle and time keep their stock layout and
 * truncate before it, never under it. The row's own gap spaces it from them.
 *
 * Sized like the row's other icons (round 3 item 3): 16px, the size of the
 * row's verification badge and of the avatar in a quote's row, and under the
 * row's text line (15px text, about 17px tall), so the row does not grow. A `compact` row (a
 * quote's, which shows its avatar inline) takes 14px.
 */
export function PrivateHeaderLock({
  postHref,
  compact = false,
}: {
  postHref: string
  /** The row shows its own avatar (a quote's header). */
  compact?: boolean
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  if (!isPrivateBadgeHref(postHref)) return null
  return (
    <View
      testID="privatePostLock"
      accessible
      accessibilityLabel={l`Private post`}
      accessibilityHint={l`Only its audience can see this post`}
      style={[a.flex_row, a.align_center, a.flex_shrink_0, a.ml_auto]}>
      {compact ? (
        <LockIcon width={14} style={[t.atoms.text_contrast_medium]} />
      ) : (
        <LockIcon size="sm" style={[t.atoms.text_contrast_medium]} />
      )}
    </View>
  )
}
