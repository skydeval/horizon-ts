/*
 * The profile Media tab's grid rows (change list item 6), drawn by the stock
 * `PostFeed` in place of its video grid rows on the Media tab
 * (`isMediaGridFeed`). Mirrors the Videos tab's `PostFeedVideoGridRow` and
 * `VideoPostCard`: the same moderation `Hider` (list and media blurs, the
 * "Hidden" mask), the same spoiler blur and pill (`media-spoilers/`), the
 * same neutral tile for a video without a thumbnail; but square tiles, and a
 * tap opens the post.
 */

import {View} from 'react-native'
import {Image} from 'expo-image'
import {AtUri} from '@atproto/syntax'
import {type ModerationDecision} from '@bsky/sdk/moderation'
import {useLingui} from '@lingui/react/macro'

import {makeProfileLink} from '#/lib/routes/links'
import {type FeedPostSliceItem} from '#/state/queries/post-feed'
import {atoms as a, useBreakpoints, useTheme} from '#/alf'
import * as Grid from '#/components/Grid'
import {useInteractionState} from '#/components/hooks/useInteractionState'
import {EyeSlash_Stroke2_Corner0_Rounded as EyeSlashIcon} from '#/components/icons/EyeSlash'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Play_Stroke2_Corner2_Rounded as PlayIcon} from '#/components/icons/Play'
import {SquareBehindSquare4_Stroke2_Corner0_Rounded as StackIcon} from '#/components/icons/SquareBehindSquare4'
import {Link} from '#/components/Link'
import {MediaInsetBorder} from '#/components/MediaInsetBorder'
import * as Hider from '#/components/moderation/Hider'
import {Text} from '#/components/Typography'
import {MediaSpoilerPill} from '#/horizon/media-spoilers/MediaSpoilerCover'
import {
  hasMediaSpoilers,
  MEDIA_SPOILER_BLUR_RADIUS,
  mediaSpoilerCardBlur,
} from '#/horizon/media-spoilers/read'
import {isPrivateDisplay} from '#/horizon/private/render/controls'
import {postSegment} from '#/horizon/private/uri'
import {NoThumbnailTile} from '#/horizon/video/NoThumbnailTile'
import {type app} from '#/lexicons'
import {type GridMedia, gridMediaOf, mediaGridColumns} from './grid'

/** The space between tiles, in px. */
const GAP = 2

/** The marks drawn over a thumbnail, white on the image. */
const MARK_SHADOW = {
  shadowColor: 'black',
  shadowOpacity: 0.6,
  shadowRadius: 3,
  shadowOffset: {width: 0, height: 0},
}

function mergedModerationUi(moderation: ModerationDecision) {
  const modui = moderation.ui('contentList')
  const mediaModui = moderation.ui('contentMedia')
  modui.alerts = [...modui.alerts, ...mediaModui.alerts]
  modui.blurs = [...modui.blurs, ...mediaModui.blurs]
  modui.filters = [...modui.filters, ...mediaModui.filters]
  modui.informs = [...modui.informs, ...mediaModui.informs]
  return modui
}

function postHref(post: app.bsky.feed.defs.PostView): string {
  const rkey = new AtUri(post.uri).rkey
  return makeProfileLink(post.author, postSegment(post.uri), rkey)
}

function Thumbnail({
  post,
  media,
  blurRadius,
  pressed,
}: {
  post: app.bsky.feed.defs.PostView
  media: GridMedia
  blurRadius: number
  pressed: boolean
}) {
  if (!media.thumb) {
    return (
      <NoThumbnailTile
        showPlay={media.kind === 'video' && !hasMediaSpoilers(post)}
        dimmed={pressed}
      />
    )
  }
  return (
    <Image
      source={{uri: media.thumb}}
      style={[a.w_full, a.h_full, {opacity: pressed ? 0.8 : 1}]}
      contentFit="cover"
      accessibilityIgnoresInvertColors
      blurRadius={blurRadius}
    />
  )
}

/** A private post's lock, in the tile's top left corner. */
function PrivateCornerLock() {
  const {t: l} = useLingui()
  return (
    <View
      testID="mediaGridPrivateLock"
      accessible
      accessibilityLabel={l`Private post`}
      accessibilityHint={l`Only its audience can see this post`}
      pointerEvents="none"
      style={[a.absolute, {top: 6, left: 6}, MARK_SHADOW]}>
      <LockIcon size="sm" fill="white" />
    </View>
  )
}

