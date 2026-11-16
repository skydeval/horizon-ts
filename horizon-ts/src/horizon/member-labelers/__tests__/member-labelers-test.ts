import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Member labelers: their labels reach every AppView view before moderation
 * runs, their ids never reach a public server, and reports go straight to
 * cairn. Synthetic fixtures only; prism and cairn are fakes.
 */

const VIEWER = 'did:plc:mlviewer00000000000000001'
const OTHER = 'did:plc:mlother000000000000000001'
const LABELER = 'did:web:cairn.example.test:labeler:mltest1'
const LABELS_ONLY = 'did:web:cairn.example.test:labeler:mltest2'
const POST = `at://${OTHER}/app.bsky.feed.post/3mlaaaaaaaaa2`
const QUOTED = `at://${OTHER}/app.bsky.feed.post/3mlbbbbbbbbb2`
const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const mockLocal = new Map<string, string>()
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: (key: string) => mockLocal.get(key),
  writeLocal: (key: string, value: string | undefined) => {
    if (value === undefined) mockLocal.delete(key)
    else mockLocal.set(key, value)
  },
}))

const pdsClient = {} as never
let mockCurrentDid: string | undefined = VIEWER
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentClients: () =>
    mockCurrentDid ? {did: mockCurrentDid, pdsClient} : undefined,
  getCurrentPdsClient: () => pdsClient,
}))

type Label = {src: string; uri: string; val: string; cts: string}
const mockLabelCalls: string[][] = []
let mockLabels: Label[] = []
let mockLabelsDelayMs = 0
let mockLabelers: unknown[] = []
jest.mock('../api', () => ({
  LABELS_BATCH: 100,
  fetchMemberLabelers: () => Promise.resolve(mockLabelers),
  fetchMemberLabelerImage: () =>
    Promise.resolve({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      type: 'image/png',
    }),
  fetchMemberLabels: (_client: unknown, subjects: string[]) => {
    mockLabelCalls.push(subjects)
    const answer = mockLabels.filter(label => subjects.includes(label.uri))
    return mockLabelsDelayMs
      ? new Promise(resolve =>
          setTimeout(() => resolve(answer), mockLabelsDelayMs),
        )
      : Promise.resolve(answer)
  },
}))

