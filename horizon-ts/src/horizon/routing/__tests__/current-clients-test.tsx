import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, render, renderHook} from '@testing-library/react-native'

const DID_A = 'did:plc:accountaaaaaaaaaaaaaaaaaa'
const DID_B = 'did:plc:accountbbbbbbbbbbbbbbbbbb'

const mockPds = {name: 'pds'}
const mockAppview = {name: 'appview'}
const mockPrism = {name: 'prism'}
let mockAccount: {did: string; handle: string; service: string} | undefined
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: mockAccount}),
  useMaybePdsClient: () => (mockAccount ? mockPds : null),
  useMaybeChatClient: () => null,
  useAppviewClient: () => mockAppview,
}))
jest.mock('#/horizon/routing/prism', () => ({
  getPrismClient: () => mockPrism,
}))
let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  useMembership: () => mockMembership,
  getMembership: () => mockMembership,
  isPrivateMember: (did?: string) => !!did && mockMembership === 'member',
}))

import {type Client} from '@atproto/lex'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {usePrivateFeedSource} from '#/horizon/private/membership'
import {
  clearCurrentClients,
  getCurrentClients,
  getCurrentPrismClient,
  PrivateClientUnavailableError,
  publishCurrentClients,
  requireCurrentClients,
} from '../current-clients'
import {CurrentClientsPublisher} from '../CurrentClientsPublisher'

const queryClient = new QueryClient()

function Publisher() {
  return (
    <QueryClientProvider client={queryClient}>
      <CurrentClientsPublisher />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  clearCurrentClients()
  mockAccount = {did: DID_A, handle: 'a.test', service: 'https://pds.example'}
  mockMembership = 'member'
})

describe('the current-clients record', () => {
  it('is set after the publisher’s layout effect and cleared on unmount', () => {
    expect(getCurrentClients()).toBeUndefined()
    const screen = render(<Publisher />)
    expect(getCurrentClients()).toMatchObject({
      did: DID_A,
      handle: 'a.test',
      pdsUrl: 'https://pds.example',
      pdsClient: mockPds,
      prismClient: mockPrism,
      appviewClient: mockAppview,
      queryClient,
    })
    screen.unmount()
    expect(getCurrentClients()).toBeUndefined()
  })

  it('is not published while signed out', () => {
    mockAccount = undefined
    render(<Publisher />)
    expect(getCurrentClients()).toBeUndefined()
    expect(getCurrentPrismClient()).toBeUndefined()
  })

  it('private functions throw PrivateClientUnavailableError with no record', () => {
    expect(() => requireCurrentClients()).toThrow(PrivateClientUnavailableError)
  })
})

describe('usePrivateFeedSource', () => {
  const record = (did: string) => ({
    did,
    handle: 'x.test',
    pdsUrl: undefined,
    pdsClient: mockPds as unknown as Client,
    prismClient: mockPrism as unknown as Client,
    appviewClient: mockAppview as unknown as Client,
  })

  it('returns no source while the record names another account, and one once the publish lands', () => {
    publishCurrentClients(record(DID_B))
    const {result} = renderHook(() => usePrivateFeedSource())
    expect(result.current).toBeUndefined()
    act(() => {
      publishCurrentClients(record(DID_A))
    })
    expect(result.current).toEqual({
      did: DID_A,
      prism: mockPrism,
      appview: mockAppview,
    })
  })

  it('returns no source for a non-member', () => {
    mockMembership = 'not-member'
    publishCurrentClients(record(DID_A))
    const {result} = renderHook(() => usePrivateFeedSource())
    expect(result.current).toBeUndefined()
  })
})
