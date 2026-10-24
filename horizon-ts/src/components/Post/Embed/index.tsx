import {useCallback, useMemo} from 'react'
import {View} from 'react-native'
import {type $Typed} from '@atproto/lex'
import {AtUri} from '@atproto/syntax'
import {
  mergeModUIResults,
  moderatePost,
  moderateViewExternal,
} from '@bsky/sdk/moderation'
import {RichText as RichTextAPI} from '@bsky/sdk/richtext'
import {Trans} from '@lingui/react/macro'
import {useQueryClient} from '@tanstack/react-query'

import {getEmbedCreator} from '#/lib/at-card'
import {makeProfileLink} from '#/lib/routes/links'
import {getChatInviteCodeFromUrl} from '#/lib/strings/url-helpers'
import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {unstableCacheProfileView} from '#/state/queries/profile'
import {useSession} from '#/state/session'
import {Link} from '#/view/com/util/Link'
import {PostMeta} from '#/view/com/util/PostMeta'
import {
  POST_NUMBER_INLINE_OFFSET,
  ThreadItemPostNumber,
  useHasThreadItemPostNumber,
} from '#/screens/PostThread/components/ThreadItemPostNumber'
import {atoms as a, useTheme} from '#/alf'
import {useInteractionState} from '#/components/hooks/useInteractionState'
import {GalleryBleed} from '#/components/images/Gallery'
import {ContentHider} from '#/components/moderation/ContentHider'
import {PostAlerts} from '#/components/moderation/PostAlerts'
import * as ReportDialogMetadataContext from '#/components/moderation/ReportDialog/ReportDialogMetadataContext'
import {AtCard} from '#/components/Post/Embed/AtCard'
import {getAtCardProvider} from '#/components/Post/Embed/AtCard/providers'
import {StandardSiteEmbed} from '#/components/Post/Embed/StandardSiteEmbed'
import {isStandardSiteEmbed} from '#/components/Post/Embed/StandardSiteEmbed/utils'
import {RichText} from '#/components/RichText'
import {Embed as StarterPackCard} from '#/components/StarterPack/StarterPackCard'
import {SubtleHover} from '#/components/SubtleHover'
// HORIZON: identity import
import {PostFrontersScope} from '#/horizon/identity/scope'
// HORIZON: a post's flagged images and videos are covered until pressed
import {MediaSpoilerScope} from '#/horizon/media-spoilers/MediaSpoilerScope'
// HORIZON: a private post's link card is the plain card, whose link is not proxied
import {proxiesPostLinks} from '#/horizon/private/render/controls'
// HORIZON: a quoted private post is resolved for readers who may view it
import {PrivateQuote} from '#/horizon/private/render/PrivateQuote'
// HORIZON: private post links use the ppost segment; quoted private posts are read through prism
import {isPrivateRead, postSegment} from '#/horizon/private/uri'
// HORIZON: C-8, a restored view's community labeler for members
import {restoredModerationOpts} from '#/horizon/refract/labeler'
// HORIZON: a quote Bluesky withholds may be a restored post prism serves
import {
  RestoredQuoteSlot,
  restoredQuoteSlotActive,
} from '#/horizon/refract/RestoredQuote'
// HORIZON: a CW post's line reads as a warning
import {withContentWarningRecord} from '#/horizon/spoilers/cw-line'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {
  type Embed as TEmbed,
  type EmbedType,
  parseEmbed,
} from '#/types/bsky/post'
import {ChatInviteEmbed} from './ChatInviteEmbed'
import {ExternalEmbed} from './ExternalEmbed'
import {ModeratedFeedEmbed} from './FeedEmbed'
import {ImageEmbed} from './ImageEmbed'
import {ModeratedListEmbed} from './ListEmbed'
import {PostPlaceholder as PostPlaceholderText} from './PostPlaceholder'
import {type CommonProps, type EmbedProps, PostEmbedViewContext} from './types'
import {VideoEmbed} from './VideoEmbed'

export {PostEmbedViewContext} from './types'

