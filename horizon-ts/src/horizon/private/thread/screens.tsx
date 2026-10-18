/*
 * The four `ppost` screens (8.2). A separate route name per screen is needed
 * because the router cannot tell which of two paths with the same params
 * matched. Private reads are never made for a reader who is not a signed-in
 * member: they see the stand-in.
 */

import {Plural, Trans, useLingui} from '@lingui/react/macro'

import {
  type CommonNavigatorParams,
  type NativeStackScreenProps,
} from '#/lib/routes/types'
import {makeRecordUri} from '#/lib/strings/url-helpers'
import {usePostQuery} from '#/state/queries/post'
import {PostLikedBy} from '#/view/com/post-thread/PostLikedBy'
import {PostQuotes} from '#/view/com/post-thread/PostQuotes'
import {PostRepostedBy} from '#/view/com/post-thread/PostRepostedBy'
import {EmptyState} from '#/view/com/util/EmptyState'
import {PostThread} from '#/screens/PostThread'
import {atoms as a} from '#/alf'
import * as Layout from '#/components/Layout'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {useIsMember} from '#/horizon/private/membership'
import {countsServed} from '#/horizon/private/render/controls'
import {StandIn} from '#/horizon/private/render/StandIn'
import {PP_COLLECTION} from '#/horizon/private/uri'

type ThreadProps = NativeStackScreenProps<
  CommonNavigatorParams,
  'PrivatePostThread'
>

/**
 * A private post's thread: the stock thread for a member, the stand-in for
 * anyone else, with no request.
 */
export function PrivatePostThreadScreen({route}: ThreadProps) {
  const {name, rkey} = route.params
  const isMember = useIsMember()
  const uri = makeRecordUri(name, PP_COLLECTION, rkey)

  return (
    <Layout.Screen testID="privatePostThreadScreen">
      {isMember ? (
        <PostThread uri={uri} />
      ) : (
        <>
          <Layout.Header.Outer>
            <Layout.Header.BackButton />
            <Layout.Header.Content>
              <Layout.Header.TitleText>
                <Trans context="description">Post</Trans>
              </Layout.Header.TitleText>
            </Layout.Header.Content>
            <Layout.Header.Slot />
          </Layout.Header.Outer>
          <StandIn variant="thread" />
        </>
      )}
    </Layout.Screen>
  )
}

type ListKind = 'likes' | 'reposts' | 'quotes'

/**
 * The shared body of the likes, reposts and quotes screens of a private
 * post: the stock list, which reads prism through List 1-3, while prism
 * lists them (`private.interactions`, 2H design 8); else the empty state.
 * The subtitle gives the count once prism serves the post's counts.
 */
function PrivateInteractionList({
  name,
  rkey,
  kind,
  titleText,
}: {
  name: string
  rkey: string
  kind: ListKind
  titleText: React.ReactNode
}) {
  const {t: l} = useLingui()
  const isMember = useIsMember()
  const listsServed = usePrismFeature('private.interactions')
  const uri = makeRecordUri(name, PP_COLLECTION, rkey)
  const {data: post} = usePostQuery(isMember ? uri : undefined)
  const count = !post
    ? undefined
    : kind === 'likes'
      ? post.likeCount
      : kind === 'reposts'
        ? post.repostCount
        : post.quoteCount
  const showCount = !!post && countsServed(post.uri)

  return (
    <Layout.Screen>
      <Layout.Header.Outer>
        <Layout.Header.BackButton />
        <Layout.Header.Content>
          {post && (
            <>
              <Layout.Header.TitleText>{titleText}</Layout.Header.TitleText>
              {showCount && (
                <Layout.Header.SubtitleText>
                  {kind === 'likes' ? (
                    <Plural value={count ?? 0} one="# like" other="# likes" />
                  ) : kind === 'reposts' ? (
                    <Plural
                      value={count ?? 0}
                      one="# repost"
                      other="# reposts"
                    />
                  ) : (
                    <Plural value={count ?? 0} one="# quote" other="# quotes" />
                  )}
                </Layout.Header.SubtitleText>
              )}
            </>
          )}
        </Layout.Header.Content>
        <Layout.Header.Slot />
      </Layout.Header.Outer>
      {!isMember ? (
        <StandIn variant="thread" />
      ) : !listsServed ? (
        <EmptyState
          style={[a.pt_5xl]}
          icon={null}
          message={l`No one to show here.`}
        />
      ) : kind === 'likes' ? (
        <PostLikedBy uri={uri} />
      ) : kind === 'reposts' ? (
        <PostRepostedBy uri={uri} />
      ) : (
        // prism has no ranking and answers in one order
        <PostQuotes uri={uri} quoteSort="latest" active />
      )}
    </Layout.Screen>
  )
}

export function PrivatePostLikedByScreen({
  route,
}: NativeStackScreenProps<CommonNavigatorParams, 'PrivatePostLikedBy'>) {
  return (
    <PrivateInteractionList
      {...route.params}
      kind="likes"
      titleText={<Trans>Liked By</Trans>}
    />
  )
}

export function PrivatePostRepostedByScreen({
  route,
}: NativeStackScreenProps<CommonNavigatorParams, 'PrivatePostRepostedBy'>) {
  return (
    <PrivateInteractionList
      {...route.params}
      kind="reposts"
      titleText={<Trans>Reposted By</Trans>}
    />
  )
}

export function PrivatePostQuotesScreen({
  route,
}: NativeStackScreenProps<CommonNavigatorParams, 'PrivatePostQuotes'>) {
  return (
    <PrivateInteractionList
      {...route.params}
      kind="quotes"
      titleText={<Trans>Quotes</Trans>}
    />
  )
}
