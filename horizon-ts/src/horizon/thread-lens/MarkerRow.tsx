/*
 * The rows that load in place (Phase 4 design 9.2): "Load earlier posts" on
 * the top node's `moreParents`, drawn in the stock read-more-up row's place,
 * and "Load more replies" on a node's `moreReplies`, in the stock read-more
 * row's place. They look like the stock rows and are buttons, not links:
 * pressed, each queues one continuation on the entry's queue (one in flight
 * per screen, 9.1). The row's spinner, its error and the account's 429 wait
 * are store reads (TL-34): status and `retryAt` from the queue, a boolean
 * for the wait. Never followed on their own.
 */

import {useEffect} from 'react'
import {AccessibilityInfo, View} from 'react-native'
import {useLingui} from '@lingui/react/macro'
import {useQueryClient} from '@tanstack/react-query'

import {type ThreadItem} from '#/state/queries/usePostThread/types'
import {useSession} from '#/state/session'
import {
  LINEAR_AVI_WIDTH,
  OUTER_SPACE,
  REPLY_LINE_WIDTH,
  TREE_AVI_WIDTH,
  TREE_INDENT,
} from '#/screens/PostThread/const'
import {atoms as a, useBreakpoints, useTheme} from '#/alf'
import {Button} from '#/components/Button'
import {ArrowTopCircle_Stroke2_Corner0_Rounded as UpIcon} from '#/components/icons/ArrowTopCircle'
import {CirclePlus_Stroke2_Corner0_Rounded as CirclePlus} from '#/components/icons/CirclePlus'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {useLensWaiting} from '#/horizon/thread-lens/api'
import {
  loadEarlierLensPosts,
  loadMoreLensReplies,
} from '#/horizon/thread-lens/fetch'
import {renderedBelow} from '#/horizon/thread-lens/query'
import {useLensRowState} from '#/horizon/thread-lens/snapshot'
import {
  LOAD_EARLIER,
  LOAD_MORE_REPLIES,
  ROW_FAILED,
} from '#/horizon/thread-lens/strings'

/**
 * A marker row for the stock `readMore` or `readMoreUp` item of `uri`. A
 * `readMore` item's `depth` is its node's depth below the anchor (0 for
 * the anchor's own row).
 */
export function MarkerRow({
  item,
  uri,
  kind,
  view,
  queueId,
}: {
  item: Extract<ThreadItem, {type: 'readMore' | 'readMoreUp'}>
  uri: string
  kind: 'parents' | 'replies'
  view: 'tree' | 'linear'
  queueId?: string
}) {
  const t = useTheme()
  const {i18n} = useLingui()
  const qc = useQueryClient()
  const {gtPhone} = useBreakpoints()
  const {currentAccount} = useSession()
  // Every store read runs on every render (rules of hooks).
  const waiting = useLensWaiting(currentAccount?.did)
  const row = useLensRowState(queueId, uri)

  // A failure is announced once per answer (4.4).
  useEffect(() => {
    if (row.status === 'error') {
      AccessibilityInfo.announceForAccessibility(i18n._(ROW_FAILED))
    }
  }, [row.status, i18n])

  const depth = item.type === 'readMore' ? item.depth : 0
  const busy = row.status === 'running' || row.status === 'waiting'
  const label =
    row.status === 'error'
      ? i18n._(ROW_FAILED)
      : i18n._(kind === 'parents' ? LOAD_EARLIER : LOAD_MORE_REPLIES)
  const onPress = () => {
    if (kind === 'parents') {
      loadEarlierLensPosts(qc, queueId, {uri})
    } else {
      loadMoreLensReplies(qc, queueId, {
        uri,
        depth,
        below: renderedBelow(view, gtPhone),
      })
    }
  }

  const icon = (interacted: boolean) => {
    if (busy) return <Loader size="sm" />
    const fill = interacted
      ? t.atoms.text_contrast_high.color
      : t.atoms.text_contrast_low.color
    return kind === 'parents' ? (
      <UpIcon fill={fill} width={24} />
    ) : (
      <CirclePlus fill={fill} width={18} />
    )
  }
  const text = (interacted: boolean) => (
    <Text
      accessibilityLiveRegion="polite"
      aria-live="polite"
      style={[
        a.text_sm,
        t.atoms.text_contrast_medium,
        interacted && a.underline,
      ]}>
      {label}
    </Text>
  )

  if (kind === 'parents') {
    return (
      <Button
        label={label}
        disabled={busy || waiting}
        onPress={onPress}
        style={[
          a.justify_start,
          {paddingTop: OUTER_SPACE, paddingHorizontal: OUTER_SPACE},
        ]}>
        {({hovered, pressed}) => (
          <View>
            <View style={[a.flex_row, a.align_center, a.gap_md]}>
              <View style={[a.align_center, {width: LINEAR_AVI_WIDTH}]}>
                {icon(hovered || pressed)}
              </View>
              {text(hovered || pressed)}
            </View>
            <View style={[a.align_center, {width: LINEAR_AVI_WIDTH}]}>
              <View
                style={[
                  a.mt_xs,
                  {
                    height: OUTER_SPACE / 2,
                    width: REPLY_LINE_WIDTH,
                    backgroundColor: t.atoms.border_contrast_low.borderColor,
                  },
                ]}
              />
            </View>
          </View>
        )}
      </Button>
    )
  }

  const isTreeView = view === 'tree'
  const indent = Math.max(0, depth - 1)
  const skipped =
    item.type === 'readMore' ? item.skippedIndentIndices : new Set<number>()
  return (
    <View style={[a.flex_row]}>
      {isTreeView
        ? Array.from(Array(indent)).map((_, n: number) => (
            <View
              key={`${item.key}-lens-padding-${n}`}
              style={[
                t.atoms.border_contrast_low,
                {
                  borderRightWidth: skipped.has(n) ? 0 : REPLY_LINE_WIDTH,
                  width: TREE_INDENT + TREE_AVI_WIDTH / 2,
                  left: 1,
                },
              ]}
            />
          ))
        : null}
      <View
        style={[
          t.atoms.border_contrast_low,
          {
            marginLeft: isTreeView
              ? TREE_INDENT + TREE_AVI_WIDTH / 2 - 1
              : (LINEAR_AVI_WIDTH - REPLY_LINE_WIDTH) / 2 + 16,
            borderLeftWidth: 2,
            borderBottomWidth: 2,
            borderBottomLeftRadius: a.rounded_sm.borderRadius,
            height: 18,
            width: isTreeView ? TREE_INDENT : LINEAR_AVI_WIDTH / 2 + 10,
          },
        ]}
      />
      <Button
        label={label}
        disabled={busy || waiting}
        onPress={onPress}
        style={[a.justify_start, a.pt_sm, a.pb_md, a.gap_xs]}>
        {({hovered, pressed}) => (
          <>
            {icon(hovered || pressed)}
            {text(hovered || pressed)}
          </>
        )}
      </Button>
    </View>
  )
}
