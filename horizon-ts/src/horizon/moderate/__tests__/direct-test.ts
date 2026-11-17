import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Member labelers' moderation calls: straight to cairn's direct methods with
 * the moderator's own token, the labeler's id in the body only; and how a
 * labeler's details become the dialog's labeler.
 */

const mockTokens: {aud: string; lxm: string}[] = []
jest.mock('#/lib/media/video/upload.shared', () => ({
  getServiceAuthToken: ({aud, lxm}: {aud: string; lxm: string}) => {
    mockTokens.push({aud, lxm})
    return Promise.resolve('moderator-token')
  },
}))
jest.mock('#/horizon/cairn/primary-labeler', () => ({
  cairnUrl: () => 'https://cairn.example.test',
}))
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => {
    throw new Error('tests pass their own fetch')
  },
}))

import {type Client} from '@atproto/lex'

import {
  DirectModerationError,
  emitDirectEvent,
  getDirectPermissions,
} from '../direct'
import {fromDirectLabeler} from '../from-direct'

const LABELER = 'did:web:cairn.example.test:labeler:abc'
const pdsClient = {} as Client

function fetchOf(status: number, body: unknown) {
  const sent: {url: string; init: RequestInit}[] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    sent.push({url, init})
    return Promise.resolve(new Response(JSON.stringify(body), {status}))
  }) as unknown as typeof fetch
  return {fetchImpl, sent}
}

beforeEach(() => {
  mockTokens.length = 0
})

describe('direct moderation calls', () => {
  it('POST to cairn with the moderator’s token, the id in the body', async () => {
    const {fetchImpl, sent} = fetchOf(200, {eventId: 4})
    await emitDirectEvent(
      pdsClient,
      LABELER,
      {
        event: {
          $type: 'tools.ozone.moderation.defs#modEventLabel',
          createLabelVals: ['x'],
          negateLabelVals: [],
        },
        subject: {$type: 'com.atproto.admin.defs#repoRef', did: 'did:plc:a'},
        audience: 'g1',
      },
      fetchImpl,
    )
    expect(sent[0].url).toBe(
      'https://cairn.example.test/direct/xrpc/tools.cairn.moderation.emitDirectEvent',
    )
    expect(sent[0].url).not.toContain('labeler:')
    expect(sent[0].init.credentials).toBe('omit')
    expect(mockTokens).toEqual([
      {
        aud: 'did:web:cairn.example.test',
        lxm: 'tools.cairn.moderation.emitDirectEvent',
      },
    ])
    expect(JSON.parse(sent[0].init.body as string)).toMatchObject({
      labeler: LABELER,
      audience: 'g1',
    })
  })

  it('read “not available” as final and a busy membership check as retryable', async () => {
    const refused = await getDirectPermissions(
      pdsClient,
      fetchOf(400, {error: 'InvalidRequest'}).fetchImpl,
    ).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(DirectModerationError)
    expect((refused as DirectModerationError).notAvailable).toBe(true)
    const busy = await getDirectPermissions(
      pdsClient,
      fetchOf(503, {error: 'MembershipUnavailable'}).fetchImpl,
    ).catch((e: unknown) => e)
    expect((busy as DirectModerationError).retryable).toBe(true)
  })
})

describe('fromDirectLabeler', () => {
  it('keeps values, audiences, flag targets and the labeler’s own reason names', () => {
    const labeler = fromDirectLabeler(
      {
        labeler: LABELER,
        name: 'Umbrae test',
        kind: 'moderation',
        labelValues: [
          {
            identifier: 'sophias',
            severity: 'inform',
            blurs: 'none',
            defaultSetting: 'warn',
            adultOnly: false,
            locales: [{lang: 'en', name: 'Sophia', description: 'Sophia cels'}],
          },
        ],
        audiences: [{id: 'g1', name: 'Group One'}],
        reasons: {
          groups: [{id: 'harm', locales: [{lang: 'en', title: 'Harm'}]}],
          reasons: [
            {
              type: 'tools.cairn.report.defs#reasonDogpiling',
              group: 'harm',
              locales: [{lang: 'en', title: 'Dogpiling'}],
            },
            {type: 'tools.cairn.report.defs#reasonOther', locales: []},
          ],
        },
        policies: [],
        severityLevels: [],
        flagTargets: [
          {
            did: 'did:plc:pub',
            name: 'Public',
            reasonTypes: [],
            canEscalate: false,
          },
        ],
      },
      ['labels.apply'],
    )
    expect(labeler.source).toBe('member')
    expect(labeler.defs.map(def => def.identifier)).toEqual(['sophias'])
    expect(labeler.audiences).toEqual([{id: 'g1', name: 'Group One'}])
    expect(labeler.reasonTypes).toEqual([
      'tools.cairn.report.defs#reasonDogpiling',
      'tools.cairn.report.defs#reasonOther',
    ])
    expect(labeler.reasonNames).toEqual({
      'tools.cairn.report.defs#reasonDogpiling': 'Harm: Dogpiling',
    })
    expect(labeler.flagTargets).toHaveLength(1)
  })

  it('reads a labels-only labeler as one', () => {
    expect(
      fromDirectLabeler(
        {
          labeler: LABELER,
          name: 'L',
          kind: 'labels_only',
          labelValues: [],
          audiences: [],
          policies: [],
          severityLevels: [],
        },
        ['labels.apply'],
      ).kind,
    ).toBe('labels_only')
  })
})
