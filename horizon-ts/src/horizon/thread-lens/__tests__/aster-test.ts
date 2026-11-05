import {beforeEach, describe, expect, it} from '@jest/globals'

import {restoredActionsHidden} from '#/horizon/refract/visitor'
import {
  answerAster,
  clearAster,
  getAsterLabels,
  resetAster,
} from '#/horizon/routing/aster'
import {
  asterOutcome,
  asterQuoteRecord,
  isAsterView,
  offersAster,
  offersAsterQuote,
} from '#/horizon/thread-lens/aster'

/*
 * Aster nodes: the grant from getMembership (in memory, both flag and
 * labels), the placeholder kinds that offer the action, and the read-only
 * stamped copy of prism's view. Synthetic fixtures only.
 */

const DID = 'did:plc:astreader000000000000001'
const AUTHOR = 'did:plc:astauthor000000000000001'
const URI = `at://${AUTHOR}/app.bsky.feed.post/3kastpost2222`
const LABELS = {action: 'L1', undo: 'L2', marker: 'L3'}

function postView() {
  return {
    uri: URI,
    cid: 'bafyreieeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    author: {did: AUTHOR, handle: 'author.example.test', viewer: {}},
    record: {
      $type: 'app.bsky.feed.post',
      text: 'synthetic',
      createdAt: '2026-11-04T10:00:00.000Z',
    },
    indexedAt: '2026-11-04T10:00:00.000Z',
    viewer: {},
  }
}

beforeEach(() => resetAster())

describe('the aster grant', () => {
  it('holds only with permissions.aster true and all three labels', () => {
    answerAster(DID, {aster: true}, {labels: LABELS})
    expect(getAsterLabels(DID)).toEqual({
      action: 'L1',
      undo: 'L2',
      marker: 'L3',
    })
    answerAster(DID, {aster: true}, {labels: {...LABELS, undo: ''}})
    expect(getAsterLabels(DID)).toBeUndefined()
    answerAster(DID, {aster: 'yes'}, {labels: LABELS})
    expect(getAsterLabels(DID)).toBeUndefined()
    answerAster(DID, {}, {labels: LABELS})
    expect(getAsterLabels(DID)).toBeUndefined()
    answerAster(DID, undefined, undefined)
    expect(getAsterLabels(DID)).toBeUndefined()
  })

  it('is per account, and a refused call clears it', () => {
    answerAster(DID, {aster: true}, {labels: LABELS})
    expect(getAsterLabels('did:plc:other00000000000000000001')).toBeUndefined()
    clearAster(DID)
    expect(getAsterLabels(DID)).toBeUndefined()
  })
})

describe('offersAster', () => {
  it('offers on the listed placeholder kinds only, never on a kryphocron URI', () => {
    for (const kind of [
      'blocked-by-you',
      'blocking-you',
      'blocked',
      'block-state-unknown',
    ]) {
      expect(offersAster(URI, kind)).toBe(true)
    }
    for (const kind of [
      'deleted',
      'not-found',
      'tier-hidden',
      'content-stripped',
      'upstream-unavailable',
      'unverified',
      'gap-below',
    ]) {
      expect(offersAster(URI, kind)).toBe(false)
    }
    const kryphocron = `at://${AUTHOR}/tools.kryphocron.feed.postPrivate/3kastpost2222`
    expect(offersAster(kryphocron, 'blocked-by-you')).toBe(false)
  })
})

describe('asterOutcome', () => {
  it('makes a stamped read-only copy of prism’s post view', () => {
    const view = postView()
    const outcome = asterOutcome({uri: URI, post: view}, URI)
    expect(outcome.kind).toBe('post')
    if (outcome.kind !== 'post') return
    expect(outcome.view).not.toBe(view)
    expect(outcome.view.viewer).toEqual({
      replyDisabled: true,
      embeddingDisabled: true,
    })
    expect(isAsterView(outcome.view)).toBe(true)
    expect(isAsterView(view)).toBe(false)
    // Like, repost, quote and follow are hidden, and their queues refuse it.
    expect(restoredActionsHidden(outcome.view)).toBe(true)
    expect(restoredActionsHidden(view)).toBe(false)
  })

  it('reads a gap node’s kind, and refuses another post or a malformed node', () => {
    expect(asterOutcome({uri: URI, gap: 'not-found'}, URI)).toEqual({
      kind: 'gap',
      gap: 'not-found',
    })
    const other = `at://${AUTHOR}/app.bsky.feed.post/3kastother222`
    expect(
      asterOutcome({uri: other, post: {...postView(), uri: other}}, URI),
    ).toEqual({kind: 'none'})
    expect(asterOutcome(undefined, URI)).toEqual({kind: 'none'})
    expect(asterOutcome({uri: URI, post: {uri: URI}}, URI)).toEqual({
      kind: 'none',
    })
  })
})

describe('aster on blocked quote cards', () => {
  it('offers on a post’s card only, never a feed, list or kryphocron one', () => {
    expect(offersAsterQuote(URI)).toBe(true)
    expect(
      offersAsterQuote(`at://${AUTHOR}/app.bsky.feed.generator/feedname`),
    ).toBe(false)
    expect(offersAsterQuote(`at://${AUTHOR}/app.bsky.graph.list/3klist`)).toBe(
      false,
    )
    expect(
      offersAsterQuote(
        `at://${AUTHOR}/tools.kryphocron.feed.postPrivate/3kastpost2222`,
      ),
    ).toBe(false)
  })

  it('draws the aster node as a stamped quoted record', () => {
    const outcome = asterOutcome({uri: URI, post: postView()}, URI)
    if (outcome.kind !== 'post') throw new Error('expected a post')
    const record = asterQuoteRecord(outcome.view)
    expect(record).toMatchObject({
      $type: 'app.bsky.embed.record#viewRecord',
      uri: URI,
      value: {text: 'synthetic'},
      embeds: [],
    })
    expect(isAsterView(record)).toBe(true)
  })
})