const mockTokens: {aud: string; lxm: string}[] = []
jest.mock('#/lib/media/video/upload.shared', () => ({
  getServiceAuthToken: ({aud, lxm}: {aud: string; lxm: string}) => {
    mockTokens.push({aud, lxm})
    return Promise.resolve('member-token')
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

import {moderatePost, type ModerationOpts} from '@bsky/sdk/moderation'

import {
  fetchMemberLabelerImage,
  fetchMemberLabelers,
  fetchMemberLabels,
} from '../api'
import {guardRequest, MemberLabelerLeakError} from '../guard'
import {isMemberLabelerId} from '../ids'
import {
  connectMemberLabels,
  dropMemberLabels,
  findSubjects,
  LABELS_WAIT_MS,
  withMemberLabels,
} from '../labels'
import {withMemberLabelers} from '../moderation'
import {
  cairnServiceDid,
  createDirectReport,
  DirectReportError,
} from '../reports'
import {
  getMemberLabeler,
  getMemberLabelersSnapshot,
  hasMemberLabelers,
  loadMemberLabelers,
  refreshMemberLabelers,
  resetMemberLabelers,
} from '../store'

const NOW = '2026-11-16T00:00:00.000Z'

function author(did = OTHER) {
  return {did, handle: 'other.example.test', labels: []}
}

function postView(uri = POST, embed?: unknown) {
  return {
    uri,
    cid: CID,
    author: author(),
    record: {
      $type: 'app.bsky.feed.post',
      text: 'hello',
      createdAt: NOW,
      // Content that only looks like a view must not be labeled.
      fake: {did: OTHER, handle: 'x'},
    },
    ...(embed ? {embed} : {}),
    indexedAt: NOW,
    labels: [],
  }
}

function rawLabeler(did: string, kind: 'moderation' | 'labels_only') {
  return {
    did,
    kind,
    state: 'active',
    profile: {displayName: 'Test labeler', avatar: 'bafkreiavatar'},
    policies: {
      policies: {
        labelValues: ['ml-spoiler'],
        labelValueDefinitions: [
          {
            identifier: 'ml-spoiler',
            severity: 'alert',
            blurs: 'content',
            defaultSetting: 'hide',
            locales: [{lang: 'en', name: 'Spoiler', description: 'Spoilers'}],
          },
        ],
      },
      reasonTypes: ['com.atproto.moderation.defs#reasonSpam'],
    },
  }
}

const baseOpts: ModerationOpts = {
  userDid: VIEWER,
  prefs: {
    adultContentEnabled: false,
    labels: {},
    labelers: [],
    mutedWords: [],
    hiddenPosts: [],
  },
  labelDefs: {},
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  })
}

function agent(answer: () => Response) {
  const calls: string[] = []
  const inner = {
    did: VIEWER,
    fetchHandler: (path: string) => {
      calls.push(path)
      return Promise.resolve(answer())
    },
  }
  return {agent: withMemberLabels(inner as never), calls}
}

async function signInWithLabelers(raws: unknown[]) {
  mockLabelers = raws
  loadMemberLabelers(VIEWER)
  await refreshMemberLabelers(VIEWER, pdsClient, {
    fetchLabelers: fetchMemberLabelers,
    fetchImage: fetchMemberLabelerImage,
  })
}

beforeEach(() => {
  jest.useRealTimers()
  mockLocal.clear()
  mockLabelCalls.length = 0
  mockLabels = []
  mockLabelsDelayMs = 0
  mockTokens.length = 0
  mockCurrentDid = VIEWER
  resetMemberLabelers()
  dropMemberLabels()
  connectMemberLabels({
    hasLabelers: hasMemberLabelers,
    fetchLabels: (client, subjects) => fetchMemberLabels(client, subjects),
  })
})

describe('ids', () => {
  it('knows a member labeler by its shape, and nothing else', () => {
    expect(isMemberLabelerId(LABELER)).toBe(true)
    expect(isMemberLabelerId('did:web:cairn.example.test')).toBe(false)
    expect(isMemberLabelerId(OTHER)).toBe(false)
    expect(isMemberLabelerId(undefined)).toBe(false)
  })
})

describe('findSubjects', () => {
  it('finds posts, embedded records and accounts, never record content', () => {
    const quoted = {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: QUOTED,
      cid: CID,
      author: author(),
      value: {text: 'q', fake: {uri: POST, cid: CID, author: {}}},
      labels: [],
    }
    const found = findSubjects({
      feed: [
        {
          post: postView(POST, {
            $type: 'app.bsky.embed.record#view',
            record: quoted,
          }),
        },
      ],
    })
    expect([...found.keys()].sort()).toEqual([OTHER, POST, QUOTED].sort())
    // The author appears twice (post and quote); the record's fake once never.
    expect(found.get(OTHER)).toHaveLength(2)
  })
})

describe('labels on AppView answers', () => {
  it('adds a member labeler’s labels, and !hide then hides the post', async () => {
    await signInWithLabelers([rawLabeler(LABELER, 'moderation')])
    mockLabels = [{src: LABELER, uri: POST, val: '!hide', cts: NOW}]
    const {agent: wrapped} = agent(() => json({thread: {post: postView()}}))
    const response = await wrapped.fetchHandler(
      '/xrpc/app.bsky.feed.getPostThread?uri=x',
      {method: 'GET'},
    )
    const body = (await response.json()) as {thread: {post: {labels: Label[]}}}
    expect(body.thread.post.labels).toEqual([
      {src: LABELER, uri: POST, val: '!hide', cts: NOW},
    ])
    const decision = moderatePost(
      body.thread.post as never,
      withMemberLabelers(baseOpts, VIEWER, getMemberLabelersSnapshot()),
    )
    expect(decision.ui('contentList').filter).toBe(true)
    // Without the labeler in the options the same label does nothing.
    expect(
      moderatePost(body.thread.post as never, baseOpts).ui('contentList')
        .filter,
    ).toBe(false)
  })

  it('labels accounts by DID, and asks only once a minute per subject', async () => {
    await signInWithLabelers([rawLabeler(LABELER, 'moderation')])
    mockLabels = [{src: LABELER, uri: OTHER, val: 'ml-spoiler', cts: NOW}]
    const {agent: wrapped} = agent(() => json({profiles: [author()]}))
    for (let i = 0; i < 2; i++) {
      const response = await wrapped.fetchHandler(
        '/xrpc/app.bsky.actor.getProfiles?actors=x',
        {method: 'GET'},
      )
      const body = (await response.json()) as {profiles: {labels: Label[]}[]}
      expect(body.profiles[0].labels.map(label => label.val)).toEqual([
        'ml-spoiler',
      ])
    }
    expect(mockLabelCalls).toEqual([[OTHER]])
  })

  it('passes answers through untouched without labelers, or for writes', async () => {
    const {agent: wrapped} = agent(() => json({thread: {post: postView()}}))
    await wrapped.fetchHandler('/xrpc/app.bsky.feed.getPostThread', {
      method: 'GET',
    })
    expect(hasMemberLabelers(VIEWER)).toBe(false)
    await signInWithLabelers([rawLabeler(LABELER, 'moderation')])
    await wrapped.fetchHandler('/xrpc/com.atproto.repo.createRecord', {
      method: 'POST',
    })
    await wrapped.fetchHandler('/xrpc/app.bsky.feed.getPostThread', {
      method: 'POST',
    })
    expect(mockLabelCalls).toEqual([])
  })

  it('never labels another account’s reads', async () => {
    await signInWithLabelers([rawLabeler(LABELER, 'moderation')])
    mockCurrentDid = OTHER
    const {agent: wrapped} = agent(() => json({thread: {post: postView()}}))
    await wrapped.fetchHandler('/xrpc/app.bsky.feed.getPostThread', {
      method: 'GET',
    })
    expect(mockLabelCalls).toEqual([])
  })

  it('stops waiting after a while and lets the answer through', async () => {
    await signInWithLabelers([rawLabeler(LABELER, 'moderation')])
    mockLabels = [{src: LABELER, uri: POST, val: '!hide', cts: NOW}]
    mockLabelsDelayMs = LABELS_WAIT_MS + 1_000
    const {agent: wrapped} = agent(() => json({thread: {post: postView()}}))
    const started = Date.now()
    const response = await wrapped.fetchHandler(
      '/xrpc/app.bsky.feed.getPostThread',
      {method: 'GET'},
    )
    expect(Date.now() - started).toBeLessThan(LABELS_WAIT_MS + 900)
    const body = (await response.json()) as {thread: {post: {labels: Label[]}}}
    expect(body.thread.post.labels).toEqual([])
  }, 10_000)
})

describe('labelers', () => {
  it('a labels-only labeler never hides or blurs', async () => {
    await signInWithLabelers([
      rawLabeler(LABELER, 'moderation'),
      rawLabeler(LABELS_ONLY, 'labels_only'),
    ])
    expect(getMemberLabeler(LABELER)?.defs[0].defaultSetting).toBe('hide')
    const labelsOnly = getMemberLabeler(LABELS_ONLY)!
    expect(labelsOnly.defs[0].blurs).toBe('none')
    expect(labelsOnly.defs[0].defaultSetting).toBe('warn')
    // The built view names no account, and the avatar stays on the device.
    expect(labelsOnly.view.creator.handle).toBe('handle.invalid')
    expect(labelsOnly.avatar).toMatch(/^data:image\/png;base64,/)
  })

  it('member labelers join the moderation options of their own account only', async () => {
    await signInWithLabelers([rawLabeler(LABELER, 'moderation')])
    const snapshot = getMemberLabelersSnapshot()
    const opts = withMemberLabelers(baseOpts, VIEWER, snapshot)
    expect(opts.prefs.labelers.map(entry => entry.did)).toEqual([LABELER])
    expect(opts.labelDefs?.[LABELER]).toHaveLength(1)
    expect(withMemberLabelers(baseOpts, OTHER, snapshot)).toBe(baseOpts)
  })
})

describe('guard', () => {
  it('refuses a URL or proxy that names a member labeler', () => {
    expect(() =>
      guardRequest(
        `/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(LABELER)}`,
      ),
    ).toThrow(MemberLabelerLeakError)
    expect(() =>
      guardRequest('/xrpc/com.atproto.moderation.createReport', {
        headers: {'atproto-proxy': `${LABELER}#atproto_labeler`},
      }),
    ).toThrow(MemberLabelerLeakError)
  })

  it('takes member labelers out of the accepted labelers, keeping the rest', () => {
    const init = guardRequest('/xrpc/app.bsky.feed.getTimeline', {
      headers: {
        'atproto-accept-labelers': `did:plc:ar7c4by46qjdydhdevvrndac;redact, ${LABELER}`,
      },
    })
    expect(new Headers(init.headers).get('atproto-accept-labelers')).toBe(
      'did:plc:ar7c4by46qjdydhdevvrndac;redact',
    )
  })

  it('lets ordinary requests through as they are', () => {
    const init = {
      headers: {'atproto-proxy': 'did:web:api.bsky.app#bsky_appview'},
    }
    expect(
      guardRequest(`/xrpc/app.bsky.actor.getProfile?actor=${OTHER}`, init),
    ).toBe(init)
  })
})

describe('reports', () => {
  it('go straight to cairn, with the member’s token and no credentials', async () => {
    const sent: {url: string; init: RequestInit}[] = []
    const fetchImpl = ((url: string, init: RequestInit) => {
      sent.push({url, init})
      return Promise.resolve(json({id: 7}))
    }) as unknown as typeof fetch
    await createDirectReport(
      pdsClient,
      {
        labeler: LABELER,
        subject: {$type: 'com.atproto.repo.strongRef', uri: POST, cid: CID},
        reasonType: 'com.atproto.moderation.defs#reasonSpam',
      },
      {fetchImpl},
    )
    expect(cairnServiceDid()).toBe('did:web:cairn.example.test')
    expect(mockTokens).toEqual([
      {
        aud: 'did:web:cairn.example.test',
        lxm: 'tools.cairn.report.createDirectReport',
      },
    ])
    expect(sent[0].url).toBe(
      'https://cairn.example.test/direct/xrpc/tools.cairn.report.createDirectReport',
    )
    expect(sent[0].url).not.toContain('labeler:')
    expect(sent[0].init.credentials).toBe('omit')
    const sentBody = JSON.parse(sent[0].init.body as string) as {
      labeler: string
    }
    expect(sentBody.labeler).toBe(LABELER)
  })

  it('tell “not available” apart from “try again”', async () => {
    const answer = (status: number, error: string) =>
      (() =>
        Promise.resolve(
          new Response(JSON.stringify({error}), {status}),
        )) as unknown as typeof fetch
    const input = {
      labeler: LABELER,
      subject: {$type: 'com.atproto.admin.defs#repoRef' as const, did: OTHER},
      reasonType: 'com.atproto.moderation.defs#reasonSpam',
    }
    const refused = await createDirectReport(pdsClient, input, {
      fetchImpl: answer(400, 'InvalidRequest'),
    }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(DirectReportError)
    expect((refused as DirectReportError).notAvailable).toBe(true)
    expect((refused as DirectReportError).retryable).toBe(false)
    const busy = await createDirectReport(pdsClient, input, {
      fetchImpl: answer(503, 'MembershipUnavailable'),
    }).catch((e: unknown) => e)
    expect((busy as DirectReportError).retryable).toBe(true)
  })
})