export function Embed({embed: rawEmbed, ...rest}: EmbedProps) {
  const embed = parseEmbed(rawEmbed)

  switch (embed.type) {
    case 'images':
    case 'gallery':
    case 'link':
    case 'video': {
      return <MediaEmbed embed={embed} {...rest} />
    }
    case 'feed':
    case 'list':
    case 'starter_pack':
    case 'labeler':
    case 'post':
    case 'post_not_found':
    case 'post_blocked':
    case 'post_detached': {
      return <RecordEmbed embed={embed} {...rest} />
    }
    case 'post_with_media': {
      return (
        <View
          style={[
            rest.style,
            rest.viewContext === PostEmbedViewContext.ChatMessage && a.gap_sm,
          ]}>
          <MediaEmbed embed={embed.media} {...rest} />
          <RecordEmbed embed={embed.view} {...rest} />
        </View>
      )
    }
    default: {
      return null
    }
  }
}

function MediaEmbed({
  embed,
  ...rest
}: CommonProps & {
  embed: TEmbed
}) {
  switch (embed.type) {
    case 'images':
    case 'gallery': {
      return (
        <ContentHider
          modui={rest.moderation?.ui('contentMedia')}
          activeStyle={[a.mt_sm]}>
          {/* HORIZON: a post's flagged images are covered until pressed (start) */}
          <MediaSpoilerScope post={rest.post} embed={embed}>
            <ImageEmbed embed={embed} {...rest} />
          </MediaSpoilerScope>
          {/* HORIZON: a post's flagged images are covered until pressed (end) */}
        </ContentHider>
      )
    }
    case 'link': {
      const atProvider = getAtCardProvider(embed.view.external.uri)
      if (
        // HORIZON: a private post's link card is the plain card, whose link is not proxied
        proxiesPostLinks(rest.post?.uri) &&
        (atProvider || isStandardSiteEmbed(embed.view.external))
      ) {
        return (
          <ExternalCardEmbed
            embed={embed}
            Card={atProvider ? AtCard : StandardSiteEmbed}
            {...rest}
          />
        )
      }
      const chatInviteCode = getChatInviteCodeFromUrl(embed.view.external.uri)
      if (chatInviteCode) {
        return (
          <ContentHider
            modui={rest.moderation?.ui('contentMedia')}
            activeStyle={[a.mt_sm]}>
            <ChatInviteEmbed
              code={chatInviteCode}
              link={embed.view.external}
              onOpen={rest.onOpen}
              style={rest.style}
            />
          </ContentHider>
        )
      }
      return (
        <ContentHider
          modui={rest.moderation?.ui('contentMedia')}
          activeStyle={[a.mt_sm]}>
          <ExternalEmbed
            link={embed.view.external}
            onOpen={rest.onOpen}
            post={rest.post}
            style={[a.mt_sm, rest.style]}
          />
        </ContentHider>
      )
    }
    case 'video': {
      return (
        <ContentHider
          modui={rest.moderation?.ui('contentMedia')}
          activeStyle={[a.mt_sm]}>
          {/* HORIZON: a post's flagged video is covered until pressed (start) */}
          <MediaSpoilerScope post={rest.post} embed={embed}>
            <VideoEmbed embed={embed.view} post={rest.post} />
          </MediaSpoilerScope>
          {/* HORIZON: a post's flagged video is covered until pressed (end) */}
        </ContentHider>
      )
    }
    default: {
      return null
    }
  }
}

/*
 * Renders rich external cards (AtCard, StandardSiteEmbed), respecting any
 * moderation labels attached to the `viewExternal` itself. The SDK's
 * `moderatePost` only covers post-level labels, so the external view's labels
 * produce their own decision, merged into the card's `ContentHider` alongside
 * the post-level media moderation.
 */
function ExternalCardEmbed({
  embed,
  Card,
  ...rest
}: CommonProps & {
  embed: EmbedType<'link'>
  Card: typeof AtCard | typeof StandardSiteEmbed
}) {
  const postModerationDecision = rest.moderation
  const moderationOpts = useModerationOpts()
  const external = embed.view.external

  /*
   * The card is both the "content" and the "media" of the embed, so merge
   * the two contexts: label defs with `blurs: content` act on `contentView`,
   * while defs with `blurs: media` act on `contentMedia`.
   */
  const moduis = [postModerationDecision?.ui('contentMedia')]
  if (moderationOpts && external.labels?.length) {
    const decision = moderateViewExternal(external, moderationOpts)
    moduis.push(decision.ui('contentView'), decision.ui('contentMedia'))
  }

  return (
    <ContentHider modui={mergeModUIResults(...moduis)} activeStyle={[a.mt_sm]}>
      <Card
        view={external}
        authorDid={getEmbedCreator(rest.post?.record, external.uri)}
        onEmbedInteractionCallback={rest.onOpen}
        style={[a.mt_sm, rest.style]}
      />
    </ContentHider>
  )
}

