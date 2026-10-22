/*
 * A pending private post's status in place of its controls row (2K design
 * PA-28 step 3, hook Ctl 9): "Posting..." with Reply while it is `sending`;
 * the failed state with 8.4's buttons while it is `failed`. Like, Repost,
 * Quote, Bookmark, Share and the post menu (Pin, Delete, "Who can see") are
 * all hidden by that one row replacement until the post is `written`, and a
 * failed post offers Discard in Delete's place.
 */

import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import {Text} from '#/components/Typography'
import {useOutboxViewForUri} from '#/horizon/private/outbox/hooks'
import {OutboxActions} from '#/horizon/private/outbox/OutboxActions'
import {sendingText, undecidedText} from '#/horizon/private/outbox/texts'
import {
  type PendingPhase,
  pendingPhase,
  usePendingPost,
} from '#/horizon/private/store'
import {PRIVATE_POSTING} from '#/horizon/switches'
import {type app} from '#/lexicons'

/**
 * Hook Ctl 9: the status row for a `sending` or `failed` pending post, else
 * `null` (always `null` with `PRIVATE_POSTING` off). Subscribes to the
 * pending store, so the stock row returns when the post becomes `written`.
 */
export function usePendingPostControls(
  post: Pick<app.bsky.feed.defs.PostView, 'uri'>,
  {big, onPressReply}: {big?: boolean; onPressReply: () => void},
): React.ReactNode {
  const entry = usePendingPost(PRIVATE_POSTING ? post.uri : undefined)
  if (!PRIVATE_POSTING || !entry) return null
  const phase = pendingPhase(entry)
  if (phase === 'written') return null
  return (
    <PendingPostStatus
      uri={post.uri}
      did={entry.did}
      phase={phase}
      big={big}
      onPressReply={onPressReply}
    />
  )
}

export function PendingPostStatus({
  uri,
  did,
  phase,
  big,
  onPressReply,
}: {
  uri: string
  did: string
  phase: Exclude<PendingPhase, 'written'>
  big?: boolean
  onPressReply: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const view = useOutboxViewForUri(did, uri)
  if (phase === 'sending') {
    return (
      <View
        testID="pendingPostSending"
        style={[a.flex_row, a.align_center, a.justify_between, a.pt_xs]}>
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          {sendingText()}
        </Text>
        <Button
          testID="pendingPostReply"
          label={l`Reply`}
          size={big ? 'small' : 'tiny'}
          color="secondary"
          onPress={onPressReply}>
          <ButtonText>{l`Reply`}</ButtonText>
        </Button>
      </View>
    )
  }
  return (
    <View testID="pendingPostFailed" style={[a.pt_xs]}>
      {view ? (
        <OutboxActions view={view} size={big ? 'small' : 'tiny'} />
      ) : (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          {undecidedText()}
        </Text>
      )}
    </View>
  )
}
