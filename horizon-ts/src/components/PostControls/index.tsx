import {memo, useMemo, useState} from 'react'
import {type StyleProp, View, type ViewStyle} from 'react-native'
import {type RichText as RichTextAPI} from '@bsky/sdk/richtext'
import {plural} from '@lingui/core/macro'
import {useLingui} from '@lingui/react/macro'

import {CountWheel} from '#/lib/custom-animations/CountWheel'
import {AnimatedLikeIcon} from '#/lib/custom-animations/LikeIcon'
import {useOpenComposer} from '#/lib/hooks/useOpenComposer'
import {type Shadow} from '#/state/cache/types'
import {useFeedFeedbackContext} from '#/state/feed-feedback'
import {
  usePostLikeMutationQueue,
  usePostRepostMutationQueue,
} from '#/state/queries/post'
import {useRequireAuth} from '#/state/session'
import {
  ProgressGuideAction,
  useProgressGuideControls,
} from '#/state/shell/progress-guide'
import {atoms as a, useBreakpoints, useTheme} from '#/alf'
import {Reply_Stroke2_Corner0_Rounded as Bubble} from '#/components/icons/Reply'
import {useFormatPostStatCount} from '#/components/PostControls/util'
import * as Skele from '#/components/Skeleton'
import * as Toast from '#/components/Toast'
import {useAnalytics} from '#/analytics'
// HORIZON: a private post's reply and quote limits are checked before the composer opens
import {guardPrivateInteraction} from '#/horizon/private/api/gate-guard'
// HORIZON: a sending or failed private post shows its status in place of the controls
import {usePendingPostControls} from '#/horizon/private/composer/PendingPostStatus'
// HORIZON: a private post shows counts only when prism served them
import {privateControlsFor} from '#/horizon/private/render/controls'
// HORIZON: a visitor-form restored view hides like, repost and quote
import {useRestoredActionsHidden} from '#/horizon/refract/visitor'
import {type app} from '#/lexicons'
import {BookmarkButton} from './BookmarkButton'
import {
  PostControlButton,
  PostControlButtonIcon,
  PostControlButtonText,
} from './PostControlButton'
import {PostMenuButton} from './PostMenu'
import {RepostButton} from './RepostButton'
import {ShareMenuButton} from './ShareMenu'

