/*
 * The gap row (Phase 4 design 8, 11.3): a placeholder in a hidden post's
 * place, worded by its kind, in the stock tombstone's look (a contrast-25
 * card, medium-contrast text) with the reply lines and indent the stock
 * traversal computed for the placeholder, so the line from the parent passes
 * through the gap to its replies. The anchor form is the larger one of the
 * stock deleted anchor. The row is one accessible element whose label is
 * its wording; its action (Retry, Open private post, View list) is a
 * separate button. It never links to the hidden author, and tapping the row
 * does nothing (8.1, 8.2, TL-12).
 *
 * Retry's spinner, its error and "Still unavailable" come from the queue
 * store (9.1), two primitive reads; the account's 429 wait is a boolean
 * store read. Both announce a new state politely (4.4).
 */

import {useEffect} from 'react'
import {AccessibilityInfo, View} from 'react-native'
import {AtUri} from '@atproto/syntax'
import {type MessageDescriptor} from '@lingui/core'
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
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {CircleQuestion_Stroke2_Corner2_Rounded as QuestionIcon} from '#/components/icons/CircleQuestion'
import {ExclamationCircle_Stroke2_Corner0_Rounded as CloudIcon} from '#/components/icons/ExclamationCircle'
import {EyeSlash_Stroke2_Corner0_Rounded as EyeSlashIcon} from '#/components/icons/EyeSlash'
import {PersonX_Stroke2_Corner0_Rounded as PersonXIcon} from '#/components/icons/Person'
import {Trash_Stroke2_Corner0_Rounded as TrashIcon} from '#/components/icons/Trash'
import {Link} from '#/components/Link'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {useIsMember} from '#/horizon/private/membership'
import {StandIn} from '#/horizon/private/render/StandIn'
import {isPrivateRead, privatePostPath} from '#/horizon/private/uri'
import {type GapInfo} from '#/horizon/thread-lens/adapt'
import {useLensWaiting} from '#/horizon/thread-lens/api'
import {retryLensGaps} from '#/horizon/thread-lens/fetch'
import {useLensListName} from '#/horizon/thread-lens/lists'
import {useLensRowState} from '#/horizon/thread-lens/snapshot'
import {
  BLOCKED_BY_A_LIST,
  GAP_GENERIC,
  GAP_TEXT,
  OPEN_PRIVATE_POST,
  RETRY,
  ROW_FAILED,
  STILL_UNAVAILABLE,
  VIEW_LIST,
} from '#/horizon/thread-lens/strings'

type PostItem = Extract<ThreadItem, {type: 'threadPost'}>

const BLOCK_KINDS = new Set(['blocked-by-you', 'blocking-you', 'blocked'])
const BIN_KINDS = new Set(['deleted', 'not-found'])

/** The text of a kind (8.1); any kind prism adds later is generic. */
function gapTextOf(gap: string): MessageDescriptor {
  return (
    (GAP_TEXT as Record<string, MessageDescriptor | undefined>)[gap] ??
    GAP_GENERIC
  )
}

/** The icon of a kind (8.1). Gap rows never rely on colour (4.4). */
function iconOf(gap: string) {
  if (BLOCK_KINDS.has(gap)) return PersonXIcon
  if (BIN_KINDS.has(gap)) return TrashIcon
  if (gap === 'block-state-unknown') return QuestionIcon
  if (gap === 'upstream-unavailable') return CloudIcon
  return EyeSlashIcon
}

