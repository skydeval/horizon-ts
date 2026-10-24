import {describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 13, the pure parts of 5A: parsers, format, the fronters
 * field, the display rule, the three pronoun states, the batcher's caps,
 * the 429 wait and the committed development constant.
 */

// The modules under test reach the session through prism's clients.
jest.mock('#/state/session', () => ({useMaybePdsClient: () => null}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))

import {IDENTITY_PDS_FALLBACK_DIDS} from '#/horizon/identity/config'
import {
  formatFronterNames,
  formatFrontState,
  formatMemberLabel,
  formatPronouns,
  formatSet,
  formatSets,
} from '#/horizon/identity/format'
import {
  MAX_FRONTERS,
  readFronters,
  withFronters,
} from '#/horizon/identity/fronters'
import {pronounsFromAnswer, resolvePostFronters} from '#/horizon/identity/hooks'
import {
  isEngaging,
  parseBlob,
  parseFront,
  parseMember,
  parsePronouns,
  parseSystem,
  type PluralMember,
} from '#/horizon/identity/parse'
import {
  identityRateLimitWaitMs,
  memberUri,
  planIdentityCalls,
} from '#/horizon/identity/reads'
import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'
import {
  AUTHOR,
  FRONT,
  MEMBER,
  PRONOUNS,
  records,
  SPARROW,
  SYSTEM,
  WREN,
} from './harness'

const MIDDOT = '·'

describe('parsers', () => {
  it('parse each record with keys Horizon does not know, kept in raw', () => {
    const pronouns = parsePronouns(
      records.pronouns([['she', 'her']], {futureKey: 1}),
    )
    expect(pronouns?.sets).toEqual([['she', 'her']])
    expect(pronouns?.raw.futureKey).toBe(1)
    expect(parseSystem(records.system({futureKey: 2}))?.raw.futureKey).toBe(2)
    expect(
      parseMember(records.member('Wren', {futureKey: 3}))?.raw.futureKey,
    ).toBe(3)
    expect(
      parseFront(records.front([WREN], {futureKey: 4}))?.raw.futureKey,
    ).toBe(4)
  })

  it('refuse a record of another collection', () => {
    expect(
      parsePronouns({...records.pronouns([['she']]), $type: SYSTEM}),
    ).toBeNull()
    expect(parseSystem({$type: MEMBER})).toBeNull()
    expect(parseMember({...records.member('Wren'), $type: FRONT})).toBeNull()
    expect(parseFront({...records.front([]), $type: PRONOUNS})).toBeNull()
  })

  it('read a pronouns record without displayMode, or with an unknown one, as all', () => {
    expect(parsePronouns(records.pronouns([['she']]))?.displayMode).toBe('all')
    expect(
      parsePronouns(records.pronouns([['she']], {displayMode: 'secondOnly'}))
        ?.displayMode,
    ).toBe('all')
    expect(
      parsePronouns(records.pronouns([['she']], {displayMode: 'firstOnly'}))
        ?.displayMode,
    ).toBe('firstOnly')
  })

  it('refuse over-limit display fields', () => {
    // A 25-grapheme form, a form over 240 bytes (10 graphemes of 25 bytes
    // each), 13 forms, 11 sets: refused, never cut.
    expect(parsePronouns(records.pronouns([['a'.repeat(25)]]))).toBeNull()
    expect(parsePronouns(records.pronouns([['👩‍👩‍👧‍👦'.repeat(10)]]))).toBeNull()
    // 22 graphemes of 3 bytes each (66 bytes) fit since the limit was raised.
    expect(parsePronouns(records.pronouns([['€'.repeat(22)]]))).not.toBeNull()
    expect(
      parsePronouns(records.pronouns([Array.from({length: 13}, () => 'x')])),
    ).toBeNull()
    expect(
      parsePronouns(records.pronouns(Array.from({length: 11}, () => ['x']))),
    ).toBeNull()
    expect(parsePronouns(records.pronouns([[]]))).toBeNull()
    // A member's name over 64 graphemes, or blank, refuses the member.
    expect(parseMember(records.member('n'.repeat(65)))).toBeNull()
    expect(parseMember(records.member('  '))).toBeNull()
    // Optional fields over their limits are dropped.
    const member = parseMember(
      records.member('Wren', {
        description: 'd'.repeat(257),
        emoji: '\u{1F426}'.repeat(5),
        color: 'red',
        roles: Array.from({length: 11}, () => 'host'),
      }),
    )
    expect(member?.description).toBeUndefined()
    expect(member?.emoji).toBeUndefined()
    expect(member?.color).toBeUndefined()
    expect(member?.roles).toEqual([])
    expect(
      parseSystem(records.system({name: 'n'.repeat(65)}))?.name,
    ).toBeUndefined()
    expect(
      parseFront({
        ...records.front([]),
        members: Array.from({length: 21}, (_, i) => ({id: `m${i}`})),
      }),
    ).toBeNull()
  })

  it('keep a form with commas, slashes or a middle dot exactly as written', () => {
    const forms = [`they ${MIDDOT} it`, 'he, him', 'she/her']
    expect(parsePronouns(records.pronouns([forms]))?.sets).toEqual([forms])
  })

  it('ignore the old client`s off-spec fields', () => {
    const system = parseSystem(
      records.system({avatar: {}, banner: {}, externalUrl: 'https://x.test'}),
    )
    expect(system).not.toHaveProperty('avatar')
    expect(system).not.toHaveProperty('externalUrl')
    const member = parseMember(
      records.member('Wren', {
        pronounDisplayMode: 'firstOnly',
        externalUrl: 'https://x.test',
      }),
    )
    expect(member).not.toHaveProperty('pronounDisplayMode')
    expect(member).not.toHaveProperty('externalUrl')
  })

  it('read member images as PNG, JPEG or WebP blobs of at most 1,000,000 bytes', () => {
    const blob = (mimeType: string, size = 1000) => ({
      $type: 'blob',
      ref: {$link: 'bafkreiavatar'},
      mimeType,
      size,
    })
    expect(
      parseMember(records.member('Wren', {avatar: blob('image/png')}))?.avatar,
    ).toEqual({
      cid: 'bafkreiavatar',
      mimeType: 'image/png',
      size: 1000,
    })
    expect(
      parseMember(records.member('Wren', {avatar: blob('image/webp')}))?.avatar
        ?.mimeType,
    ).toBe('image/webp')
    expect(
      parseMember(records.member('Wren', {avatar: blob('image/gif')}))?.avatar,
    ).toBeUndefined()
    expect(
      parseMember(
        records.member('Wren', {banner: blob('image/jpeg', 1_000_001)}),
      )?.banner,
    ).toBeUndefined()
    expect(parseBlob({cid: 'bafylegacy', mimeType: 'image/jpeg'})).toEqual({
      cid: 'bafylegacy',
      mimeType: 'image/jpeg',
    })
  })

  it('read the front`s entries by rkey, dropping bad ones and repeats', () => {
    const front = parseFront({
      ...records.front([]),
      members: [
        {id: WREN},
        {id: SPARROW, status: 'co-conscious'},
        {id: WREN},
        {id: 'not an rkey'},
        {id: 'x', status: 's'.repeat(33)},
      ],
      state: 'co-front',
    })
    expect(front?.members).toEqual([
      {id: WREN},
      {id: SPARROW, status: 'co-conscious'},
    ])
    expect(front?.state).toBe('co-front')
    expect(isEngaging({id: WREN})).toBe(true)
    expect(isEngaging({id: WREN, status: 'engaging'})).toBe(true)
    expect(isEngaging({id: WREN, status: 'co-conscious'})).toBe(false)
  })
})

describe('format', () => {
  it('keeps "they <middot> it" one form', () => {
    expect(formatSet([`they ${MIDDOT} it`, 'faer'])).toBe(
      `they ${MIDDOT} it/faer`,
    )
  })

  it('joins sets with a spaced middle dot and forms with /', () => {
    expect(
      formatSets([
        ['she', 'her'],
        ['fae', 'faer', 'faerself'],
      ]),
    ).toBe(`she/her ${MIDDOT} fae/faer/faerself`)
  })

  it('never alters forms beyond trimming for display', () => {
    const forms = ['He', 'HIM ', ' xe']
    expect(formatSet(forms)).toBe('He/HIM/xe')
    expect(forms).toEqual(['He', 'HIM ', ' xe'])
  })

  it('follows displayMode, and shows nothing for empty sets', () => {
    const sets = [
      ['she', 'her'],
      ['they', 'them'],
    ]
    expect(formatPronouns({sets, displayMode: 'all'})).toBe(
      `she/her ${MIDDOT} they/them`,
    )
    expect(formatPronouns({sets, displayMode: 'firstOnly'})).toBe('she/her')
    expect(formatPronouns({sets: [], displayMode: 'all'})).toBe('')
  })

  it('names fronters with ", " and one & after the last', () => {
    expect(formatFronterNames(['Wren', 'Sparrow'])).toBe('Wren & Sparrow')
    expect(formatFronterNames(['Wren', 'Sparrow', 'Robin'])).toBe(
      'Wren, Sparrow & Robin',
    )
    expect(formatFronterNames(['Wren'])).toBe('Wren')
    expect(formatFronterNames([' '])).toBe('')
    expect(formatMemberLabel({displayName: 'Wren', emoji: '\u{1F426}'})).toBe(
      '\u{1F426} Wren',
    )
  })

  it('labels known front states and shows others as typed', () => {
    expect(typeof formatFrontState('solo')).toBe('object')
    expect(formatFrontState('just-switched')).toBe('just-switched')
    expect(formatFrontState('constructor')).toBe('constructor')
    expect(formatFrontState('  ')).toBeUndefined()
  })
})

describe('the fronters field', () => {
  const post = {
    $type: 'app.bsky.feed.post',
    text: 'hi',
    createdAt: '2026-10-24T00:00:00Z',
  }

  it('withFronters copies without mutating, and an empty list removes the key', () => {
    const written = withFronters(post, [SPARROW, WREN, WREN])
    expect(written).not.toBe(post)
    expect(post).not.toHaveProperty([PLURAL_FRONTERS_KEY])
    expect((written as Record<string, unknown>)[PLURAL_FRONTERS_KEY]).toEqual({
      members: [{id: SPARROW}, {id: WREN}],
    })
    const cleared = withFronters(written, [])
    expect(cleared).not.toHaveProperty([PLURAL_FRONTERS_KEY])
    expect(written).toHaveProperty([PLURAL_FRONTERS_KEY])
    expect(() =>
      withFronters(
        post,
        Array.from({length: MAX_FRONTERS + 1}, (_, i) => `m${i}`),
      ),
    ).toThrow()
  })

  it('readFronters rejects a non-object, an empty array, 21 entries, a bad id', () => {
    const on = (value: unknown) => ({...post, [PLURAL_FRONTERS_KEY]: value})
    expect(readFronters(on([{id: WREN}]))).toBeNull()
    expect(readFronters(on('wren'))).toBeNull()
    expect(readFronters(on({members: []}))).toBeNull()
    expect(
      readFronters(
        on({members: Array.from({length: 21}, (_, i) => ({id: `m${i}`}))}),
      ),
    ).toBeNull()
    expect(readFronters(on({members: [{id: 7}]}))).toBeNull()
    expect(readFronters(on({members: [{id: 'a/b'}]}))).toBeNull()
    expect(readFronters(post)).toBeNull()
    expect(readFronters(null)).toBeNull()
  })

  it('dedupes, and gives display (list) order whatever the record order', () => {
    const record = {
      ...post,
      [PLURAL_FRONTERS_KEY]: {
        members: [{id: SPARROW}, {id: WREN}, {id: SPARROW, status: 'engaging'}],
      },
    }
    expect(readFronters(record)).toEqual([WREN, SPARROW])
  })
})

function memberAnswer(name: string) {
  return {
    kind: 'record' as const,
    value: parseMember(records.member(name)) as PluralMember,
  }
}

describe('the display rule', () => {
  const system = {
    kind: 'record' as const,
    value: parseSystem(records.system())!,
  }

  it('shows fronters only with a system record', () => {
    const members = [{rkey: WREN, answer: memberAnswer('Wren')}]
    expect(
      resolvePostFronters(system, members)?.map(f => f.member.displayName),
    ).toEqual(['Wren'])
    expect(resolvePostFronters({kind: 'none'}, members)).toBeNull()
    expect(resolvePostFronters(undefined, members)).toBeNull()
  })

  it('leaves out a member answered none; none left gives the account', () => {
    expect(
      resolvePostFronters(system, [
        {rkey: WREN, answer: memberAnswer('Wren')},
        {rkey: SPARROW, answer: {kind: 'none'}},
      ])?.map(f => f.rkey),
    ).toEqual([WREN])
    expect(
      resolvePostFronters(system, [{rkey: WREN, answer: {kind: 'none'}}]),
    ).toBeNull()
  })

  it('holds the line at the account while a member is unknown, so two never show as one', () => {
    expect(
      resolvePostFronters(system, [
        {rkey: WREN, answer: memberAnswer('Wren')},
        {rkey: SPARROW, answer: undefined},
      ]),
    ).toBeNull()
  })
})

describe('three pronoun states', () => {
  const record = (sets: string[][]) => ({
    kind: 'record' as const,
    value: parsePronouns(records.pronouns(sets))!,
  })

  it('a record shows its sets; empty sets show nothing and block the short field', () => {
    expect(pronounsFromAnswer(record([['she', 'her']]), 'he/him')).toEqual({
      text: 'she/her',
      sets: [['she', 'her']],
      source: 'record',
    })
    expect(pronounsFromAnswer(record([]), 'he/him')).toEqual({
      text: '',
      sets: [],
      source: 'none',
    })
  })

  it('a proven none shows the short field; unknown never does', () => {
    expect(pronounsFromAnswer({kind: 'none'}, 'he/him').source).toBe('stock')
    expect(pronounsFromAnswer({kind: 'none'}, 'he/him').text).toBe('he/him')
    expect(pronounsFromAnswer(undefined, 'he/him')).toEqual({
      text: '',
      sets: [],
      source: 'none',
    })
  })
})

describe('the batcher`s caps (P5R2-N11)', () => {
  it('splits 60 DIDs and 150 member URIs into calls within 50 DIDs and 100 URIs', () => {
    const dids = Array.from(
      {length: 60},
      (_, i) => `did:plc:actor${String(i).padStart(18, 'a')}`,
    )
    const members = Array.from({length: 150}, (_, i) => {
      const did = dids[i % 30]
      return {did, uri: memberUri(did, `3m4kq${String(i).padStart(8, '0')}`)}
    })
    const calls = planIdentityCalls(dids, members)
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      const named = new Set([
        ...call.actors,
        ...call.members.map(uri => uri.split('/')[2]),
      ])
      expect(named.size).toBeLessThanOrEqual(50)
      expect(call.members.length).toBeLessThanOrEqual(100)
    }
    // Everything is asked exactly once.
    expect(calls.flatMap(call => call.actors).sort()).toEqual([...dids].sort())
    expect(calls.flatMap(call => call.members).sort()).toEqual(
      members.map(m => m.uri).sort(),
    )
  })

  it('keeps a DID`s actor and member asks in one call where they fit', () => {
    const calls = planIdentityCalls(
      [AUTHOR],
      [{did: AUTHOR, uri: memberUri(AUTHOR, WREN)}],
    )
    expect(calls).toEqual([
      {actors: [AUTHOR], members: [memberUri(AUTHOR, WREN)]},
    ])
  })
})

