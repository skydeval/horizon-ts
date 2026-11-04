/*
 * An aster node in a placeholder's place: prism's labels as a line above,
 * with the undo action, then the read-only post drawn by the stock post
 * component. The line is announced politely.
 */

import {View} from 'react-native'

import {Post} from '#/view/com/post/Post'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import {Text} from '#/components/Typography'
import {type AsterLabels} from '#/horizon/routing/aster'
import {type app} from '#/lexicons'

export function AsterNode({
  view,
  labels,
  onUndo,
}: {
  view: app.bsky.feed.defs.PostView
  labels: AsterLabels
  onUndo: () => void
}) {
  const t = useTheme()
  return (
    <View style={[a.gap_xs]}>
      <View
        style={[
          a.flex_row,
          a.align_center,
          a.justify_between,
          a.gap_sm,
          a.rounded_sm,
          a.py_xs,
          a.px_sm,
          t.atoms.bg_contrast_25,
        ]}>
        <Text
          accessibilityLiveRegion="polite"
          aria-live="polite"
          style={[
            a.flex_1,
            a.text_sm,
            a.font_semi_bold,
            t.atoms.text_contrast_medium,
          ]}>
          {labels.marker}
        </Text>
        <Button
          label={labels.undo}
          size="small"
          color="secondary"
          onPress={onUndo}>
          <ButtonText>{labels.undo}</ButtonText>
        </Button>
      </View>
      <Post post={view} hideTopBorder />
    </View>
  )
}
