import {useCallback, useMemo, useState} from 'react'
import {type AtUriString} from '@atproto/syntax'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {useModerationOpts} from '#/state/preferences/moderation-opts'
import {useThreadPreferences} from '#/state/queries/preferences/useThreadPreferences'
import {
  LINEAR_VIEW_BELOW,
  LINEAR_VIEW_BF,
  TREE_VIEW_BELOW,
  TREE_VIEW_BELOW_DESKTOP,
  TREE_VIEW_BF,
} from '#/state/queries/usePostThread/const'
import {type PostThreadContextType} from '#/state/queries/usePostThread/context'
import {
  createCacheMutator,
  getThreadPlaceholder,
} from '#/state/queries/usePostThread/queryCache'
import {
  buildThread,
  sortAndAnnotateThreadItems,
} from '#/state/queries/usePostThread/traversal'
import {
  createPostThreadOtherQueryKey,
  createPostThreadQueryKey,
  type ThreadItem,
  type UsePostThreadQueryResult,
} from '#/state/queries/usePostThread/types'
import {getThreadgateRecord} from '#/state/queries/usePostThread/utils'
import * as views from '#/state/queries/usePostThread/views'
import {useAppviewClient, useSession} from '#/state/session'
import {useMergeThreadgateHiddenReplies} from '#/state/threadgate-hidden-replies'
import {useBreakpoints} from '#/alf'
import {IS_WEB} from '#/env'
// HORIZON: identity import
import {prefetchPageIdentities} from '#/horizon/identity/page-prefetch'
// HORIZON: a private thread is retried while prism is busy, never over kept data
import {keepOverData, privateRetryFor} from '#/horizon/private/api/transient'
// HORIZON: a held private anchor is read again on the suspect clock
import {heldPostRefetchInterval} from '#/horizon/private/known'
// HORIZON: the private posts a thread quotes arrive with it
import {resolveThreadQuotes} from '#/horizon/private/quotes/resolve'
// HORIZON: the thread while prism is busy: the load gate, the wait cap, the quiet row
import {
  gateOtherReplies,
  threadStamp,
  useThreadBusy,
  withQuietRow,
} from '#/horizon/private/thread/busy'
// HORIZON: a private thread is read through prism
import {fetchPrivateThreadV2} from '#/horizon/private/thread/fetch'
// HORIZON: hidden replies behind the row: the continuation's key, the shown list without the thread's replies
import {
  continuationKeyOf,
  continuationOf,
  withoutThreadItems,
} from '#/horizon/private/thread/hidden'
// HORIZON: private branches under a public anchor, and private replies past the first read
import {
  fetchOtherReplies,
  withPrivateBranches,
} from '#/horizon/private/thread/replies'
// HORIZON: a private thread is read through prism
import {isPrivateRead} from '#/horizon/private/uri'
// HORIZON: an anchor Bluesky withholds may be a restored post prism serves
import {withRestoredAnchor} from '#/horizon/refract/thread/anchor'
// HORIZON: RF-B5b, the replies Bluesky drops merged in on read, skipped while the lens is involved
import {
  refractMergeAllowed,
  useRestoredThreadMerge,
} from '#/horizon/refract/thread/merge'
// HORIZON: Thread Lens import
import {
  threadLensState,
  useThreadLensRead,
  withLensAnchorRow,
  withLensCacheMutator,
} from '#/horizon/thread-lens/query'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

export * from '#/state/queries/usePostThread/context'
export {useUpdatePostThreadThreadgateQueryCache} from '#/state/queries/usePostThread/queryCache'
export * from '#/state/queries/usePostThread/types'