function RecordEmbed({
  embed,
  ...rest
}: CommonProps & {
  embed: TEmbed
}) {
  switch (embed.type) {
    case 'feed': {
      return (
        <View style={a.mt_sm}>
          <ModeratedFeedEmbed embed={embed} {...rest} />
        </View>
      )
    }
    case 'list': {
      return (
        <View style={a.mt_sm}>
          <ModeratedListEmbed embed={embed} />
        </View>
      )
    }
    case 'starter_pack': {
      return (
        <View style={a.mt_sm}>
          <StarterPackCard starterPack={embed.view} />
        </View>
      )
    }
    case 'labeler': {
      // not implemented
      return null
    }
    case 'post': {
      if (rest.isWithinQuote && !rest.allowNestedQuotes) {
        return null
      }

      return (
        <QuoteEmbed
          {...rest}
          embed={embed}
          viewContext={rest.viewContext}
          isWithinQuote={rest.isWithinQuote}
          allowNestedQuotes={rest.allowNestedQuotes}
        />
      )
    }
    case 'post_not_found': {
      // HORIZON: a quoted private post is resolved for readers who may view it (start)
      if (isPrivateRead(embed.view.uri)) {
        if (rest.isWithinQuote && !rest.allowNestedQuotes) {
          return null
        }
        return (
          <PrivateQuote
            uri={embed.view.uri}
            render={quote => (
              <QuoteEmbed
                {...rest}
                embed={quote}
                viewContext={rest.viewContext}
                isWithinQuote={rest.isWithinQuote}
                allowNestedQuotes={rest.allowNestedQuotes}
              />
            )}
          />
        )
      }
      // HORIZON: a quoted private post is resolved for readers who may view it (end)
      // HORIZON: a quote Bluesky withholds may be a restored post prism serves (start)
      if (restoredQuoteSlotActive(embed.view.uri)) {
        if (rest.isWithinQuote && !rest.allowNestedQuotes) {
          return null
        }
        return (
          <RestoredQuoteSlot
            uri={embed.view.uri}
            render={quote => (
              <QuoteEmbed
                {...rest}
                embed={quote}
                viewContext={rest.viewContext}
                isWithinQuote={rest.isWithinQuote}
                allowNestedQuotes={rest.allowNestedQuotes}
              />
            )}
            placeholder={kind => (
              <PostPlaceholderText>
                {kind === 'blocked' ? (
                  <Trans>Blocked</Trans>
                ) : (
                  <Trans>Deleted</Trans>
                )}
              </PostPlaceholderText>
            )}
          />
        )
      }
      // HORIZON: a quote Bluesky withholds may be a restored post prism serves (end)
      return (
        <PostPlaceholderText>
          <Trans>Deleted</Trans>
        </PostPlaceholderText>
      )
    }
    case 'post_blocked': {
      return (
        <PostPlaceholderText>
          <Trans>Blocked</Trans>
        </PostPlaceholderText>
      )
    }
    case 'post_detached': {
      return <PostDetachedEmbed embed={embed} />
    }
    default: {
      return null
    }
  }
}

export function PostDetachedEmbed({
  embed,
}: {
  embed: EmbedType<'post_detached'>
}) {
  const {currentAccount} = useSession()
  const isViewerOwner = currentAccount?.did
    ? embed.view.uri.includes(currentAccount.did)
    : false

  return (
    <PostPlaceholderText>
      {isViewerOwner ? (
        <Trans>Removed by you</Trans>
      ) : (
        <Trans>Removed by author</Trans>
      )}
    </PostPlaceholderText>
  )
}

/*
 * Nests parent `Embed` component and therefore must live in this file to avoid
 * circular imports.
 */
