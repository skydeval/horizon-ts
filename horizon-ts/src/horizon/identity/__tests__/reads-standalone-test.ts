import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * PP-20 as amended (2026-10-26): with IDENTITY_PRISM_READS off, the client
 * reads other accounts' pronouns and plural records from their own repos and
 * never asks prism, as a client with no AppView of its own.
 */

jest.mock(
  '#/state/session/network',
  () => jest.requireActual<{networkMock: unknown}>('./harness').networkMock,
)
jest.mock('#/state/session', () => ({useMaybePdsClient: () => null}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: (did: string) =>
    Promise.resolve({did, pdsUrl: 'https://author-pds.example'}),
}))
jest.mock('#/lib/lexClient', () => ({
  ...jest.requireActual<object>('#/lib/lexClient'),
  createServiceClient: (url: string) =>
    jest
      .requireActual<{pdsClientFor: (did: string) => unknown}>('./harness')
      .pdsClientFor(url),
}))
jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  IDENTITY_PRISM_READS: false,
}))
jest.mock('#/horizon/routing/write-route', () => ({
  getWriteRoute: () => ({postingRoute: 'repo'}),
  subscribeWriteRoutes: () => () => {},
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))
// The PDS fixtures' CIDs are validated by the lex client.
jest.unmock('multiformats/cid')

import {
  readActorRecords,
  readMemberList,
  readMemberRecord,
  resetIdentityReads,
} from '../reads'
import {
  AUTHOR,
  MEMBER,
  pds,
  prism,
  PRONOUNS,
  READER,
  records,
  resetHarness,
  serviceAuthCalls,
  signIn,
  SYSTEM,
  uriOf,
  WREN,
} from './harness'

beforeEach(() => {
  jest.useFakeTimers({now: 1_790_000_000_000})
  resetHarness()
  resetIdentityReads()
  pds.records.set(uriOf(AUTHOR, PRONOUNS), records.pronouns([['she', 'her']]))
  pds.records.set(uriOf(AUTHOR, SYSTEM), records.system())
  pds.records.set(uriOf(AUTHOR, MEMBER, WREN), records.member('Wren'))
})

afterEach(() => {
  jest.useRealTimers()
})

describe('IDENTITY_PRISM_READS off', () => {
  it.each([
    ['signed out', () => {}],
    ['signed in', () => void signIn(READER)],
  ])(
    '%s: reads every account from its repo and never asks prism',
    async (_label, setUp) => {
      setUp()
      const actor = readActorRecords(AUTHOR)
      const member = readMemberRecord(AUTHOR, WREN)
      const list = readMemberList(AUTHOR)
      await jest.advanceTimersByTimeAsync(60)
      const answers = await actor
      expect(answers.pronouns.status).toBe('record')
      expect(answers.system.status).toBe('record')
      expect((await member).answer.status).toBe('record')
      expect((await list).status).toBe('complete')
      expect(prism.calls).toHaveLength(0)
      expect(serviceAuthCalls()).toHaveLength(0)
    },
  )
})