let PostControls = ({
  big,
  post,
  record,
  richText,
  feedContext,
  reqId,
  style,
  onPressReply,
  onPostReply,
  logContext,
  threadgateRecord,
  onShowLess,
  viaRepost,
  variant,
  forceGoogleTranslate = false,
}: {
  big?: boolean
  post: Shadow<app.bsky.feed.defs.PostView>
  record: app.bsky.feed.post.Main
  richText: RichTextAPI
  feedContext?: string | undefined
  reqId?: string | undefined
  style?: StyleProp<ViewStyle>
  onPressReply: () => void
  onPostReply?: (postUri: string | undefined) => void
  logContext: 'FeedItem' | 'PostThreadItem' | 'Post' | 'ImmersiveVideo'
  threadgateRecord?: app.bsky.feed.threadgate.Main
  onShowLess?: (interaction: app.bsky.feed.defs.Interaction) => void
  viaRepost?: {uri: string; cid: string}
  variant?: 'compact' | 'normal' | 'large'
  forceGoogleTranslate?: boolean
}): React.ReactNode => {
  const ax = useAnalytics()
  const t = useTheme()
  const {t: l} = useLingui()
  const {openComposer} = useOpenComposer()
  const {feedDescriptor} = useFeedFeedbackContext()
  const [queueLike, queueUnlike] = usePostLikeMutationQueue(
    post,
    viaRepost,
    feedDescriptor,
    logContext,
  )
  const [queueRepost, queueUnrepost] = usePostRepostMutationQueue(
    post,
    viaRepost,
    feedDescriptor,
    logContext,
  )
  const requireAuth = useRequireAuth()
  const {sendInteraction} = useFeedFeedbackContext()
  const {captureAction} = useProgressGuideControls()
  const isBlocked = Boolean(
    post.author.viewer?.blocking ||
    post.author.viewer?.blockedBy ||
    post.author.viewer?.blockingByList,
  )
  // HORIZON: a private post shows counts only when prism served them
  const privateControls = privateControlsFor(post.uri)
  // HORIZON: a visitor-form restored view hides like, repost and quote
  const restoredActionsHidden = useRestoredActionsHidden(post)
  const replyDisabled = post.viewer?.replyDisabled
  const {gtPhone} = useBreakpoints()
  const formatPostStatCount = useFormatPostStatCount()

  const [hasLikeIconBeenToggled, setHasLikeIconBeenToggled] = useState(false)

  const onPressToggleLike = async () => {
    if (isBlocked) {
      Toast.show(l`Cannot interact with a blocked user`, {
        type: 'warning',
      })
      return
    }

    const existingLike = post.viewer?.like
    try {
      setHasLikeIconBeenToggled(true)
      if (!existingLike) {
        sendInteraction({
          item: post.uri,
          event: 'app.bsky.feed.defs#interactionLike',
          feedContext,
          reqId,
        })
        captureAction(ProgressGuideAction.Like)
        await queueLike()
      } else {
        await queueUnlike()
      }
    } catch (err) {
      const e = err as Error
      if (e?.name !== 'AbortError') {
        throw e
      }
    }
  }

  const onRepost = async () => {
    if (isBlocked) {
      Toast.show(l`Cannot interact with a blocked user`, {
        type: 'warning',
      })
      return
    }

    const existingRepost = post.viewer?.repost
    try {
      if (!existingRepost) {
        sendInteraction({
          item: post.uri,
          event: 'app.bsky.feed.defs#interactionRepost',
          feedContext,
          reqId,
        })
        await queueRepost()
      } else {
        await queueUnrepost()
      }
    } catch (err) {
      const e = err as Error
      if (e?.name !== 'AbortError') {
        throw e
      }
    }
  }

  const onQuote = () => {
    if (isBlocked) {
      Toast.show(l`Cannot interact with a blocked user`, {
        type: 'warning',
      })
      return
    }

    sendInteraction({
      item: post.uri,
      event: 'app.bsky.feed.defs#interactionQuote',
      feedContext,
      reqId,
    })
    ax.metric('post:clickQuotePost', {
      uri: post.uri,
      authorDid: post.author.did,
      logContext,
      feedDescriptor,
    })
    openComposer({
      quote: post,
      onPost: onPostReply,
      logContext: 'QuotePost',
    })
  }

  const onShare = () => {
    sendInteraction({
      item: post.uri,
      event: 'app.bsky.feed.defs#interactionShare',
      feedContext,
      reqId,
    })
  }

  const secondaryControlSpacingStyles = useSecondaryControlSpacingStyles({
    variant,
    big,
    gtPhone,
  })

  // HORIZON: a sending or failed private post shows its status in place of the controls
  const pendingControls = usePendingPostControls(post, {big, onPressReply})
  if (pendingControls) return pendingControls

  return (
    <View
      style={[
        a.flex_row,
        a.justify_between,
        a.align_center,
        !big && a.pt_2xs,
        a.gap_md,
        style,
      ]}>
      <View style={[a.flex_row, a.flex_1, {maxWidth: 320}]}>
        <View
          style={[
            a.flex_1,
            a.align_start,
            {marginLeft: big ? -2 : -6},
            replyDisabled ? {opacity: 0.6} : undefined,
          ]}>
          <PostControlButton
            testID="replyBtn"
            onPress={
              !replyDisabled
                ? () =>
                    requireAuth(() => {
                      ax.metric('post:clickReply', {
                        uri: post.uri,
                        authorDid: post.author.did,
                        logContext,
                        feedDescriptor,
                      })
                      // HORIZON: a private post's reply limit is checked before the composer opens
                      guardPrivateInteraction(post, 'reply', onPressReply)
                    })
                : undefined
            }
            label={l({
              message: `Reply (${plural(post.replyCount || 0, {
                one: '# reply',
                other: '# replies',
              })})`,
              comment:
                'Accessibility label for the reply button, verb form followed by number of replies and noun form',
            })}
            big={big}>
            <PostControlButtonIcon icon={Bubble} />
            {/* HORIZON: no reply count on a private post without served counts */}
            {!privateControls.hideCounts &&
              typeof post.replyCount !== 'undefined' &&
              post.replyCount > 0 && (
                <PostControlButtonText>
                  {formatPostStatCount(post.replyCount)}
                </PostControlButtonText>
              )}
          </PostControlButton>
        </View>
        <View style={[a.flex_1, a.align_start]}>
          {/* HORIZON: a visitor-form restored view hides like, repost and quote */}
          {!restoredActionsHidden && (
            <RepostButton
              isReposted={!!post.viewer?.repost}
              // HORIZON: no repost count on a private post without served counts
              repostCount={
                privateControls.hideCounts
                  ? undefined
                  : (post.repostCount ?? 0) + (post.quoteCount ?? 0)
              }
              onRepost={() => void onRepost()}
              // HORIZON: a private post's quote limit is checked before the composer opens
              onQuote={() => guardPrivateInteraction(post, 'quote', onQuote)}
              big={big}
              embeddingDisabled={Boolean(post.viewer?.embeddingDisabled)}
            />
          )}
        </View>
        <View style={[a.flex_1, a.align_start]}>
          {/* HORIZON: a visitor-form restored view hides like, repost and quote */}
          {!restoredActionsHidden && (
            <PostControlButton
              testID="likeBtn"
              big={big}
              active={Boolean(post.viewer?.like)}
              activeColor={t.palette.pink}
              onPress={() => requireAuth(() => onPressToggleLike())}
              label={
                post.viewer?.like
                  ? l({
                      message: `Unlike (${plural(post.likeCount || 0, {
                        one: '# like',
                        other: '# likes',
                      })})`,
                      comment:
                        'Accessibility label for the like button when the post has been liked, verb followed by number of likes and noun',
                    })
                  : l({
                      message: `Like (${plural(post.likeCount || 0, {
                        one: '# like',
                        other: '# likes',
                      })})`,
                      comment:
                        'Accessibility label for the like button when the post has not been liked, verb form followed by number of likes and noun form',
                    })
              }>
              <AnimatedLikeIcon
                isLiked={Boolean(post.viewer?.like)}
                big={big}
                hasBeenToggled={hasLikeIconBeenToggled}
              />
              {/* HORIZON: no like count on a private post without served counts; the heart stays (start) */}
              {!privateControls.hideCounts && (
                <CountWheel
                  count={post.likeCount ?? 0}
                  isToggled={Boolean(post.viewer?.like)}
                  hasBeenToggled={hasLikeIconBeenToggled}
                  renderCount={({count}) => (
                    <PostControlButtonText testID="likeCount">
                      {formatPostStatCount(count)}
                    </PostControlButtonText>
                  )}
                />
              )}
              {/* HORIZON: no like count on a private post without served counts; the heart stays (end) */}
            </PostControlButton>
          )}
        </View>
        {/* Spacer! */}
        <View />
      </View>
      <View style={[a.flex_row, a.justify_end, secondaryControlSpacingStyles]}>
        <BookmarkButton
          post={post}
          big={big}
          logContext={logContext}
          hitSlop={{
            right: secondaryControlSpacingStyles.gap / 2,
          }}
        />
        <ShareMenuButton
          testID="postShareBtn"
          post={post}
          big={big}
          record={record}
          richText={richText}
          timestamp={post.indexedAt}
          threadgateRecord={threadgateRecord}
          onShare={onShare}
          hitSlop={{
            left: secondaryControlSpacingStyles.gap / 2,
            right: secondaryControlSpacingStyles.gap / 2,
          }}
          logContext={logContext}
        />
        <PostMenuButton
          testID="postDropdownBtn"
          post={post}
          postFeedContext={feedContext}
          postReqId={reqId}
          big={big}
          record={record}
          richText={richText}
          timestamp={post.indexedAt}
          threadgateRecord={threadgateRecord}
          onShowLess={onShowLess}
          hitSlop={{
            left: secondaryControlSpacingStyles.gap / 2,
          }}
          logContext={logContext}
          forceGoogleTranslate={forceGoogleTranslate}
        />
      </View>
    </View>
  )
}
PostControls = memo(PostControls)
export {PostControls}