/** The gap row for `item`, drawn as the anchor or as a reply or parent. */
export function GapRow({
  item,
  gap,
  view,
  isAnchor,
  queueId,
}: {
  item: PostItem
  gap: GapInfo
  view: 'tree' | 'linear'
  isAnchor: boolean
  queueId?: string
}) {
  const t = useTheme()
  const {t: l, i18n} = useLingui()
  const qc = useQueryClient()
  const {currentAccount} = useSession()
  // Every store read runs on every render (rules of hooks).
  const member = useIsMember()
  const waiting = useLensWaiting(currentAccount?.did)
  const row = useLensRowState(queueId, gap.uri)
  const listName = useLensListName(
    gap.gap === 'blocked-by-you' ? gap.listUri : undefined,
    gap.gap === 'blocked-by-you' ? gap.list : undefined,
  )

  // A row's result is announced once per answer, before its note expires (4.4).
  useEffect(() => {
    if (row.status === 'error') {
      AccessibilityInfo.announceForAccessibility(i18n._(ROW_FAILED))
    } else if (row.status === 'still-unavailable') {
      AccessibilityInfo.announceForAccessibility(i18n._(STILL_UNAVAILABLE))
    }
  }, [row.status, i18n])

  const tierHidden = gap.gap === 'tier-hidden'
  const text = tierHidden
    ? undefined
    : listName
      ? listName.name
        ? l({
            message: `Blocked by ${listName.name}`,
            comment:
              'Thread Lens: a placeholder for a post by someone the reader blocks through the named block list',
          })
        : i18n._(BLOCKED_BY_A_LIST)
      : i18n._(gapTextOf(gap.gap))
  const Icon = iconOf(gap.gap)

  const busy = row.status === 'running' || row.status === 'waiting'
  let action: React.ReactNode = null
  if (gap.retryable) {
    action = (
      <Button
        label={i18n._(RETRY)}
        size="small"
        color="secondary"
        disabled={busy || waiting}
        onPress={() => {
          retryLensGaps(qc, queueId, {uri: gap.uri})
        }}>
        {busy ? <ButtonIcon icon={Loader} /> : null}
        <ButtonText>{i18n._(RETRY)}</ButtonText>
      </Button>
    )
  } else if (tierHidden && member && isPrivateRead(gap.uri)) {
    const {host, rkey} = new AtUri(gap.uri)
    action = (
      <Link
        to={privatePostPath(host, rkey)}
        label={i18n._(OPEN_PRIVATE_POST)}
        size="small"
        color="secondary">
        <ButtonText>{i18n._(OPEN_PRIVATE_POST)}</ButtonText>
      </Link>
    )
  } else if (listName) {
    action = (
      <Link
        to={listName.href}
        label={i18n._(VIEW_LIST)}
        size="small"
        color="secondary">
        <ButtonText>{i18n._(VIEW_LIST)}</ButtonText>
      </Link>
    )
  }

  const status =
    row.status === 'error'
      ? i18n._(ROW_FAILED)
      : row.status === 'still-unavailable'
        ? i18n._(STILL_UNAVAILABLE)
        : undefined

  const card = tierHidden ? (
    <View style={[a.gap_sm]}>
      <StandIn />
      {action ? <View style={[a.flex_row]}>{action}</View> : null}
    </View>
  ) : (
    <View
      style={[
        a.flex_row,
        a.align_center,
        a.rounded_sm,
        t.atoms.bg_contrast_25,
        isAnchor || view === 'linear' ? a.py_md : a.py_sm,
        a.pr_md,
      ]}>
      <View
        accessible
        accessibilityLabel={text}
        accessibilityHint=""
        style={[a.flex_row, a.align_center, a.flex_1]}>
        <View
          style={[
            a.flex_row,
            a.align_center,
            a.justify_center,
            {
              width:
                view === 'tree' && !isAnchor
                  ? TREE_AVI_WIDTH + 12
                  : LINEAR_AVI_WIDTH,
            },
          ]}>
          <Icon style={[t.atoms.text_contrast_medium]} />
        </View>
        <Text
          style={[
            a.flex_1,
            isAnchor || view === 'linear' ? a.text_md : a.text_sm,
            a.font_semi_bold,
            t.atoms.text_contrast_medium,
          ]}>
          {text}
        </Text>
      </View>
      {action}
    </View>
  )

  const statusLine = status ? (
    <Text
      accessibilityLiveRegion="polite"
      aria-live="polite"
      style={[a.text_sm, a.pt_xs, t.atoms.text_contrast_medium]}>
      {status}
    </Text>
  ) : null

  if (isAnchor) {
    const isRoot = !(item.value.post.record as {reply?: unknown}).reply
    return (
      <>
        {!isRoot ? <AnchorParentLine /> : null}
        <View
          style={[
            {paddingHorizontal: OUTER_SPACE, paddingBottom: OUTER_SPACE},
            isRoot && [a.pt_lg],
          ]}>
          {card}
          {statusLine}
        </View>
      </>
    )
  }

  if (view === 'tree') {
    return (
      <TreeWrapper item={item}>
        {card}
        {statusLine}
      </TreeWrapper>
    )
  }

  return (
    <View
      style={[
        !item.ui.showParentReplyLine && [
          a.border_t,
          t.atoms.border_contrast_low,
        ],
        {paddingHorizontal: OUTER_SPACE},
        !item.ui.showChildReplyLine &&
          !item.ui.precedesChildReadMore && {paddingBottom: OUTER_SPACE / 2},
      ]}>
      <LinearLine show={item.ui.showParentReplyLine} height={12} />
      {card}
      {statusLine}
      <LinearLine
        show={item.ui.showChildReplyLine || item.ui.precedesChildReadMore}
        height={4}
      />
    </View>
  )
}

