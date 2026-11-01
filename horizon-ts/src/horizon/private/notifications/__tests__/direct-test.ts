import {type Client} from '@atproto/lex'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'

import {
  NOTIFICATIONS_DIRECT_PREFETCH,
  PRIVATE_LIST_NOTIFICATIONS_LXM,
  privateReadClient,
} from '#/horizon/private/notifications/direct'

const mockGetCurrentClients = jest.fn<() => unknown>()
const mockGetDirectPrismToken = jest.fn<() => Promise<string>>()
const directClient = {name: 'direct'} as unknown as Client

jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentClients: () => mockGetCurrentClients(),
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  PRIVATE_GET_POSTS_LXM: 'app.nearhorizon.private.getPosts',
  getDirectPrismToken: () => mockGetDirectPrismToken(),
  getDirectPrismClient: () => directClient,
  startDirectTokenPrefetch: () => () => {},
}))

const proxied = {name: 'proxied'} as unknown as Client
const source = {did: 'did:plc:reader', prism: proxied}

beforeEach(() => {
  mockGetCurrentClients.mockReset()
  mockGetDirectPrismToken.mockReset()
})

describe('privateReadClient', () => {
  it('reads prism directly when a token can be had', async () => {
    mockGetCurrentClients.mockReturnValue({
      did: 'did:plc:reader',
      pdsClient: {},
    })
    mockGetDirectPrismToken.mockResolvedValue('token')
    await expect(
      privateReadClient(source, PRIVATE_LIST_NOTIFICATIONS_LXM),
    ).resolves.toBe(directClient)
  })

  it('goes through the PDS when no token can be minted', async () => {
    mockGetCurrentClients.mockReturnValue({
      did: 'did:plc:reader',
      pdsClient: {},
    })
    mockGetDirectPrismToken.mockRejectedValue(new Error('rate limited'))
    await expect(
      privateReadClient(source, PRIVATE_LIST_NOTIFICATIONS_LXM),
    ).resolves.toBe(proxied)
  })

  it('never reads directly as another account', async () => {
    mockGetCurrentClients.mockReturnValue({
      did: 'did:plc:someone-else',
      pdsClient: {},
    })
    mockGetDirectPrismToken.mockResolvedValue('token')
    await expect(
      privateReadClient(source, PRIVATE_LIST_NOTIFICATIONS_LXM),
    ).resolves.toBe(proxied)
    expect(mockGetDirectPrismToken).not.toHaveBeenCalled()
  })

  it('goes through the PDS while no account is published', async () => {
    mockGetCurrentClients.mockReturnValue(undefined)
    await expect(
      privateReadClient(source, PRIVATE_LIST_NOTIFICATIONS_LXM),
    ).resolves.toBe(proxied)
  })
})

describe('NOTIFICATIONS_DIRECT_PREFETCH', () => {
  it('mints the list and post tokens on every route', () => {
    expect(NOTIFICATIONS_DIRECT_PREFETCH.methods).toEqual([
      'app.nearhorizon.private.listNotifications',
      'app.nearhorizon.private.getPosts',
    ])
    expect(NOTIFICATIONS_DIRECT_PREFETCH.routes).toBe('any')
  })
})