export function PostControlsSkeleton({
  big,
  style,
  variant,
}: {
  big?: boolean
  style?: StyleProp<ViewStyle>
  variant?: 'compact' | 'normal' | 'large'
}) {
  const {gtPhone} = useBreakpoints()

  const rowHeight = big ? 32 : 28
  const padding = 4
  const size = rowHeight - padding * 2

  const secondaryControlSpacingStyles = useSecondaryControlSpacingStyles({
    variant,
    big,
    gtPhone,
  })

  const itemStyles = {
    padding,
  }

  return (
    <Skele.Row
      style={[a.flex_row, a.justify_between, a.align_center, a.gap_md, style]}>
      <View style={[a.flex_row, a.flex_1, {maxWidth: 320}]}>
        <View
          style={[itemStyles, a.flex_1, a.align_start, {marginLeft: -padding}]}>
          <Skele.Pill blend size={size} />
        </View>

        <View style={[itemStyles, a.flex_1, a.align_start]}>
          <Skele.Pill blend size={size} />
        </View>

        <View style={[itemStyles, a.flex_1, a.align_start]}>
          <Skele.Pill blend size={size} />
        </View>
      </View>
      <View style={[a.flex_row, a.justify_end, secondaryControlSpacingStyles]}>
        <View style={itemStyles}>
          <Skele.Circle blend size={size} />
        </View>
        <View style={itemStyles}>
          <Skele.Circle blend size={size} />
        </View>
        <View style={itemStyles}>
          <Skele.Circle blend size={size} />
        </View>
      </View>
    </Skele.Row>
  )
}

function useSecondaryControlSpacingStyles({
  variant,
  big,
  gtPhone,
}: {
  variant?: 'compact' | 'normal' | 'large'
  big?: boolean
  gtPhone: boolean
}) {
  return useMemo(() => {
    let gap = 0 // default, we want `gap` to be defined on the resulting object
    if (variant !== 'compact') gap = a.gap_xs.gap
    if (big || gtPhone) gap = a.gap_sm.gap
    return {gap}
  }, [variant, big, gtPhone])
}