export function QuoteEmbed({
  embed,
  onOpen,
  style,
  linkDisabled,
  isWithinQuote: parentIsWithinQuote,
  allowNestedQuotes: parentAllowNestedQuotes,
  viewContext,
}: Omit<CommonProps, 'viewContext'> & {
  embed: EmbedType<'post'>
  viewContext?: PostEmbedViewContext
  linkDisabled?: boolean
}) {
  const moderationOpts = useModerationOpts()
  const quote = useMemo<$Typed<app.bsky.feed.defs.PostView>>(
    () => ({
      ...embed.view,
      $type: 'app.bsky.feed.defs#postView',
      record: embed.view.value,
      embed: embed.view.embeds?.[0],
    }),
    [embed],
  )
  const moderation = useMemo(() => {
    return moderationOpts
      ? // HORIZON: C-8, a restored view's community labeler for members
        moderatePost(quote, restoredModerationOpts(moderationOpts, quote))
      : undefined
  }, [quote, moderationOpts])

  const t = useTheme()
  const queryClient = useQueryClient()
  const itemUrip = new AtUri(quote.uri)
  // HORIZON: private post links use the ppost segment
  const itemHref = makeProfileLink(
    quote.author,
    postSegment(quote.uri),
    itemUrip.rkey,
  )
  const itemTitle = `Post by ${quote.author.handle}`
  const postNumbering = embed.view
  const showPostNumber = useHasThreadItemPostNumber(embed.view)

  const richText = useMemo(() => {
    if (!bsky.isType(app.bsky.feed.post, quote.record)) return undefined
    const {text, facets} = quote.record
    return text.trim()
      ? // HORIZON: a CW post's line reads as a warning
        withContentWarningRecord(
          new RichTextAPI({text: text, facets: facets}),
          quote.record,
        )
      : undefined
  }, [quote.record])

  const onBeforePress = useCallback(() => {
    unstableCacheProfileView(queryClient, quote.author)
    onOpen?.()
  }, [queryClient, quote.author, onOpen])

  const {
    state: hover,
    onIn: onPointerEnter,
    onOut: onPointerLeave,
  } = useInteractionState()
  const {
    state: pressed,
    onIn: onPressIn,
    onOut: onPressOut,
  } = useInteractionState()

  const contents = (
    <ReportDialogMetadataContext.Provider key={quote.uri}>
      {/* HORIZON: identity ID-15: the quoted post's fronters reach its author line (start) */}
      <PostFrontersScope post={quote}>
        <PostMeta
          author={quote.author}
          moderation={moderation}
          showAvatar
          postHref={itemHref}
          timestamp={quote.indexedAt}
          linkDisabled
        />
      </PostFrontersScope>
      {/* HORIZON: identity ID-15: the quoted post's fronters reach its author line (end) */}
      {moderation ? (
        <PostAlerts
          post={quote}
          modui={moderation.ui('contentView')}
          style={[a.py_xs]}
        />
      ) : null}
      {richText?.text ? (
        <RichText
          value={richText}
          style={a.text_md}
          numberOfLines={20}
          disableLinks
          suffixOffset={POST_NUMBER_INLINE_OFFSET}
          suffix={
            showPostNumber ? (
              <ThreadItemPostNumber value={postNumbering} />
            ) : undefined
          }
        />
      ) : (
        <ThreadItemPostNumber inline={false} value={postNumbering} />
      )}
      {quote.embed && (
        <Embed
          embed={quote.embed}
          moderation={moderation}
          viewContext={viewContext}
          isWithinQuote={parentIsWithinQuote ?? true}
          // already within quote? override nested
          allowNestedQuotes={
            parentIsWithinQuote ? false : parentAllowNestedQuotes
          }
          // The photo embed belongs to the quoted post, so attribute its
          // analytics to the quoted post rather than the parent.
          post={quote}
        />
      )}
    </ReportDialogMetadataContext.Provider>
  )

  return (
    <GalleryBleed>
      <View
        style={[viewContext !== PostEmbedViewContext.ChatMessage && a.mt_sm]}
        onPointerEnter={linkDisabled ? undefined : onPointerEnter}
        onPointerLeave={linkDisabled ? undefined : onPointerLeave}>
        <ContentHider
          modui={moderation?.ui('contentList')}
          style={[a.rounded_md, a.border, t.atoms.border_contrast_low, style]}
          activeStyle={[a.p_md, a.pt_sm]}
          childContainerStyle={[a.pt_sm]}>
          {({active}) => (
            <>
              {!active && !linkDisabled && (
                <SubtleHover
                  native
                  hover={hover || pressed}
                  style={[a.rounded_md]}
                />
              )}
              {linkDisabled ? (
                <View style={[!active && a.p_md]} pointerEvents="none">
                  {contents}
                </View>
              ) : (
                <Link
                  style={[!active && a.p_md]}
                  hoverStyle={t.atoms.border_contrast_high}
                  href={itemHref}
                  title={itemTitle}
                  onBeforePress={onBeforePress}
                  onPressIn={onPressIn}
                  onPressOut={onPressOut}>
                  {contents}
                </Link>
              )}
            </>
          )}
        </ContentHider>
      </View>
    </GalleryBleed>
  )
}
