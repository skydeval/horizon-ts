import {type Client} from '@atproto/lex'
import {describe, expect, it} from '@jest/globals'

import {
  currentLabels,
  emitEvent,
  getMyPermissions,
  hasOpenReports,
} from '../api'
import {isCairnHosted, labelerEndpoint} from '../hosts'
import {actionComment, reasonFallbackName} from '../permissions'

describe('reasons', () => {
  it('read tokens as words when no name is known', () => {
    expect(reasonFallbackName('tools.cairn.report.defs#reasonDogpiling')).toBe(
      'Dogpiling',
    )
    expect(reasonFallbackName('tools.ozone.report.defs#reasonSexualNCII')).toBe(
      'Sexual ncii',
    )
    expect(reasonFallbackName('com.atproto.moderation.defs#reasonSpam')).toBe(
      'Spam',
    )
  })

  it('go above the note in the kept text', () => {
    expect(actionComment(undefined, '  ')).toBeUndefined()
    expect(actionComment(undefined, 'n')).toBe('n')
    expect(actionComment({token: 't#reasonX', name: 'X'}, '')).toBe(
      'Reason: X (t#reasonX)',
    )
  })
})

const LABELER = 'did:plc:cairnlabeler'

function pds(answer: unknown, status = 200) {
  const calls: {path: string; init: RequestInit}[] = []
  const client = {
    agent: {
      fetchHandler: (path: string, init: RequestInit) => {
        calls.push({path, init})
        return Promise.resolve(
          new Response(JSON.stringify(answer), {
            status,
            headers: {'content-type': 'application/json'},
          }),
        )
      },
    },
  } as unknown as Client
  return {client, calls}
}

describe('moderation calls', () => {
  it('go through the PDS, proxied to the chosen labeler', async () => {
    const {client, calls} = pds({
      labeler: LABELER,
      did: 'did:plc:me',
      member: true,
      permissions: ['labels.apply'],
    })
    await getMyPermissions(client, LABELER)
    expect(calls[0].path).toBe('/xrpc/tools.cairn.team.getMyPermissions')
    expect(new Headers(calls[0].init.headers).get('atproto-proxy')).toBe(
      `${LABELER}#atproto_labeler`,
    )
  })

  it('send emitEvent as a POST with the moderator as creator', async () => {
    const {client, calls} = pds({id: 3})
    await emitEvent(client, LABELER, {
      event: {$type: 'tools.ozone.moderation.defs#modEventTakedown'},
      subject: {$type: 'com.atproto.admin.defs#repoRef', did: 'did:plc:x'},
      createdBy: 'did:plc:me',
    })
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      event: {$type: 'tools.ozone.moderation.defs#modEventTakedown'},
      subject: {$type: 'com.atproto.admin.defs#repoRef', did: 'did:plc:x'},
      createdBy: 'did:plc:me',
      subjectBlobCids: [],
    })
  })

  it('throw by status and error name', async () => {
    const {client} = pds({error: 'AuthenticationRequired'}, 401)
    await expect(getMyPermissions(client, LABELER)).rejects.toMatchObject({
      status: 401,
      error: 'AuthenticationRequired',
    })
  })
})

describe('currentLabels', () => {
  it('keeps the latest record per value, dropping negations and expired ones', () => {
    const uri = 'at://did:plc:a/app.bsky.feed.post/1'
    const labels = [
      {src: LABELER, uri, val: 'a', cts: '2026-01-01T00:00:00Z'},
      {src: LABELER, uri, val: 'a', cts: '2026-01-02T00:00:00Z', neg: true},
      {src: LABELER, uri, val: 'b', cts: '2026-01-01T00:00:00Z'},
      {
        src: LABELER,
        uri,
        val: 'c',
        cts: '2026-01-01T00:00:00Z',
        exp: '2026-01-05T00:00:00Z',
      },
      {src: 'did:plc:other', uri, val: 'd', cts: '2026-01-01T00:00:00Z'},
    ]
    expect(
      currentLabels(labels, uri, LABELER, Date.parse('2026-02-01')).map(
        label => label.val,
      ),
    ).toEqual(['b'])
  })

  it('open reports are open or escalated review states', () => {
    expect(
      hasOpenReports({reviewState: 'tools.ozone.moderation.defs#reviewOpen'}),
    ).toBe(true)
    expect(
      hasOpenReports({reviewState: 'tools.ozone.moderation.defs#reviewClosed'}),
    ).toBe(false)
    expect(hasOpenReports(undefined)).toBe(false)
  })
})

describe('which labelers are asked', () => {
  it('only cairn-hosted ones', () => {
    const base = 'https://cairn.example.test'
    expect(isCairnHosted('https://cairn.example.test', base)).toBe(true)
    expect(isCairnHosted('https://mod.cairn.example.test/', base)).toBe(true)
    expect(isCairnHosted('https://evilcairn.example.test', base)).toBe(false)
    expect(isCairnHosted('https://other.example', base)).toBe(false)
    expect(isCairnHosted(undefined, base)).toBe(false)
  })

  it('reads the labeler endpoint from the DID document', async () => {
    const fetchImpl = ((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url === 'https://plc.directory/did:plc:abc'
              ? {
                  service: [
                    {
                      id: '#atproto_labeler',
                      serviceEndpoint: 'https://mod.cairn.example.test',
                    },
                  ],
                }
              : {},
          ),
        ),
      )) as unknown as typeof fetch
    expect(await labelerEndpoint('did:plc:abc', fetchImpl)).toBe(
      'https://mod.cairn.example.test',
    )
    expect(await labelerEndpoint('did:key:zzz', fetchImpl)).toBeUndefined()
  })
})