/** The reply line above or below a linear row, in the avatar column. */
function LinearLine({show, height}: {show: boolean; height: number}) {
  const t = useTheme()
  return (
    <View style={[a.flex_row, {height}]}>
      <View style={{width: LINEAR_AVI_WIDTH}}>
        {show ? (
          <View
            style={[
              a.mx_auto,
              a.flex_1,
              {
                width: REPLY_LINE_WIDTH,
                backgroundColor: t.atoms.border_contrast_low.borderColor,
              },
            ]}
          />
        ) : null}
      </View>
    </View>
  )
}

/** The stock anchor's parent line, above a gap anchor that is not a root. */
function AnchorParentLine() {
  const t = useTheme()
  return (
    <View style={[a.pl_lg, a.flex_row, a.pb_xs, {height: a.pt_lg.paddingTop}]}>
      <View style={{width: 42}}>
        <View
          style={[
            {
              width: REPLY_LINE_WIDTH,
              marginLeft: 'auto',
              marginRight: 'auto',
              flexGrow: 1,
              backgroundColor: t.atoms.border_contrast_low.borderColor,
            },
          ]}
        />
      </View>
    </View>
  )
}

/** The stock tree row's indents and connector, around a gap card. */
function TreeWrapper({
  item,
  children,
}: {
  item: PostItem
  children: React.ReactNode
}) {
  const t = useTheme()
  const indents = Math.max(0, item.ui.indent - 1)
  return (
    <View
      style={[
        a.flex_row,
        item.ui.indent === 1 &&
          !item.ui.showParentReplyLine && [
            a.border_t,
            t.atoms.border_contrast_low,
          ],
      ]}>
      {Array.from(Array(indents)).map((_, n: number) => (
        <View
          key={`${item.uri}-lens-padding-${n}`}
          style={[
            t.atoms.border_contrast_low,
            {
              borderRightWidth: item.ui.skippedIndentIndices.has(n)
                ? 0
                : REPLY_LINE_WIDTH,
              width: TREE_INDENT + TREE_AVI_WIDTH / 2,
              left: 1,
            },
          ]}
        />
      ))}
      <View
        style={[
          a.flex_1,
          {paddingHorizontal: OUTER_SPACE, paddingTop: OUTER_SPACE / 2},
          item.ui.indent === 1 && [
            !item.ui.showParentReplyLine && {paddingTop: OUTER_SPACE / 1.5},
            !item.ui.showChildReplyLine && a.pb_sm,
          ],
          item.ui.isLastChild &&
            !item.ui.precedesChildReadMore && {paddingBottom: OUTER_SPACE / 2},
        ]}>
        {item.ui.indent > 1 ? (
          <View
            style={[
              a.absolute,
              t.atoms.border_contrast_low,
              {
                left: -1,
                top: 0,
                height:
                  TREE_AVI_WIDTH / 2 + REPLY_LINE_WIDTH / 2 + OUTER_SPACE / 2,
                width: OUTER_SPACE,
                borderLeftWidth: REPLY_LINE_WIDTH,
                borderBottomWidth: REPLY_LINE_WIDTH,
                borderBottomLeftRadius: a.rounded_sm.borderRadius,
              },
            ]}
          />
        ) : null}
        {children}
      </View>
    </View>
  )
}
