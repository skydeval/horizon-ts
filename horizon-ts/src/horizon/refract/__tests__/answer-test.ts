import {describe, expect, it} from '@jest/globals'

import {
  hasBlockFlag,
  type ReadContext,
  readFillAnswer,
} from '#/horizon/refract/answer'
import {
  RF_DID,
  RF_DID_2,
  rfFillAnswer,
  rfPost,
  rfProfile,
  rfUri,
} from '#/horizon/refract/fixtures'

/*
 * 11.1 "omissions": each row of 5.2's tables, in both modes.
 */

function ctx(partial: Partial<ReadContext> = {}): ReadContext {
  return {
    form: 'member',
    proxied: false,
    noted: () => false,
    seenPending: () => false,
    confirming: new Set(),
    authorCache: () => undefined,
    ownBlock: () => false,
    ...partial,
  }
}

const URI = rfUri('rf1')

function didKind(body: object, c: ReadContext = ctx(), did = RF_DID) {
  return readFillAnswer(body, {dids: [did], uris: []}, c).dids.get(did)?.kind
}

function uriKind(body: object, c: ReadContext = ctx()) {
  const verdict = readFillAnswer(
    body,
    {dids: [RF_DID], uris: [URI]},
    c,
  ).uris.get(URI)
  return verdict?.kind === 'author' ? `author:${verdict.author}` : verdict?.kind
}

describe('DID rows', () => {
  it('in profiles is positive, in pending is pending, in both modes', () => {
    for (const withheld of [undefined, []]) {
      expect(didKind(rfFillAnswer({profiles: [rfProfile()], withheld}))).toBe(
        'positive',
      )
      expect(didKind(rfFillAnswer({pending: [RF_DID], withheld}))).toBe(
        'pending',
      )
    }
  })

  it('withheld discovery reasons are unresolved; unavailable and unknown are transient', () => {
    for (const reason of ['unanswered', 'capped', 'proxied']) {
      expect(didKind(rfFillAnswer({withheld: [{id: RF_DID, reason}]}))).toBe(
        'unresolved',
      )
    }
    for (const reason of ['unavailable', 'somethingNew']) {
      expect(didKind(rfFillAnswer({withheld: [{id: RF_DID, reason}]}))).toBe(
        'unavailable',
      )
    }
  })

  it('full rules: an omission is not restored, for visitors too', () => {
    expect(didKind(rfFillAnswer({withheld: []}))).toBe('not-restored')
    expect(didKind(rfFillAnswer({withheld: []}), ctx({form: 'visitor'}))).toBe(
      'not-restored',
    )
  })

  it('interim rules: only a member direct omission is definitive', () => {
    expect(didKind(rfFillAnswer())).toBe('not-restored')
    expect(didKind(rfFillAnswer(), ctx({form: 'visitor'}))).toBe('unresolved')
    expect(didKind(rfFillAnswer(), ctx({proxied: true}))).toBe('unresolved')
    expect(
      didKind(rfFillAnswer(), ctx({form: 'visitor', noted: () => true})),
    ).toBe('indefinite')
  })

  it('an omission after the seen-pending mark needs a confirming answer', () => {
    const marked = ctx({seenPending: () => true})
    expect(didKind(rfFillAnswer({withheld: []}), marked)).toBe('confirm')
    expect(
      didKind(
        rfFillAnswer({withheld: []}),
        ctx({seenPending: () => true, confirming: new Set([RF_DID])}),
      ),
    ).toBe('not-restored')
  })

  it('a noted DID omitted twice has ended; once is not enough', () => {
    const noted = ctx({noted: () => true})
    expect(didKind(rfFillAnswer({withheld: []}), noted)).toBe('confirm')
    expect(
      didKind(
        rfFillAnswer({withheld: []}),
        ctx({noted: () => true, confirming: new Set([RF_DID])}),
      ),
    ).toBe('ended')
    // Interim, member direct: the same two-omission rule.
    expect(didKind(rfFillAnswer(), noted)).toBe('confirm')
  })
})

describe('URI rows, in their order', () => {
  it('a returned post is positive, even when its author is unavailable', () => {
    expect(
      uriKind(
        rfFillAnswer({
          posts: [rfPost('rf1')],
          withheld: [{id: RF_DID, reason: 'unavailable'}],
        }),
      ),
    ).toBe('positive')
  })

  it('withheld blocked, an author block flag or the own block set is blocked', () => {
    expect(
      uriKind(rfFillAnswer({withheld: [{id: URI, reason: 'blocked'}]})),
    ).toBe('blocked')
    expect(
      uriKind(
        rfFillAnswer({
          profiles: [rfProfile(RF_DID, {viewer: {blockedBy: true}})],
          withheld: [{id: URI, reason: 'unavailable'}],
        }),
      ),
    ).toBe('blocked')
    expect(
      uriKind(rfFillAnswer({withheld: []}), ctx({ownBlock: () => true})),
    ).toBe('blocked')
  })

  it('blockedBy false is not a block flag', () => {
    expect(hasBlockFlag(rfProfile(RF_DID, {viewer: {blockedBy: false}}))).toBe(
      false,
    )
    expect(
      uriKind(
        rfFillAnswer({
          profiles: [rfProfile(RF_DID, {viewer: {blockedBy: false}})],
          withheld: [],
        }),
      ),
    ).toBe('missing')
  })

  it('a capped author’s URIs take capped; unavailable URIs are transient', () => {
    expect(
      uriKind(rfFillAnswer({withheld: [{id: URI, reason: 'capped'}]})),
    ).toBe('unresolved')
    expect(
      uriKind(rfFillAnswer({withheld: [{id: URI, reason: 'unavailable'}]})),
    ).toBe('unavailable')
  })

  it('a URI whose author is pending is pending, never missing', () => {
    expect(uriKind(rfFillAnswer({pending: [RF_DID], withheld: []}))).toBe(
      'author:pending',
    )
    expect(
      uriKind(rfFillAnswer({withheld: []}), ctx({seenPending: () => true})),
    ).toBe('author:confirm')
  })

  it('an author not restored or stock-served gives gone ("Deleted")', () => {
    expect(uriKind(rfFillAnswer({withheld: []}))).toBe('gone')
    const skipped = readFillAnswer(
      rfFillAnswer({withheld: []}),
      {dids: [], uris: [URI]},
      ctx({authorCache: () => 'stock-served'}),
    )
    expect(skipped.uris.get(URI)?.kind).toBe('gone')
  })

  it('missing needs the author positive in the same answer, and a definitive answer', () => {
    const answer = rfFillAnswer({profiles: [rfProfile()]})
    expect(uriKind(answer)).toBe('missing')
    expect(uriKind(answer, ctx({form: 'visitor'}))).toBe('unavailable')
    expect(uriKind({...answer, withheld: []}, ctx({form: 'visitor'}))).toBe(
      'missing',
    )
  })

  it('reads several DIDs independently', () => {
    const read = readFillAnswer(
      rfFillAnswer({
        profiles: [rfProfile()],
        pending: [RF_DID_2],
        withheld: [],
      }),
      {dids: [RF_DID, RF_DID_2], uris: []},
      ctx(),
    )
    expect(read.dids.get(RF_DID)?.kind).toBe('positive')
    expect(read.dids.get(RF_DID_2)?.kind).toBe('pending')
    expect(read.mode).toBe('full')
  })
})
