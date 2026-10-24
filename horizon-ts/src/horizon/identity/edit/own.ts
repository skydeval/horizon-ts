/*
 * The editors' reads of the account's own records (Phase 5 design 4.4,
 * 4.6, 7): the same identity entries every other site reads, observed with
 * the profile's fresh read on mount (4.5), so an editor opens on the cached
 * value at once and its CID is the one last read. Own records come from the
 * own PDS (`reads.ts`), never unknown; a failed read is an error the editor
 * shows with "Try again", and nothing is saved over a record not read.
 */

import {useEffect} from 'react'
import {useQueries, useQueryClient} from '@tanstack/react-query'

import {useSession} from '#/state/session'
import {
  identityAnswerFromState,
  type IdentityArgs,
  type IdentityData,
  type IdentityKind,
  identityQueryOptions,
  observeIdentity,
} from '#/horizon/identity/queries'
import {type OwnWriter} from '#/horizon/identity/writes'
import {useCurrentClients} from '#/horizon/routing/current-clients'

/** One own entry as an editor reads it. */
export type OwnEntry<K extends IdentityKind> =
  | {state: 'loading'; answer: undefined}
  | {state: 'error'; answer: undefined}
  | {state: 'ready'; answer: IdentityData[K]}

/**
 * The entry `kind` for `args`, or a loading entry while `args` is
 * `undefined`. `retry` asks again.
 */
export function useOwnEntry<K extends IdentityKind>(
  kind: K,
  args: IdentityArgs[K] | undefined,
): OwnEntry<K> & {retry: () => void} {
  const queryClient = useQueryClient()
  const specs: IdentityArgs[K][] = args ? [args] : []
  const results = useQueries({
    queries: specs.map(spec => ({
      ...identityQueryOptions(kind, spec),
      enabled: false,
    })),
  })
  const result = results[0] as (typeof results)[number] | undefined
  const hash = args ? JSON.stringify(args) : ''
  useEffect(() => {
    if (!hash) return
    return observeIdentity(
      queryClient,
      kind,
      JSON.parse(hash) as IdentityArgs[K],
      'profile',
    )
  }, [queryClient, kind, hash])

  const retry = () => {
    if (!args) return
    void queryClient
      .fetchQuery({...identityQueryOptions(kind, args), staleTime: 0})
      .catch(() => undefined)
  }
  const answer = result
    ? identityAnswerFromState(
        kind,
        result as Parameters<typeof identityAnswerFromState<K>>[1],
      )
    : undefined
  if (answer !== undefined) return {state: 'ready', answer, retry}
  if (result?.status === 'error' && result.fetchStatus !== 'fetching') {
    return {state: 'error', answer: undefined, retry}
  }
  return {state: 'loading', answer: undefined, retry}
}

/**
 * The current account as a writer, or `undefined` signed out or while the
 * published clients still name the previous account.
 */
export function useOwnWriter(): OwnWriter | undefined {
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const clients = useCurrentClients()
  if (!currentAccount || !clients || clients.did !== currentAccount.did) {
    return undefined
  }
  return {did: clients.did, pdsClient: clients.pdsClient, queryClient}
}
