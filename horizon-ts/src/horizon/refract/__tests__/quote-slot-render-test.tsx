import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * 2026-10-27, the cold-load bug: fill returned the quoted post, but the card
 * kept "Deleted". The slot's hook read the store with plain calls that React
 * Compiler cached on the first render. A warm load worked because the post
 * was already stored when the card mounted. Renders the real slot.
 */

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
// The author's PDS doesn't resolve here: the card asks fill.
jest.mock('#/horizon/private/adapt/pds', () => ({
  authorPdsUrl: () => Promise.resolve(undefined),
}))

import {Text} from 'react-native'
import {act, render, screen, waitFor} from '@testing-library/react-native'

import {resetCommunities} from '#/horizon/refract/communities'
import {
  rfFillAnswer,
  rfPost,
  rfProfile,
  rfUri,
} from '#/horizon/refract/fixtures'
import {RestoredQuoteSlot} from '#/horizon/refract/RestoredQuote'
import {deferred, flush, type Harness, setupRefract} from './harness'

let h: Harness

beforeEach(() => {
  h = setupRefract()
  resetCommunities()
})

afterEach(() => {
  resetCommunities()
})

describe('the quote card', () => {
  it('shows "Deleted" at once, then the post when fill returns it', async () => {
    const answer = deferred<unknown>()
    h.respond(call =>
      call.method.endsWith('.fill')
        ? answer.promise
        : {communities: [{name: 'c', pdsPatterns: ['community.example']}]},
    )
    render(
      <RestoredQuoteSlot
        uri={rfUri('rf1')}
        render={quote => <Text>post {quote.view.uri}</Text>}
        placeholder={kind => <Text>{kind}</Text>}
      />,
    )
    expect(screen.getByText('deleted')).toBeTruthy()
    await waitFor(() => expect(h.fills().length).toBe(1))
    await act(async () => {
      answer.resolve(
        rfFillAnswer({
          profiles: [rfProfile()],
          posts: [rfPost('rf1')],
          withheld: [],
        }),
      )
      await flush()
    })
    await waitFor(() =>
      expect(screen.getByText(`post ${rfUri('rf1')}`)).toBeTruthy(),
    )
  })
})
