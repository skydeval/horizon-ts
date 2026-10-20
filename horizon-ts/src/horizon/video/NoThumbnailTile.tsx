/*
 * What a video card draws where a video has no thumbnail: a neutral tile,
 * with the stock play icon unless something else (the spoiler pill, the
 * moderation "Hidden" mask) is centred on it. A private post's video has no
 * thumbnail: it plays from its author's PDS, and only Bluesky's video CDN
 * makes one (handoff `prism-private-video-pds.md`). Drawing the tile instead
 * of an `Image` with no source means no surface shows a broken image.
 */

import {View} from 'react-native'

import {atoms as a, useTheme} from '#/alf'
import {PlayButtonIcon} from '#/components/video/PlayButtonIcon'

/**
 * Fills its parent, as the card's thumbnail `Image` does. `dimmed` matches
 * the pressed state of the stock image.
 */
export function NoThumbnailTile({
  showPlay = true,
  dimmed = false,
}: {
  showPlay?: boolean
  dimmed?: boolean
}) {
  const t = useTheme()
  return (
    <View
      testID="videoNoThumbnailTile"
      accessible={false}
      style={[
        a.w_full,
        a.h_full,
        a.align_center,
        a.justify_center,
        t.atoms.bg_contrast_100,
        {opacity: dimmed ? 0.8 : 1},
      ]}>
      {showPlay ? <PlayButtonIcon /> : null}
    </View>
  )
}
