import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * skydeval, 2026-10-27: a missing quote asks fill only for an author on a
 * refracted community's PDS; any other is "Deleted" with no call. The host
 * match is prism's (getCommunities).
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
const mockPds = new Map<string, string>()
jest.mock('#/horizon/private/adapt/pds', () => ({
  authorPdsUrl: (did: string) => Promise.resolve(mockPds.get(did)),
}))

import {
  matchesCommunityHost,
  pdsHostOf,
  quoteNeedsFill,
  resetCommunities,
} from '#/horizon/refract/communities'
import {type Harness, setupRefract} from './harness'

const ON_COMMUNITY = 'did:plc:oncommunityaaaaaaaaaaaaa'
const ELSEWHERE = 'did:plc:elsewhereaaaaaaaaaaaaaaa'
const UNKNOWN = 'did:plc:unknownpdsaaaaaaaaaaaaaa'

let h: Harness

beforeEach(() => {
  h = setupRefract()
  resetCommunities()
  mockPds.clear()
  mockPds.set(ON_COMMUNITY, 'https://Members.Community.example:443')
  mockPds.set(ELSEWHERE, 'https://oyster.us-east.host.bsky.network')
})

afterEach(() => {
  resetCommunities()
})

function communities() {
  return {
    communities: [{name: 'c', pdsPatterns: ['*.community.example', 'community.example']}],
  }
}

describe('the host match', () => {
  it('follows prism: *.x needs a label in front, other patterns are exact', () => {
    const patterns = ['*.community.example', 'pds.example.com']
    expect(matchesCommunityHost('members.community.example', patterns)).toBe(true)
    expect(matchesCommunityHost('A.B.Community.Example', patterns)).toBe(true)
    expect(matchesCommunityHost('community.example', patterns)).toBe(false)
    expect(matchesCommunityHost('evilcommunity.example', patterns)).toBe(false)
    expect(matchesCommunityHost('pds.example.com', patterns)).toBe(true)
    expect(matchesCommunityHost('x.pds.example.com', patterns)).toBe(false)
    expect(matchesCommunityHost('anything', [])).toBe(false)
  })

  it('takes the PDS host lowercased, without its port', () => {
    expect(pdsHostOf('https://Members.Community.example:443/')).toBe(
      'members.community.example',
    )
    expect(pdsHostOf('not a url')).toBeUndefined()
  })
})

describe('which quotes ask fill', () => {
  it('a community author, yes; any other author, no', async () => {
    h.respond(() => communities())
    expect(await quoteNeedsFill(ON_COMMUNITY)).toBe(true)
    expect(await quoteNeedsFill(ELSEWHERE)).toBe(false)
    // One list fetch, kept.
    expect(
      h.calls.filter(call => call.method.endsWith('.getCommunities')).length,
    ).toBe(1)
  })

  it('asks when Horizon cannot tell: no list, or an unknown PDS', async () => {
    h.respond(() => {
      throw new Error('not served')
    })
    expect(await quoteNeedsFill(ELSEWHERE)).toBe(true)
    resetCommunities()
    h.respond(() => communities())
    expect(await quoteNeedsFill(UNKNOWN)).toBe(true)
  })

  it('an empty list sends no quote to fill', async () => {
    h.respond(() => ({communities: []}))
    expect(await quoteNeedsFill(ON_COMMUNITY)).toBe(false)
  })
})