/** The marks in a tile's corners: the lock, and stack or play. */
function TileMarks({
  post,
  media,
}: {
  post: app.bsky.feed.defs.PostView
  media: GridMedia
}) {
  const showsPlay = media.kind === 'video' && !!media.thumb
  return (
    <>
      {isPrivateDisplay(post.uri) ? <PrivateCornerLock /> : null}
      {media.count > 1 ? (
        <View
          testID="mediaGridStack"
          pointerEvents="none"
          style={[a.absolute, {top: 6, right: 6}, MARK_SHADOW]}>
          <StackIcon size="sm" fill="white" />
        </View>
      ) : showsPlay && !hasMediaSpoilers(post) ? (
        <View
          pointerEvents="none"
          style={[a.absolute, {top: 6, right: 6}, MARK_SHADOW]}>
          <PlayIcon size="sm" fill="white" />
        </View>
      ) : null}
    </>
  )
}

function MediaGridTile({
  post,
  moderation,
}: {
  post: app.bsky.feed.defs.PostView
  moderation: ModerationDecision
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {
    state: pressed,
    onIn: onPressIn,
    onOut: onPressOut,
  } = useInteractionState()
  const media = gridMediaOf(post.embed)
  if (!media) return null
  const modui = mergedModerationUi(moderation)
  const tileStyle = [
    a.overflow_hidden,
    t.atoms.bg_contrast_25,
    {aspectRatio: 1},
  ]
  const label =
    media.kind === 'video'
      ? l`Video post from ${post.author.handle}`
      : media.count > 1
        ? l`Post from ${post.author.handle} with ${media.count} images`
        : l`Image post from ${post.author.handle}`
  return (
    <Link
      testID="mediaGridTile"
      to={postHref(post)}
      label={label}
      accessibilityHint={l`Opens the post`}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[a.flex_col, {alignItems: undefined, justifyContent: undefined}]}>
      <Hider.Outer modui={modui}>
        <Hider.Mask>
          <View style={tileStyle}>
            <Thumbnail
              post={post}
              media={media}
              blurRadius={MEDIA_SPOILER_BLUR_RADIUS}
              pressed={pressed}
            />
            <MediaInsetBorder />
            <View
              style={[a.absolute, a.inset_0, a.justify_center, a.align_center]}>
              <View
                style={[
                  a.absolute,
                  a.inset_0,
                  {backgroundColor: 'black', opacity: 0.2},
                ]}
              />
              <View style={[a.align_center, a.gap_xs]}>
                <EyeSlashIcon size="md" fill="white" />
                <Text style={[a.text_xs, {color: 'white'}]}>{l`Hidden`}</Text>
              </View>
            </View>
            {isPrivateDisplay(post.uri) ? <PrivateCornerLock /> : null}
          </View>
        </Hider.Mask>
        <Hider.Content>
          <View style={tileStyle}>
            <Thumbnail
              post={post}
              media={media}
              blurRadius={mediaSpoilerCardBlur(post)}
              pressed={pressed}
            />
            <MediaInsetBorder />
            <MediaSpoilerPill post={post} />
            <TileMarks post={post} media={media} />
          </View>
        </Hider.Content>
      </Hider.Outer>
    </Link>
  )
}

/**
 * One row of the Media grid: up to `mediaGridColumns` posts (the stock feed
 * splits its rows by the same breakpoint), the last row padded so every
 * tile keeps its size.
 */
export function MediaGridRow({items}: {items: FeedPostSliceItem[]}) {
  const {gtMobile} = useBreakpoints()
  const columns = mediaGridColumns(gtMobile)
  const width = 1 / columns
  const pad = Math.max(0, columns - items.length)
  return (
    <View style={[{paddingTop: GAP}]}>
      <Grid.Row gap={GAP}>
        {items.map(item => (
          <Grid.Col key={item.post.uri} width={width}>
            <MediaGridTile post={item.post} moderation={item.moderation} />
          </Grid.Col>
        ))}
        {Array.from({length: pad}, (_, i) => (
          <Grid.Col key={`pad-${i}`} width={width}>
            <View />
          </Grid.Col>
        ))}
      </Grid.Row>
    </View>
  )
}

/** The grid while the first page loads: rows of empty square tiles. */
export function MediaGridPlaceholder() {
  const t = useTheme()
  const {gtMobile} = useBreakpoints()
  const columns = mediaGridColumns(gtMobile)
  const width = 1 / columns
  return (
    <View>
      {Array.from({length: 3}, (_, row) => (
        <View key={row} style={[{paddingTop: GAP}]}>
          <Grid.Row gap={GAP}>
            {Array.from({length: columns}, (_, col) => (
              <Grid.Col key={col} width={width}>
                <View style={[t.atoms.bg_contrast_25, {aspectRatio: 1}]} />
              </Grid.Col>
            ))}
          </Grid.Row>
        </View>
      ))}
    </View>
  )
}
