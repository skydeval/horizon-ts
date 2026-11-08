/*
 * The feedback inbox's data: whether the signed-in account may read reports,
 * the reports page by page, and marking one done.
 */

import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import {STALE} from '#/state/queries'
import {createQueryKey} from '#/state/queries/util'
import {useSession} from '#/state/session'
import {
  type FeedbackReport,
  listFeedback,
  markFeedback,
} from '#/horizon/feedback/api'

/** Which reports the inbox shows: open ones, done ones, or all. */
export type FeedbackFilter = 'open' | 'done' | 'all'

type Page = {reports: FeedbackReport[]; cursor?: string}

const feedbackAdminQueryRoot = 'horizon-feedback-admin'
const feedbackInboxQueryRoot = 'horizon-feedback-inbox'

/** True when the signed-in account is on the service's admin list. */
export function useFeedbackAdminQuery() {
  const {currentAccount} = useSession()
  return useQuery({
    queryKey: createQueryKey(feedbackAdminQueryRoot, {
      did: currentAccount?.did,
    }),
    enabled: !!currentAccount,
    staleTime: STALE.HOURS.ONE,
    retry: false,
    queryFn: async () => (await listFeedback({limit: 1})) !== 'forbidden',
  })
}

function doneFor(filter: FeedbackFilter): boolean | undefined {
  return filter === 'all' ? undefined : filter === 'done'
}

export function useFeedbackInboxQuery(filter: FeedbackFilter) {
  const {currentAccount} = useSession()
  return useInfiniteQuery({
    queryKey: createQueryKey(feedbackInboxQueryRoot, {
      did: currentAccount?.did,
      filter,
    }),
    enabled: !!currentAccount,
    staleTime: STALE.SECONDS.FIFTEEN,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: Page) => page.cursor,
    queryFn: async ({pageParam}): Promise<Page> => {
      const page = await listFeedback({
        cursor: pageParam,
        done: doneFor(filter),
      })
      if (page === 'forbidden') return {reports: []}
      return page
    },
  })
}

/** Mark a report done or open; the inbox updates at once. */
export function useMarkFeedbackMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({id, done}: {id: number; done: boolean}) =>
      markFeedback(id, done),
    onMutate: ({id, done}) => {
      queryClient.setQueriesData<InfiniteData<Page>>(
        {queryKey: [feedbackInboxQueryRoot]},
        data =>
          data && {
            ...data,
            pages: data.pages.map(page => ({
              ...page,
              reports: page.reports.map(report =>
                report.id === id ? {...report, done} : report,
              ),
            })),
          },
      )
    },
    onSettled: () => {
      void queryClient.invalidateQueries({queryKey: [feedbackInboxQueryRoot]})
    },
  })
}