describe('the 429 wait (P5R5-N5)', () => {
  const now = 1_790_000_000_000
  const headers = (h: Record<string, string>) => new Headers(h)

  it('reads Retry-After before ratelimit-reset', () => {
    const resetInAnHour = String(Math.floor(now / 1000) + 3600)
    expect(
      identityRateLimitWaitMs(
        headers({'retry-after': '20', 'ratelimit-reset': resetInAnHour}),
        now,
      ),
    ).toBe(20_000)
  })

  it('caps the wait at 10 minutes', () => {
    expect(identityRateLimitWaitMs(headers({'retry-after': '7200'}), now)).toBe(
      600_000,
    )
    const reset = String(Math.floor(now / 1000) + 7200)
    expect(
      identityRateLimitWaitMs(headers({'ratelimit-reset': reset}), now),
    ).toBe(600_000)
  })

  it('uses ratelimit-reset alone when it is the only header, and 30 s with neither', () => {
    const reset = String(Math.floor(now / 1000) + 45)
    expect(
      identityRateLimitWaitMs(headers({'ratelimit-reset': reset}), now),
    ).toBe(45_000)
    expect(identityRateLimitWaitMs(headers({}), now)).toBe(30_000)
  })
})

describe('the development constant', () => {
  it('IDENTITY_PDS_FALLBACK_DIDS is committed empty (P5R2-N1)', () => {
    expect(IDENTITY_PDS_FALLBACK_DIDS).toEqual([])
  })
})