export function usePostThread({anchor}: {anchor?: string}) {
  const qc = useQueryClient()
  const client = useAppviewClient()
  // HORIZON: the reader, for the further replies' load gate
  const {hasSession, currentAccount} = useSession()
  const currentDid = currentAccount?.did
  const {gtPhone} = useBreakpoints()
  const moderationOpts = useModerationOpts()
  const mergeThreadgateHiddenReplies = useMergeThreadgateHiddenReplies()
  const {
    isLoaded: isThreadPreferencesLoaded,
    sort,
    setSort: baseSetSort,
    view,
    setView: baseSetView,
  } = useThreadPreferences()
  const below = useMemo(() => {
    return view === 'linear'
      ? LINEAR_VIEW_BELOW
      : IS_WEB && gtPhone
        ? TREE_VIEW_BELOW_DESKTOP
        : TREE_VIEW_BELOW
  }, [view, gtPhone])

  // HORIZON: Thread Lens TH-1: the lens keys stand in for the stock ones while the lens is involved (start)
  const lens = useThreadLensRead({did: currentDid, anchor, sort, view, below})
  const postThreadQueryKey = lens.queryKey(
    createPostThreadQueryKey({
      anchor,
      sort,
      view,
    }),
  )
  const postThreadOtherQueryKey = lens.otherQueryKey(
    createPostThreadOtherQueryKey({
      anchor,
    }),
  )
  // HORIZON: Thread Lens TH-1: the lens keys stand in for the stock ones while the lens is involved (end)

  const query = useQuery<UsePostThreadQueryResult>({
    enabled: isThreadPreferencesLoaded && !!anchor && !!moderationOpts,
    queryKey: postThreadQueryKey,
    // HORIZON: Thread Lens TH-18: a reconnect is the screen hook's, not every lens screen's at once
    refetchOnReconnect: lens.refetchOnReconnect,
    async queryFn(ctx) {
      const placeholder = getThreadPlaceholder(qc, anchor!)
      // HORIZON: Thread Lens TH-2: the lens read, or its fallback below tagged at the end (start)
      const lensRun = await lens.run(ctx, placeholder)
      // HORIZON: identity ID-23: warm a lens thread's pronouns and fronters, without waiting
      void prefetchPageIdentities(qc, lensRun.data)
      if (lensRun.data)
        return lensRun.data as unknown as UsePostThreadQueryResult
      // HORIZON: a private thread is read through prism; a public one with its private branches (start)
      const data = isPrivateRead(anchor)
        ? await keepOverData(ctx, () =>
            fetchPrivateThreadV2(
              anchor!,
              {
                below,
                branchingFactor:
                  view === 'linear' ? LINEAR_VIEW_BF : TREE_VIEW_BF,
                sort,
              },
              ctx,
            ),
          )
        : await withPrivateBranches(
            anchor!,
            {
              below,
              branchingFactor:
                view === 'linear' ? LINEAR_VIEW_BF : TREE_VIEW_BF,
              sort,
            },
            () =>
              // HORIZON: an anchor Bluesky withholds may be a restored post prism serves
              withRestoredAnchor(
                anchor!,
                {
                  below,
                  branchingFactor:
                    view === 'linear' ? LINEAR_VIEW_BF : TREE_VIEW_BF,
                  sort,
                },
                () =>
                  client.call(app.bsky.unspecced.getPostThreadV2, {
                    anchor: anchor! as AtUriString,
                    branchingFactor:
                      view === 'linear' ? LINEAR_VIEW_BF : TREE_VIEW_BF,
                    below,
                    sort: sort,
                  }),
              ),
            ctx,
          )
      // HORIZON: a private thread is read through prism; a public one with its private branches (end)
      // HORIZON: the private posts a thread quotes arrive with it
      await resolveThreadQuotes(data.thread)
      // HORIZON: identity ID-23: warm the thread's pronouns and fronters, without waiting
      void prefetchPageIdentities(qc, data.thread)

      const cachedKnownLikers =
        placeholder &&
        bsky.isType(app.bsky.unspecced.defs.threadItemPost, placeholder.value)
          ? placeholder.value.post.viewer?.knownLikers
          : undefined
      if (cachedKnownLikers?.actors.length) {
        const anchorItem = data.thread?.find(item => item.uri === anchor)
        if (
          anchorItem &&
          bsky.isType(
            app.bsky.unspecced.defs.threadItemPost,
            anchorItem.value,
          ) &&
          !anchorItem.value.post.viewer?.knownLikers?.actors.length
        ) {
          anchorItem.value.post.viewer = {
            ...anchorItem.value.post.viewer,
            knownLikers: cachedKnownLikers,
          }
        }
      }

      /*
       * Initialize `ctx.meta` to track if we know we have additional replies
       * we could fetch once we hit the end.
       */
      ctx.meta = ctx.meta || {
        hasOtherReplies: false,
      }

      /*
       * If we know we have additional replies, we'll set this to true.
       */
      if (data.hasOtherReplies) {
        ctx.meta.hasOtherReplies = true
      }

      /*
       * The generated views type `threadgate.record` as an opaque lex map and
       * brand at-uris, so the response is asserted to the exported result type
       * here; the record swap-in below and every downstream consumer of the
       * thread read that narrower contract.
       */
      const result = {
        thread: data.thread || [],
        threadgate: data.threadgate,
        hasOtherReplies: !!ctx.meta.hasOtherReplies,
        // HORIZON: the thread's completion stamp, which the load gate reads
        ...threadStamp(),
        // HORIZON: the key of the continuation the read wrote, which closes an open row when it changes
        ...continuationOf(data),
      } as UsePostThreadQueryResult

      const record = getThreadgateRecord(result.threadgate)
      if (result.threadgate && record) {
        result.threadgate.record = record
      }

      // HORIZON: Thread Lens TH-2: the lens read, or its fallback below tagged at the end (end)
      return lensRun.tag(result)
    },
    // HORIZON: a private thread is retried while prism is busy
    ...privateRetryFor(isPrivateRead(anchor)),
    // HORIZON: a held private anchor is read again on the suspect clock
    refetchInterval: () => heldPostRefetchInterval(anchor),
    placeholderData() {
      if (!anchor) return
      const placeholder = getThreadPlaceholder(qc, anchor)
      /*
       * Always return something here, even empty data, so that
       * `isPlaceholderData` is always true, which we'll use to insert
       * skeletons.
       */
      const thread = placeholder ? [placeholder] : []
      return {thread, threadgate: undefined, hasOtherReplies: false}
    },
    select(data) {
      // HORIZON: Thread Lens TH-14: a lens snapshot becomes the stock answer for the current sort, view and depth
      data = lens.select(data)
      const record = getThreadgateRecord(data.threadgate)
      if (data.threadgate && record) {
        data.threadgate.record = record
      }
      return data
    },
  })

  // HORIZON: the thread while prism is busy: gated items, the wait cap, kept errors
  const busy = useThreadBusy({anchor, queryKey: postThreadQueryKey, query})
  // HORIZON: Thread Lens: the lens state, read once for the items and the answer (TH-22)
  const lensState = threadLensState(
    query.data,
    query.isPlaceholderData,
    postThreadQueryKey,
  )
  // HORIZON: the thread while prism is busy: gated items
  // HORIZON: RF-B5b, restored replies, own replies and hidden parents merged in on read (start)
  const thread = useRestoredThreadMerge({
    anchor,
    thread: busy.thread,
    allowed: refractMergeAllowed({
      kind: lensState.kind,
      lensKey: lens.key !== undefined,
      lensOnly: lens.lensOnly,
    }),
    isPlaceholderData: query.isPlaceholderData,
    below,
    branchingFactor: view === 'linear' ? LINEAR_VIEW_BF : TREE_VIEW_BF,
    sort,
  })
  // HORIZON: RF-B5b, restored replies, own replies and hidden parents merged in on read (end)
  const threadgate = useMemo(
    () => query.data?.threadgate,
    [query.data?.threadgate],
  )
  const hasOtherThreadItems = useMemo(
    () => !!query.data?.hasOtherReplies,
    [query.data?.hasOtherReplies],
  )
  const [otherItemsVisible, setOtherItemsVisible] = useState(false)

  /**
   * Creates a mutator for the post thread cache. This is used to insert
   * replies into the thread cache after posting.
   */
  const mutator = useMemo(
    () =>
      // HORIZON: Thread Lens TH-15: on a lens snapshot, replies join the snapshot
      withLensCacheMutator(
        createCacheMutator({
          params: {view, below},
          postThreadQueryKey,
          postThreadOtherQueryKey,
          queryClient: qc,
        }),
        {
          queryClient: qc,
          postThreadQueryKey,
          postThreadOtherQueryKey,
          params: {view, below},
        },
      ),
    [qc, view, below, postThreadQueryKey, postThreadOtherQueryKey],
  )

  /**
   * If we have additional items available from the server and the user has
   * chosen to view them, start loading data
   */
  const additionalQueryEnabled = hasOtherThreadItems && otherItemsVisible
  const additionalItemsQuery = useQuery({
    enabled: additionalQueryEnabled,
    queryKey: postThreadOtherQueryKey,
    async queryFn(ctx) {
      // HORIZON: private replies past the first read continue here (start)
      // HORIZON: Thread Lens TH-17: the lens other replies on a snapshot, stock for a fallback, nothing for a lens-only anchor
      return await lens.otherReplies(
        () =>
          fetchOtherReplies(
            anchor!,
            () =>
              client.call(app.bsky.unspecced.getPostThreadOtherV2, {
                anchor: anchor! as AtUriString,
              }),
            ctx,
          ),
        ctx,
      )
      // HORIZON: private replies past the first read continue here (end)
    },
  })
  // HORIZON: a thread read that changes the continuation closes the open row; the tap reads the new one (start)
  const threadContinuation = continuationKeyOf(query.data)
  const [seenContinuation, setSeenContinuation] = useState(threadContinuation)
  if (seenContinuation !== threadContinuation) {
    setSeenContinuation(threadContinuation)
    if (
      otherItemsVisible &&
      continuationKeyOf(additionalItemsQuery.data) !== threadContinuation
    ) {
      setOtherItemsVisible(false)
    }
  }
  const showOtherItems = useCallback(() => {
    // HORIZON: Thread Lens: the further replies' key in use, the lens one while the lens is involved
    const otherKey = postThreadOtherQueryKey
    const other = qc.getQueryData(otherKey)
    if (
      other !== undefined &&
      continuationKeyOf(other) !== threadContinuation
    ) {
      void qc.resetQueries({queryKey: otherKey, exact: true})
    }
    setOtherItemsVisible(true)
  }, [qc, postThreadOtherQueryKey, threadContinuation])
  // HORIZON: a thread read that changes the continuation closes the open row; the tap reads the new one (end)
  const serverOtherThreadItems: ThreadItem[] = useMemo(() => {
    if (!additionalQueryEnabled) return []
    if (additionalItemsQuery.isLoading) {
      return Array.from({length: 2}).map((_, i) =>
        views.skeleton({
          key: `other-reply-${i}`,
          item: 'reply',
        }),
      )
      // HORIZON: a failed refetch over data renders its data, not nothing (busy design 6.1)
    } else if (additionalItemsQuery.data?.thread) {
      const {threadItems} = sortAndAnnotateThreadItems(
        // HORIZON: the further replies are gated against the thread's load, without a reply the thread holds
        gateOtherReplies(
          withoutThreadItems(additionalItemsQuery.data.thread, thread),
          currentDid,
          additionalItemsQuery.data.horizonFetchedAt,
          busy.loadSince,
        ),
        {
          view,
          skipModerationHandling: true,
          threadgateHiddenReplies: mergeThreadgateHiddenReplies(
            threadgate?.record,
          ),
          moderationOpts: moderationOpts!,
        },
      )
      return threadItems
    } else {
      return []
    }
  }, [
    view,
    additionalQueryEnabled,
    additionalItemsQuery,
    mergeThreadgateHiddenReplies,
    moderationOpts,
    threadgate?.record,
    // HORIZON: the further replies are gated against the thread's load, without a reply the thread holds
    currentDid,
    busy.loadSince,
    thread,
  ])

  /**
   * Sets the sort order for the thread and resets the additional thread items
   */
  const setSort: typeof baseSetSort = useCallback(
    nextSort => {
      setOtherItemsVisible(false)
      baseSetSort(nextSort)
    },
    [baseSetSort, setOtherItemsVisible],
  )

  /**
   * Sets the view variant for the thread and resets the additional thread items
   */
  const setView: typeof baseSetView = useCallback(
    nextView => {
      setOtherItemsVisible(false)
      baseSetView(nextView)
    },
    [baseSetView, setOtherItemsVisible],
  )

  /*
   * This is the main thread response, sorted into separate buckets based on
   * moderation, and annotated with all UI state needed for rendering.
   */
  const {threadItems, otherThreadItems} = useMemo(() => {
    return sortAndAnnotateThreadItems(thread, {
      view: view,
      threadgateHiddenReplies: mergeThreadgateHiddenReplies(threadgate?.record),
      moderationOpts: moderationOpts!,
    })
  }, [
    thread,
    threadgate?.record,
    mergeThreadgateHiddenReplies,
    moderationOpts,
    view,
  ])

  /*
   * Take all three sets of thread items and combine them into a single thread,
   * along with any other thread items required for rendering e.g. "Show more
   * replies" or the reply composer.
   */
  const items = useMemo(() => {
    // HORIZON: the quiet row below a kept placeholder anchor (busy design 6.1)
    // HORIZON: Thread Lens: the anchor's own "Load more replies" row
    return withLensAnchorRow(
      withQuietRow(
        buildThread({
          threadItems,
          otherThreadItems,
          serverOtherThreadItems,
          // HORIZON: no skeletons past the wait cap (busy design 5)
          isLoading: busy.isLoading,
          hasSession,
          hasOtherThreadItems,
          otherItemsVisible,
          // HORIZON: the tap resets further replies read under another continuation
          showOtherItems,
        }),
        anchor,
        busy.quietRow,
      ),
      lensState,
    )
  }, [
    threadItems,
    otherThreadItems,
    serverOtherThreadItems,
    // HORIZON: no skeletons past the wait cap; the quiet row
    busy.isLoading,
    busy.quietRow,
    anchor,
    hasSession,
    hasOtherThreadItems,
    otherItemsVisible,
    // HORIZON: the tap resets further replies read under another continuation
    showOtherItems,
    // HORIZON: Thread Lens: the anchor's own "Load more replies" row
    lensState,
  ])

  return useMemo(() => {
    const context: PostThreadContextType = {
      postThreadQueryKey,
      postThreadOtherQueryKey,
    }
    return {
      context,
      state: {
        /*
         * Copy in any query state that is useful
         */
        isFetching: query.isFetching,
        isPlaceholderData: query.isPlaceholderData,
        // HORIZON: a transient private failure over something to show is no error (busy design 6.1)
        error: busy.error as typeof query.error,
        // HORIZON: items the load gate hid, for the catching-up note
        horizonHidden: busy.hidden,
        // HORIZON: Thread Lens TH-22: the data kind and the lens notes, for the screen
        lens: lensState,
        /*
         * Other state
         */
        sort,
        view,
        otherItemsVisible,
      },
      data: {
        items,
        threadgate,
      },
      actions: {
        /*
         * Copy in any query actions that are useful
         */
        insertReplies: mutator.insertReplies,
        refetch: query.refetch,
        /*
         * Other actions
         */
        setSort,
        setView,
      },
    }
  }, [
    query,
    mutator.insertReplies,
    otherItemsVisible,
    sort,
    view,
    setSort,
    setView,
    threadgate,
    items,
    postThreadQueryKey,
    postThreadOtherQueryKey,
    // HORIZON: the thread while prism is busy
    busy.error,
    busy.hidden,
    // HORIZON: Thread Lens: the lens state (TH-22)
    lensState,
  ])
}
