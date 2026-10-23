/*
 * The one entry point the thread screen calls for Thread Lens rows (Phase 4
 * design 12.1, hook TH-4): gap items, marker rows, and the stock read-more
 * row drawn with the lens gap mark on a gap node (8.4). It decides from
 * `thread.state.lens` only (v6: R4-L3):
 *
 * - a post item whose post is a placeholder (an empty `cid` and the very
 *   object in `select`'s map, 7.3) is a gap row;
 * - a `readMore` row whose URI `markers` holds as `replies` is "Load more
 *   replies"; a `readMoreUp` row on a snapshot whose URI `markers` holds as
 *   `parents` is "Load earlier posts";
 * - a `readMore` row whose URI `gapUris` holds and `markers` does not is the
 *   stock row with `?lens=gap` on its `href`, so the screen it opens is
 *   lens-only;
 * - anything else is left to stock (`null`).
 *
 * With the switch off, or under a stock key, it returns `null` for every
 * item, so the screen is stock.
 */

import {type ThreadItem} from '#/state/queries/usePostThread/types'
import {ThreadItemReadMore} from '#/screens/PostThread/components/ThreadItemReadMore'
import {THREAD_LENS} from '#/horizon/switches'
import {
  gapInfoOf,
  isLensAnchorRow,
  type LensState,
} from '#/horizon/thread-lens/adapt'
import {GapRow} from '#/horizon/thread-lens/GapRow'
import {withLensGapMark} from '#/horizon/thread-lens/mark'
import {MarkerRow} from '#/horizon/thread-lens/MarkerRow'

/** What the rows read of the thread answer. */
type ThreadLike = {state: {lens: LensState; view: string}}

/** Thread Lens's row for `item`, or `null` to leave it to stock. */
export function renderThreadLensRow(
  item: ThreadItem,
  thread: ThreadLike,
): React.ReactNode {
  if (!THREAD_LENS) return null
  const lens = thread.state.lens
  if (lens.kind === 'stock' || lens.kind === 'placeholder') return null
  const view = thread.state.view === 'tree' ? 'tree' : 'linear'

  if (item.type === 'threadPost') {
    const gap = gapInfoOf(item.value.post)
    if (!gap) return null
    return (
      <GapRow
        item={item}
        gap={gap}
        view={view}
        isAnchor={item.depth === 0}
        queueId={lens.queueId}
      />
    )
  }

  if (item.type === 'readMore') {
    const uri = item.key.slice('readMore:'.length)
    if (lens.markers.get(uri)?.kind === 'replies') {
      return (
        <MarkerRow
          item={isLensAnchorRow(item) ? {...item, depth: 0} : item}
          uri={uri}
          kind="replies"
          view={view}
          queueId={lens.queueId}
        />
      )
    }
    if (lens.gapUris.has(uri)) {
      return (
        <ThreadItemReadMore
          item={{...item, href: withLensGapMark(item.href)}}
          view={view}
        />
      )
    }
    return null
  }

  if (item.type === 'readMoreUp') {
    const uri = item.key.slice('readMoreUp:'.length)
    if (lens.kind === 'snapshot' && lens.markers.get(uri)?.kind === 'parents') {
      return (
        <MarkerRow
          item={item}
          uri={uri}
          kind="parents"
          view={view}
          queueId={lens.queueId}
        />
      )
    }
  }
  return null
}
