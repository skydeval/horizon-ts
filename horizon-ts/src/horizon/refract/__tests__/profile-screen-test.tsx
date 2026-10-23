import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  REFRACT: true,
}))
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  subscribeMembership: () => () => {},
  isPrivateMember: () => true,
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

import {useState} from 'react'
import {Pressable, Text} from 'react-native'
import {XrpcResponseError} from '@atproto/lex'
import {QueryClientProvider, useQuery} from '@tanstack/react-query'
import {act, fireEvent, render, screen} from '@testing-library/react-native'

import {RF_DID, RF_STOCK_DID, rfProfile} from '#/horizon/refract/fixtures'
import {dropNotedRestored, noteRestored} from '#/horizon/refract/marker'
import {refractProfileQuery, shownProfileError} from '#/horizon/refract/profile'
import {app} from '#/lexicons'
import {type Harness, setupRefract} from './harness'

/*
 * Bug: a stock profile fetch that failed (the web hover prefetch shares the
 * profile query's key) put "Account has been suspended" on the profile
 * query, and `Profile.tsx` checks the error before the data: the screen
 * flashed the error, then remounted on the Posts tab. The screen below has
 * `Profile.tsx`'s order of checks and its hooked line.
 */

function takedown() {
  const body = {error: 'AccountTakedown', message: 'Account has been suspended'}
  return new XrpcResponseError(
    app.bsky.actor.getProfile as never,
    new Response(JSON.stringify(body), {
      status: 400,
      headers: {'content-type': 'application/json'},
    }),
    {encoding: 'application/json', body} as never,
  )
}

function Loaded() {
  const [tab, setTab] = useState(0)
  return (
    <Pressable
      testID="replies"
      accessibilityRole="button"
      onPress={() => setTab(1)}>
      <Text testID="tab">{tab === 1 ? 'Replies' : 'Posts'}</Text>
    </Pressable>
  )
}

function Screen({did}: {did: string}) {
  const {data, error: queryError} = useQuery({
    queryKey: ['profile', did],
    staleTime: Infinity,
    queryFn: () => refractProfileQuery(did, () => Promise.reject(takedown())),
  })
  const error = shownProfileError(data, queryError)
  if (error) return <Text testID="error">error</Text>
  if (data) return <Loaded />
  return <Text testID="loading">loading</Text>
}

let h: Harness

beforeEach(() => {
  h = setupRefract()
})

afterEach(() => {
  h.queryClient.clear()
})

function renderScreen(did: string) {
  return render(
    <QueryClientProvider client={h.queryClient}>
      <Screen did={did} />
    </QueryClientProvider>,
  )
}

async function stockRefetchFails(did: string) {
  await act(async () => {
    await h.queryClient
      .fetchQuery({
        queryKey: ['profile', did],
        staleTime: 0,
        queryFn: () => Promise.reject(takedown()),
      })
      .catch(() => {})
    // Let the query's batched notify re-render the screen.
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

describe('the profile screen over a restored profile', () => {
  it('a stock refetch that errors keeps the profile and its tab', async () => {
    const restored = rfProfile()
    noteRestored(RF_DID)
    h.queryClient.setQueryData(['profile', RF_DID], restored)
    renderScreen(RF_DID)
    fireEvent.press(screen.getByTestId('replies'))
    expect(screen.getByTestId('tab').props.children).toBe('Replies')

    await stockRefetchFails(RF_DID)

    // The query holds the stock error, the screen doesn't show it.
    expect(h.queryClient.getQueryState(['profile', RF_DID])?.error).toBeTruthy()
    expect(screen.queryByTestId('error')).toBeNull()
    expect(screen.getByTestId('tab').props.children).toBe('Replies')
    expect(h.queryClient.getQueryData(['profile', RF_DID])).toBe(restored)
  })

  it('a restore that ended shows the error', async () => {
    noteRestored(RF_DID)
    h.queryClient.setQueryData(['profile', RF_DID], rfProfile())
    renderScreen(RF_DID)
    dropNotedRestored(RF_DID)
    await stockRefetchFails(RF_DID)
    expect(screen.getByTestId('error')).toBeTruthy()
  })

  it('a stock profile keeps stock behaviour', async () => {
    h.queryClient.setQueryData(
      ['profile', RF_STOCK_DID],
      rfProfile(RF_STOCK_DID, {restored: false}),
    )
    renderScreen(RF_STOCK_DID)
    await stockRefetchFails(RF_STOCK_DID)
    expect(screen.getByTestId('error')).toBeTruthy()
  })
})
