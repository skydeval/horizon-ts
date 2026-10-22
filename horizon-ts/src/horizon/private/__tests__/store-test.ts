import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'

import {postAudienceLabel} from '../api/audiences'
import {
  addPendingPost,
  applyPrivatePostAudience,
  AUDIENCE_PIN_MS,
  clearPrivateStores,
  getPendingPost,
  getPrivatePostFacts,
  PENDING_TTL_MS,
  pendingPhase,
  pinPrivatePostAudience,
  setPrivatePostFacts,
} from '../store'
import {DID, OTHER_DID, privateUri, RECORD_CID} from './fixtures'

const AUD = 'tools.kryphocron.policy.audience'
const OLD = `at://${DID}/${AUD}/3kold2222222`
const NEW = `at://${DID}/${AUD}/3knew2222222`
const THEIRS = `at://${OTHER_DID}/${AUD}/3ktheirs22222`
const POST = privateUri('3kpost222222')

beforeEach(() => {
  i18n.loadAndActivate({locale: 'en', messages: {}})
  clearPrivateStores()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('the audience pin (2H design 5.7, T7)', () => {
  it('an audience change pins the new audience against a stale served view', () => {
    setPrivatePostFacts(POST, {
      audienceUri: OLD,
      isPending: false,
      servedAudience: {uri: OLD, mode: 'list'},
    })
    applyPrivatePostAudience(POST, NEW, RECORD_CID)
    expect(getPrivatePostFacts(POST)).toMatchObject({
      audienceUri: NEW,
      audiencePin: {uri: NEW},
    })
    expect(getPrivatePostFacts(POST)?.servedAudience).toBeUndefined()

    // A stale view (the record still names the old audience).
    setPrivatePostFacts(POST, {
      audienceUri: OLD,
      isPending: false,
      countsServed: true,
      servedAudience: {uri: OLD, mode: 'list'},
    })
    const facts = getPrivatePostFacts(POST)
    expect(facts?.audienceUri).toBe(NEW)
    expect(facts?.servedAudience).toBeUndefined()
    expect(facts?.countsServed).toBe(true)
    expect(facts?.audiencePin?.uri).toBe(NEW)
  })

  it('a view whose record names the pinned audience clears the pin', () => {
    applyPrivatePostAudience(POST, NEW, RECORD_CID)
    setPrivatePostFacts(POST, {
      audienceUri: NEW,
      isPending: false,
      servedAudience: {uri: NEW, mode: 'list', name: 'Close'},
    })
    expect(getPrivatePostFacts(POST)).toEqual({
      audienceUri: NEW,
      isPending: false,
      servedAudience: {uri: NEW, mode: 'list', name: 'Close'},
    })
  })

  it('expires after a minute', () => {
    jest.useFakeTimers({now: Date.UTC(2026, 9, 18)})
    applyPrivatePostAudience(POST, NEW, RECORD_CID)
    jest.setSystemTime(Date.UTC(2026, 9, 18) + AUDIENCE_PIN_MS + 1)
    setPrivatePostFacts(POST, {audienceUri: OLD, isPending: false})
    expect(getPrivatePostFacts(POST)).toEqual({
      audienceUri: OLD,
      isPending: false,
    })
  })

  it('pinPrivatePostAudience (the composer anchor) drops a stale served audience', () => {
    setPrivatePostFacts(POST, {
      audienceUri: OLD,
      isPending: false,
      servedAudience: {uri: OLD},
    })
    pinPrivatePostAudience(POST, NEW)
    expect(getPrivatePostFacts(POST)?.audienceUri).toBe(NEW)
    expect(getPrivatePostFacts(POST)?.servedAudience).toBeUndefined()
  })

  it('facts without the new fields equal the plain ones', () => {
    setPrivatePostFacts(POST, {audienceUri: OLD, isPending: false})
    expect(getPrivatePostFacts(POST)).toEqual({
      audienceUri: OLD,
      isPending: false,
    })
  })
})

describe('postAudienceLabel order (2H design 5.6, T7)', () => {
  const base = {
    currentDid: DID,
    ownAudiences: [
      {uri: NEW, rkey: '3knew2222222', mode: 'list', name: 'Mine', members: []},
    ],
    record: undefined,
    ownerHandle: 'them.test',
  }

  it('the own audience comes from the account list', () => {
    expect(postAudienceLabel({...base, audienceUri: NEW})).toBe('Mine')
  })

  it("another account's named or relational served audience needs no record", () => {
    expect(
      postAudienceLabel({
        ...base,
        audienceUri: THEIRS,
        served: {uri: THEIRS, mode: 'list', name: 'Their friends'},
      }),
    ).toBe('Their friends')
    expect(
      postAudienceLabel({
        ...base,
        audienceUri: THEIRS,
        served: {uri: THEIRS, mode: 'followers'},
      }),
    ).toBe('Followers of @them.test')
    expect(
      postAudienceLabel({
        ...base,
        audienceUri: THEIRS,
        served: {uri: THEIRS, mode: 'everyone'},
      }),
    ).toBe('Horizon members')
  })

  it('an unnamed served list, or no served audience, waits for the record', () => {
    expect(
      postAudienceLabel({
        ...base,
        audienceUri: THEIRS,
        served: {uri: THEIRS, mode: 'list'},
      }),
    ).toBeUndefined()
    expect(
      postAudienceLabel({
        ...base,
        audienceUri: THEIRS,
        served: {uri: THEIRS},
      }),
    ).toBeUndefined()
    expect(
      postAudienceLabel({
        ...base,
        audienceUri: THEIRS,
        record: {
          uri: THEIRS,
          rkey: '3ktheirs22222',
          mode: 'list',
          members: ['a', 'b'],
        },
      }),
    ).toBe('2 people')
  })
})

describe('pending phases (2K design PA-28 step 3, T-23)', () => {
  function entry(uri: string, phase: 'sending' | 'written' | 'failed') {
    return {
      uri,
      cid: phase === 'written' ? RECORD_CID : '',
      did: DID,
      record: {
        $type: 'tools.kryphocron.feed.postPrivate',
        text: 'x',
        createdAt: '2026-10-22T00:00:00.000Z',
      } as never,
      postView: {} as never,
      feedItem: {} as never,
      createdAt: '2026-10-22T00:00:00.000Z',
      expiresAt:
        phase === 'written'
          ? Date.now() + PENDING_TTL_MS
          : Number.POSITIVE_INFINITY,
      phase,
    }
  }

  it('sending and failed entries survive 11 minutes; a written one lapses after PENDING_TTL_MS', () => {
    const start = Date.now()
    const now = jest.spyOn(Date, 'now')
    now.mockReturnValue(start)
    addPendingPost(entry(privateUri('3ksending222'), 'sending'))
    addPendingPost(entry(privateUri('3kfailed2222'), 'failed'))
    addPendingPost(entry(privateUri('3kwritten222'), 'written'))
    now.mockReturnValue(start + 11 * 60_000)
    expect(getPendingPost(privateUri('3ksending222'), DID)).toBeDefined()
    expect(getPendingPost(privateUri('3kfailed2222'), DID)).toBeDefined()
    expect(getPendingPost(privateUri('3kwritten222'), DID)).toBeUndefined()
  })

  it('getPendingPost takes the entry’s DID and answers every phase', () => {
    addPendingPost(entry(privateUri('3ksending333'), 'sending'))
    const found = getPendingPost(privateUri('3ksending333'), DID)
    expect(found && pendingPhase(found)).toBe('sending')
    expect(
      getPendingPost(privateUri('3ksending333'), OTHER_DID),
    ).toBeUndefined()
  })
})
