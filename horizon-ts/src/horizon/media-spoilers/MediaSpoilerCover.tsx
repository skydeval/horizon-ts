/*
 * The cover of a flagged image or video (2J design, 6.3), the pill it
 * shares with the video cards (6.13), and the DM share note. The cover is
 * the last child of its cell, so it paints above the stock overlays by
 * order alone: every react-native-web `View` is its own stacking context,
 * so no `zIndex` is needed or wanted here.
 *
 * The blur is the cover's own copy of the thumbnail under expo-image's
 * `blurRadius` (a CSS blur on web, a native blur elsewhere); the copy is the
 * same URL, so it comes from the image cache. The sharp image stays in the
 * page under the cover: the cover is friction, not secrecy.
 */

import {useState} from 'react'
import {type LayoutChangeEvent, Pressable, View} from 'react-native'
import {Image} from 'expo-image'
import {Trans, useLingui} from '@lingui/react/macro'

import {useHaptics} from '#/lib/haptics'
import {atoms as a, useTheme, web} from '#/alf'
import {EyeSlash_Stroke2_Corner0_Rounded as EyeSlashIcon} from '#/components/icons/EyeSlash'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {spoilerTooltipRef} from '#/horizon/spoilers/tooltip'
import {
  hasMediaSpoilers,
  MEDIA_SPOILER_BLUR_RADIUS,
  readsAsContentWarning,
} from './read'

export {MEDIA_SPOILER_BLUR_RADIUS} from './read'

/** Below this laid-out width the pill shows its icon only. */
const PILL_TEXT_MIN_WIDTH = 120

function PillBody({
  contentWarning,
  iconOnly,
  hovered,
}: {
  contentWarning: boolean
  iconOnly: boolean
  hovered: boolean
}) {
  const t = useTheme()
  return (
    <View
      style={[
        a.flex_row,
        a.align_center,
        a.gap_xs,
        a.px_md,
        a.py_xs,
        a.rounded_full,
        {
          backgroundColor: hovered
            ? 'rgba(0, 0, 0, 0.75)'
            : 'rgba(0, 0, 0, 0.6)',
        },
      ]}>
      <EyeSlashIcon size="sm" fill={t.palette.white} />
      {iconOnly ? null : (
        <Text
          numberOfLines={1}
          style={[a.text_sm, a.font_semi_bold, {color: t.palette.white}]}>
          {contentWarning ? (
            <Trans comment="Pill on an image or video of a post behind a content warning">
              Content warning
            </Trans>
          ) : (
            <Trans comment="Pill on an image or video marked as a spoiler">
              Spoiler
            </Trans>
          )}
        </Text>
      )}
    </View>
  )
}

/**
 * The cover over a flagged cell while it is covered. `onReveal` is told
 * whether the cover had keyboard focus, so focus can move into the cell.
 */
export function MediaSpoilerCover({
  thumb,
  contentWarning,
  label,
  hint,
  rounded = true,
  onReveal,
}: {
  thumb: string | undefined
  contentWarning: boolean
  label: string
  hint: string
  rounded?: boolean
  onReveal: (hadFocus: boolean) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const haptics = useHaptics()
  const [width, setWidth] = useState<number | undefined>(undefined)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  return (
    <View
      style={[
        a.absolute,
        a.inset_0,
        a.overflow_hidden,
        rounded && a.rounded_md,
        t.atoms.bg_contrast_25,
      ]}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {thumb ? (
        <Image
          source={{uri: thumb}}
          contentFit="cover"
          blurRadius={MEDIA_SPOILER_BLUR_RADIUS}
          style={[a.absolute, a.inset_0, {transform: [{scale: 1.2}]}]}
          accessible={false}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <View
        style={[
          a.absolute,
          a.inset_0,
          {backgroundColor: 'rgba(0, 0, 0, 0.25)'},
        ]}
      />
      <Pressable
        ref={spoilerTooltipRef(
          l({
            message: 'Click to reveal',
            comment: 'Tooltip on a covered image or video in a post, on web',
          }),
        )}
        style={[
          a.absolute,
          a.inset_0,
          a.align_center,
          a.justify_center,
          web({cursor: 'pointer', outline: 0}),
          focused &&
            web({boxShadow: `inset 0 0 0 2px ${t.palette.primary_500}`}),
          rounded && a.rounded_md,
        ]}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        onPress={e => {
          if (IS_WEB) e.preventDefault()
          haptics.tap()
          onReveal(focused)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}>
        <PillBody
          contentWarning={contentWarning}
          iconOnly={width !== undefined && width < PILL_TEXT_MIN_WIDTH}
          hovered={hovered}
        />
      </Pressable>
    </View>
  )
}

/**
 * The cover's pill, centred and not interactive, on a video card whose post
 * has spoiler media or a CW (hooks MS 42 and MS 44).
 */
export function MediaSpoilerPill({
  post,
}: {
  post: {record: unknown; embed?: unknown}
}) {
  const [width, setWidth] = useState<number | undefined>(undefined)
  if (!hasMediaSpoilers(post)) return null
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={[a.absolute, a.inset_0, a.align_center, a.justify_center]}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <PillBody
        contentWarning={readsAsContentWarning(post.record)}
        iconOnly={width !== undefined && width < PILL_TEXT_MIN_WIDTH}
        hovered={false}
      />
    </View>
  )
}

/**
 * Stands in for the media preview of a post shared into a DM (hook MS 45,
 * MS-16).
 */
export function MediaSpoilerNote() {
  const t = useTheme()
  return (
    <Text style={[a.text_sm, a.mt_sm, t.atoms.text_contrast_medium]}>
      <Trans comment="Shown in place of the images of a post shared into a chat, when they are marked as spoilers">
        Media marked as spoiler
      </Trans>
    </Text>
  )
}
