import {type Client} from '@atproto/lex'
import {afterEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/storage', () => ({account: {get: jest.fn(), set: jest.fn()}}))

import {applyLabelersToClient} from '#/state/session/moderation'
import {readLocal} from '#/horizon/session/local-store'
import {
  answerKryphocronLabelers,
  isKryphocronLabeler,
  likedLabelerDid,
  withoutKryphocronLabelers,
} from '..'

/*
 * Kryphocron labelers: the list from a member's getMembership answer, kept
 * per account on the device, and the header that leaves them out.
 * Synthetic DIDs only.
 */

const ME = 'did:plc:klreader00000000000000001'
const OTHER_ACCOUNT = 'did:plc:klreader00000000000000002'
const LABELER = 'did:plc:kllabeler0000000000000001'
const OTHER = 'did:plc:klother00000000000000001'

afterEach(() => {
  answerKryphocronLabelers(ME, [])
  answerKryphocronLabelers(OTHER_ACCOUNT, [])
})

describe('kryphocron labelers', () => {
  it('knows the ones a member’s answer names, kept on the device', () => {
    expect(isKryphocronLabeler(LABELER)).toBe(false)
    answerKryphocronLabelers(ME, [LABELER])
    expect(isKryphocronLabeler(LABELER)).toBe(true)
    expect(isKryphocronLabeler(OTHER)).toBe(false)
    expect(readLocal(`horizon:kryphocronLabelers:${ME}`)).toBe(
      JSON.stringify([LABELER]),
    )
  })

  it('keeps the last list when the answer has none, and [] clears it', () => {
    answerKryphocronLabelers(ME, [LABELER])
    answerKryphocronLabelers(ME, undefined)
    expect(isKryphocronLabeler(LABELER)).toBe(true)
    answerKryphocronLabelers(ME, [])
    expect(isKryphocronLabeler(LABELER)).toBe(false)
    expect(readLocal(`horizon:kryphocronLabelers:${ME}`)).toBeUndefined()
  })

  it('counts a DID any account on the device was told about', () => {
    answerKryphocronLabelers(OTHER_ACCOUNT, [LABELER])
    expect(isKryphocronLabeler(LABELER)).toBe(true)
  })

  it('drops entries that are not DIDs', () => {
    answerKryphocronLabelers(ME, [LABELER, 7, 'not a did', ''])
    expect(isKryphocronLabeler(LABELER)).toBe(true)
    expect(isKryphocronLabeler('not a did')).toBe(false)
  })

  it('drops them from a list, keeping the order', () => {
    answerKryphocronLabelers(ME, [LABELER])
    expect(withoutKryphocronLabelers([OTHER, LABELER, 'did:plc:c'])).toEqual([
      OTHER,
      'did:plc:c',
    ])
  })

  it('reads the labeler from a labeler service uri only', () => {
    expect(likedLabelerDid(`at://${LABELER}/app.bsky.labeler.service/self`)).toBe(
      LABELER,
    )
    expect(
      likedLabelerDid(`at://${LABELER}/app.bsky.feed.post/3k2a`),
    ).toBeUndefined()
  })

  it('never puts one into the labeler header, even one named later', () => {
    const client = {setLabelers: jest.fn()} as unknown as Client
    applyLabelersToClient(client, [OTHER, LABELER])
    expect(client.setLabelers).toHaveBeenLastCalledWith([OTHER, LABELER])
    answerKryphocronLabelers(ME, [LABELER])
    expect(client.setLabelers).toHaveBeenLastCalledWith([OTHER])
  })
})
