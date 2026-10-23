import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * 11.1 "C-8" (refract client design 6, RF-B9): skydeval's 2026-10-23
 * decision, "show community labels to everyone who is a horizon member".
 * A member's restored view is moderated with its marker's labeler added for
 * that view only, subscribed or not; a non-member keeps stock behaviour; a
 * reader who subscribes gets nothing added; the definitions pending means
 * no hold. Synthetic fixtures only; the AppView is a fake.
 */

let mockMembership = 'member'
let mockLabelerSwitch = true
const mockCall = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock('#/horizon/switches', () => {
  // A live getter: a spread would read the switch once, at load.
  const switches = {
    ...jest.requireActual<object>('#/horizon/switches'),
    REFRACT: true,
  }
  Object.defineProperty(switches, 'REFRACT_COMMUNITY_LABELER', {
    get: () => mockLabelerSwitch,
  })
  return switches
})
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => mockMembership,
  subscribeMembership: () => () => {},
}))
jest.mock('#/horizon/routing/current-clients', () => ({
  getCurrentDid: () => 'did:plc:rfxreader000000000000000001',
  getCurrentAppviewClient: () => ({call: mockCall}),
}))

import {moderatePost, type ModerationOpts} from '@bsky/sdk/moderation'

import {RF_LABELER, RF_READER_DID, rfPost} from '#/horizon/refract/fixtures'
import {
  communityLabelerVersion,
  communityLabelInfo,
  resetCommunityLabeler,
  restoredModerationOpts,
} from '#/horizon/refract/labeler'

const LABEL = 'rfx-spoiler'

function labelerView() {
  return {
    uri: `at://${RF_LABELER}/app.bsky.labeler.service/self`,
    cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    creator: {did: RF_LABELER, handle: 'labeler.example.test'},
    policies: {
      labelValues: [LABEL],
      labelValueDefinitions: [
        {
          identifier: LABEL,
          severity: 'alert',
          blurs: 'content',
          defaultSetting: 'warn',
          locales: [{lang: 'en', name: 'Spoiler', description: 'Synthetic'}],
        },
      ],
    },
    indexedAt: '2026-10-23T10:00:00.000Z',
  }
}

function opts(labelers: {did: string}[] = []): ModerationOpts {
  return {
    userDid: RF_READER_DID,
    prefs: {
      adultContentEnabled: false,
      labels: {},
      labelers: labelers.map(({did}) => ({did, labels: {}})),
      mutedWords: [],
      hiddenPosts: [],
    },
    labelDefs: {},
  } as unknown as ModerationOpts
}

function labelled({restored = true}: {restored?: boolean} = {}) {
  const post = rfPost('labelled', {restored})
  post.labels = [
    {
      src: RF_LABELER,
      uri: post.uri,
      val: LABEL,
      cts: '2026-10-23T10:00:00.000Z',
    },
  ]
  return post
}

function blurred(post: object, moderation: ModerationOpts) {
  return moderatePost(post as never, moderation).ui('contentList').blur
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  mockMembership = 'member'
  mockLabelerSwitch = true
  mockCall.mockReset()
  mockCall.mockResolvedValue({views: [labelerView()]})
  resetCommunityLabeler()
})

describe('restoredModerationOpts (C-8)', () => {
  it('is stock until the definitions arrive, never held, then adds the labeler for a member', async () => {
    const base = opts()
    const post = labelled()
    // Pending: moderated as stock would, and the definitions asked once.
    expect(restoredModerationOpts(base, post)).toBe(base)
    expect(restoredModerationOpts(base, post)).toBe(base)
    const before = communityLabelerVersion()
    await flush()
    expect(mockCall).toHaveBeenCalledTimes(1)
    expect(mockCall.mock.calls[0][1]).toEqual({
      dids: [RF_LABELER],
      detailed: true,
    })
    expect(communityLabelerVersion()).not.toBe(before)

    const extended = restoredModerationOpts(base, post)
    expect(extended).not.toBe(base)
    expect(extended.prefs.labelers).toEqual([{did: RF_LABELER, labels: {}}])
    expect(extended.labelDefs?.[RF_LABELER]?.[0]?.identifier).toBe(LABEL)
    // The same object for the same options and labeler.
    expect(restoredModerationOpts(base, post)).toBe(extended)
    // The labeler's label now counts, for that view only.
    expect(blurred(post, base)).toBe(false)
    expect(blurred(post, extended)).toBe(true)
    // Within the hour nothing is asked again.
    await flush()
    expect(mockCall).toHaveBeenCalledTimes(1)
    expect(communityLabelInfo().labelers).toHaveLength(1)
  })

  it('adds nothing for a view without a marker or without a labeler', async () => {
    const base = opts()
    restoredModerationOpts(base, labelled())
    await flush()
    expect(restoredModerationOpts(base, labelled({restored: false}))).toBe(base)
    const noLabeler = labelled()
    noLabeler.restored = {community: 'rfxcommunity', tier: 1}
    expect(restoredModerationOpts(base, noLabeler)).toBe(base)
  })

  it('adds nothing when the reader already subscribes', async () => {
    const base = opts([{did: RF_LABELER}])
    expect(restoredModerationOpts(base, labelled())).toBe(base)
    await flush()
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('keeps stock behaviour for a non-member: labels only for subscribers', async () => {
    mockMembership = 'not-member'
    const base = opts()
    const post = labelled()
    expect(restoredModerationOpts(base, post)).toBe(base)
    await flush()
    expect(mockCall).not.toHaveBeenCalled()
    expect(blurred(post, base)).toBe(false)
    expect(communityLabelInfo().labelers).toHaveLength(0)
    // A subscriber sees the label through stock moderation.
    const subscribed = {
      ...opts([{did: RF_LABELER}]),
      labelDefs: {
        [RF_LABELER]: [
          {
            identifier: LABEL,
            configurable: true,
            defaultSetting: 'warn',
            flags: [],
            severity: 'alert',
            blurs: 'content',
            behaviors: {
              account: {},
              profile: {},
              content: {contentList: 'blur', contentView: 'blur'},
            },
            locales: [],
            definedBy: RF_LABELER,
          },
        ],
      },
    } as unknown as ModerationOpts
    expect(blurred(post, subscribed)).toBe(true)
  })

  it('an indexing account is not a member yet', async () => {
    mockMembership = 'indexing'
    expect(restoredModerationOpts(opts(), labelled())).toEqual(opts())
    await flush()
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('is stock for everyone with the switch off', async () => {
    mockLabelerSwitch = false
    const base = opts()
    expect(restoredModerationOpts(base, labelled())).toBe(base)
    await flush()
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('a failed definitions fetch leaves stock moderation and is not retried at once', async () => {
    mockCall.mockRejectedValue(new Error('offline'))
    const base = opts()
    expect(restoredModerationOpts(base, labelled())).toBe(base)
    await flush()
    expect(restoredModerationOpts(base, labelled())).toBe(base)
    await flush()
    expect(mockCall).toHaveBeenCalledTimes(1)
  })

  it('passes undefined options through', () => {
    expect(restoredModerationOpts(undefined, labelled())).toBeUndefined()
  })
})
