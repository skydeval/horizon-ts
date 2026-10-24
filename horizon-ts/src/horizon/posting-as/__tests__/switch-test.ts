import {describe, expect, it, jest} from '@jest/globals'

/*
 * `POSTING_AS` off restores stock at every hook (Phase 5 design 10): no
 * session, no fronters, the current account's clients, nothing dropped
 * from a restored draft, and the hold never blocks.
 */
jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  POSTING_AS: false,
}))
jest.mock('#/components/Toast', () => ({show: () => {}}))
jest.mock('#/state/persisted', () => ({
  get: (key: string) => (key === 'session' ? {accounts: []} : undefined),
  write: () => Promise.resolve(),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({accounts: [], currentAccount: undefined}),
  useMaybePdsClient: () => null,
}))
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => Promise.reject(new Error('no network in tests')),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))

import {type Client} from '@atproto/lex'
import {QueryClient} from '@tanstack/react-query'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {getPostingState, postingAllowsFor} from '../compose-store'
import {applyDraftPostingAs, captureDraftPostingAs} from '../drafts'
import {postingFronters} from '../fronters'
import {choosePostingAccount, startPostingSession} from '../gates'
import {beginPostingPublish} from '../publish'

const MAIN = 'did:plc:mainaaaaaaaaaaaaaaaaaaaa'
const client = {assertDid: MAIN} as unknown as Client

describe('POSTING_AS off', () => {
  it('starts no session, writes no fronters, and posts with the stock clients', () => {
    clearCurrentClients()
    publishCurrentClients({
      did: MAIN,
      handle: 'main.test',
      pdsUrl: undefined,
      pdsClient: client,
      prismClient: client,
      appviewClient: client,
    })
    startPostingSession(MAIN, 'main.test')
    expect(getPostingState().active).toBe(false)
    choosePostingAccount('did:plc:otherbbbbbbbbbbbbbbbbbbbb')
    expect(getPostingState().did).toBeUndefined()
    expect(postingAllowsFor(getPostingState())).toBe(true)
    expect(postingFronters(undefined, MAIN)).toEqual([])
    expect(captureDraftPostingAs()).toBeUndefined()
    expect(applyDraftPostingAs('draft-1')).toBeUndefined()
    const stock = {appviewClient: client, chatClient: client, pdsClient: client}
    const receipt = beginPostingPublish(
      stock,
      {threadgate: [{type: 'list', list: 'at://x/app.bsky.graph.list/y'}]},
      new QueryClient(),
    )
    expect(receipt.clients).toBe(stock)
    expect(receipt.postedAs).toBeUndefined()
  })
})
