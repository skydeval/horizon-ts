import {describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * 2K design 4.1 (PA-10) and T-20, T-22: the encoded record's builder and its
 * validator's create and rewrite forms; 5.2's mark parser.
 */
import {
  assembleEncodedRecord,
  ENCODER_OWNED_KEYS,
  encoderContentOf,
  rewriteEncodedRecord,
} from '../api/encoded-record'
import {PrivatePostInvalidError, validateEncodedRecord} from '../api/validate'
import {parseGenerationSecs} from '../rotation/generation'
import {AUDIENCE, blob, DID, OTHER_DID, RECORD_CID} from './fixtures'

const PP = 'tools.kryphocron.feed.postPrivate'
const PUB = 'tools.kryphocron.feed.postPublic'
const MARK = `codec/${String(1_790_000_000).padStart(20, '0')}/${'b'.repeat(64)}`
const ref = {uri: `at://${DID}/${PP}/3kparent2222`, cid: RECORD_CID}

function fields(extra: Record<string, unknown> = {}) {
  return {
    encodedContent: new Uint8Array([9, 8, 7]),
    encodedContentCodec: 'codec/0.2',
    encodedContentGeneration: MARK,
    ...extra,
  }
}

function encoded(extra: Record<string, unknown> = {}) {
  return {
    $type: PP,
    createdAt: '2026-10-21T12:00:00.000Z',
    audienceList: AUDIENCE,
    ...fields(),
    ...extra,
  }
}

function pathOf(record: unknown, form: 'create' | 'rewrite') {
  try {
    validateEncodedRecord(record, form as 'create')
  } catch (error) {
    expect(error).toBeInstanceOf(PrivatePostInvalidError)
    return (error as PrivatePostInvalidError).path
  }
  return undefined
}

describe('validateEncodedRecord, create form (T-20)', () => {
  it('accepts the clear fields and the encoder’s seven', () => {
    const record = encoded({
      reply: {root: ref, parent: ref},
      langs: ['en'],
      labels: {$type: `${PUB}#selfLabels`, values: [{val: 'nudity'}]},
      embedBlobs: [blob()],
      mentionDids: [OTHER_DID],
      quote: ref,
      mediaKinds: ['image'],
    })
    expect(validateEncodedRecord(record, 'create').encodedContent).toEqual(
      new Uint8Array([9, 8, 7]),
    )
  })

  it.each(['text', 'facets', 'embed'])('refuses a clear %s', key => {
    expect(pathOf(encoded({[key]: key === 'text' ? '' : []}), 'create')).toBe(
      key,
    )
  })

  it.each([
    'encodedContent',
    'encodedContentCodec',
    'encodedContentGeneration',
  ])('refuses a record missing %s', key => {
    const record: Record<string, unknown> = encoded()
    delete record[key]
    expect(pathOf(record, 'create')).toBe(key)
  })

  it('refuses encodedContent that is not bytes', () => {
    expect(pathOf(encoded({encodedContent: {$bytes: 'CQgH'}}), 'create')).toBe(
      'encodedContent',
    )
  })

  it('refuses an unknown key, and publicCompanion', () => {
    expect(pathOf(encoded({extra: 1}), 'create')).toBe('extra')
    expect(pathOf(encoded({publicCompanion: ref}), 'create')).toBe(
      'publicCompanion',
    )
  })

  it('refuses a non-DID mentionDids item, an audienceList that is not an audience, and another $type', () => {
    expect(pathOf(encoded({mentionDids: ['not a did']}), 'create')).toMatch(
      /^mentionDids/,
    )
    expect(
      pathOf(
        encoded({audienceList: `at://${DID}/${PP}/3kpost222222`}),
        'create',
      ),
    ).toBe('audienceList')
    expect(pathOf(encoded({$type: 'app.bsky.feed.post'}), 'create')).toBe(
      '$type',
    )
  })

  it('names keys only: no value is in the error message', () => {
    let message = ''
    try {
      validateEncodedRecord(encoded({mentionDids: ['secret-handle']}), 'create')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('secret-handle')
  })
})

describe('validateEncodedRecord, rewrite form and the stored-record check (T-20)', () => {
  it('keeps publicCompanion and an unknown key as stored, unchecked', () => {
    const stored = encoded({publicCompanion: {odd: true}, 'x.newer': [1]})
    expect(validateEncodedRecord(stored, 'rewrite')).toBe(stored)
  })

  it('refuses a clear text, facets or embed, and a missing encoded field', () => {
    expect(pathOf(encoded({text: 'clear'}), 'rewrite')).toBe('text')
    expect(pathOf(encoded({facets: []}), 'rewrite')).toBe('facets')
    expect(pathOf(encoded({embed: {}}), 'rewrite')).toBe('embed')
    const record: Record<string, unknown> = encoded()
    delete record.encodedContent
    expect(pathOf(record, 'rewrite')).toBe('encodedContent')
  })

  it('checks the encoder’s keys and Horizon’s clear keys when present', () => {
    expect(pathOf(encoded({mentionDids: ['nope']}), 'rewrite')).toMatch(
      /^mentionDids/,
    )
    expect(pathOf(encoded({createdAt: 'yesterday'}), 'rewrite')).toBe(
      'createdAt',
    )
    const noAudience: Record<string, unknown> = encoded()
    delete noAudience.audienceList
    expect(pathOf(noAudience, 'rewrite')).toBeUndefined()
  })
})

describe('the encoded record (4.1)', () => {
  it('assembles the clear fields and the encoder’s fields verbatim, absent ones left out', () => {
    const record = assembleEncodedRecord(
      {createdAt: '2026-10-21T12:00:00.000Z', audienceList: AUDIENCE},
      fields({mentionDids: [OTHER_DID]}),
    )
    expect(record).toEqual({
      $type: PP,
      createdAt: '2026-10-21T12:00:00.000Z',
      audienceList: AUDIENCE,
      ...fields({mentionDids: [OTHER_DID]}),
    })
    expect(validateEncodedRecord(record, 'create')).toBeDefined()
  })

  it('takes only text, facets and embed into the encoder, and only when present', () => {
    expect(
      encoderContentOf({
        $type: PP,
        text: 'hi',
        createdAt: '2026-10-21T12:00:00.000Z',
        audienceList: AUDIENCE,
        langs: ['en'],
      } as never),
    ).toEqual({text: 'hi'})
  })

  it('a rewrite replaces exactly the seven keys and keeps every other one (R-9)', () => {
    const stored = encoded({
      mentionDids: [OTHER_DID],
      quote: ref,
      publicCompanion: ref,
      'x.newer': 'kept',
    })
    const next = rewriteEncodedRecord(stored, fields(), {
      audienceList: `at://${DID}/tools.kryphocron.policy.audience/3knew2222222`,
    })
    expect(next).toEqual({
      $type: PP,
      createdAt: stored.createdAt,
      audienceList: `at://${DID}/tools.kryphocron.policy.audience/3knew2222222`,
      publicCompanion: ref,
      'x.newer': 'kept',
      ...fields(),
    })
    expect(next).not.toHaveProperty('mentionDids')
    expect(ENCODER_OWNED_KEYS).toHaveLength(7)
  })
})

describe('the generation mark (5.2)', () => {
  it('parses the seconds of a well-formed mark', () => {
    expect(parseGenerationSecs(MARK)).toBe(1_790_000_000)
  })

  it.each([
    ['too few digits', `codec/1790000000/${'b'.repeat(64)}`],
    ['a short slug', `codec/${'0'.repeat(20)}/${'b'.repeat(63)}`],
    ['upper-case hex', `codec/${'0'.repeat(20)}/${'B'.repeat(64)}`],
    ['no codec', `/${'0'.repeat(20)}/${'b'.repeat(64)}`],
    ['a number', 12],
  ])('does not parse %s', (_label, mark) => {
    expect(parseGenerationSecs(mark)).toBeUndefined()
  })
})
