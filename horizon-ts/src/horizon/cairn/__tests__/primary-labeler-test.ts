import {Client} from '@atproto/lex'
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/storage', () => ({
  account: {get: jest.fn(), set: jest.fn()},
  device: {get: jest.fn(), set: jest.fn()},
}))

import {configureGlobalAppLabelers} from '#/state/session/additional-moderation-authorities'
import {
  cairnPrimaryLabeler,
  cairnUrl,
  checkCairnPrimaryLabeler,
  resetCairnPrimaryLabelerForTests,
} from '#/horizon/cairn/primary-labeler'
import {writeLocal} from '#/horizon/session/local-store'

const BASE = 'https://cairn.example'
const PRIMARY = 'did:web:cairn.example'
const BSKY = 'did:plc:ar7c4by46qjdydhdevvrndac'

type Reply = {status: number; body?: unknown} | 'network'

/** A fetch answering cairn's endpoint and getServices with set replies. */
function fakeFetch(
  cairn: Reply,
  services: Reply = {status: 200, body: {views: [{}]}},
) {
  return (input: string) => {
    const reply = input.includes('getPrimaryLabeler') ? cairn : services
    if (reply === 'network') {
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {status: reply.status}),
    )
  }
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_CAIRN_URL = BASE
  writeLocal('horizon:cairnPrimaryLabeler', undefined)
  resetCairnPrimaryLabelerForTests()
})

afterEach(() => {
  delete process.env.EXPO_PUBLIC_CAIRN_URL
})

describe('cairnUrl', () => {
  it('takes an https origin and refuses anything else', () => {
    expect(cairnUrl('https://cairn.example/')).toBe(BASE)
    expect(cairnUrl('http://cairn.example')).toBeUndefined()
    expect(cairnUrl('not a url')).toBeUndefined()
    expect(cairnUrl('')).toBeUndefined()
    delete process.env.EXPO_PUBLIC_CAIRN_URL
    expect(cairnUrl()).toBeUndefined()
  })
})

describe('checkCairnPrimaryLabeler', () => {
  it('applies a published primary', async () => {
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: PRIMARY}}),
    )
    expect(cairnPrimaryLabeler()).toBe(PRIMARY)
  })

  it('drops the primary when cairn says it is not published or not found', async () => {
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: PRIMARY}}),
    )
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 404, body: {error: 'NotPublished'}}),
    )
    expect(cairnPrimaryLabeler()).toBeUndefined()

    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: PRIMARY}}),
    )
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 404, body: {error: 'NotFound'}}),
    )
    expect(cairnPrimaryLabeler()).toBeUndefined()
  })

  it('keeps the last primary through outages and bad answers', async () => {
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: PRIMARY}}),
    )
    await checkCairnPrimaryLabeler(fakeFetch('network'))
    await checkCairnPrimaryLabeler(fakeFetch({status: 503}))
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: 'nope'}}),
    )
    expect(cairnPrimaryLabeler()).toBe(PRIMARY)
  })

  it('drops the primary when its service record is gone', async () => {
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: PRIMARY}}),
    )
    await checkCairnPrimaryLabeler(
      fakeFetch(
        {status: 200, body: {did: PRIMARY}},
        {status: 200, body: {views: []}},
      ),
    )
    expect(cairnPrimaryLabeler()).toBeUndefined()
  })

  it('waits for a later check when a new primary cannot be confirmed', async () => {
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: PRIMARY}}, 'network'),
    )
    expect(cairnPrimaryLabeler()).toBeUndefined()
  })

  it('behaves as unset before cairn ever answers', () => {
    expect(cairnPrimaryLabeler()).toBeUndefined()
  })

  it('does nothing without an operator cairn address', async () => {
    delete process.env.EXPO_PUBLIC_CAIRN_URL
    writeLocal('horizon:cairnPrimaryLabeler', PRIMARY)
    resetCairnPrimaryLabelerForTests()
    const fetchImpl = jest.fn(fakeFetch({status: 200, body: {did: PRIMARY}}))
    await checkCairnPrimaryLabeler(fetchImpl)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(cairnPrimaryLabeler()).toBeUndefined()
  })

  it('remembers the primary across restarts', async () => {
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: PRIMARY}}),
    )
    resetCairnPrimaryLabelerForTests()
    expect(cairnPrimaryLabeler()).toBe(PRIMARY)
  })
})

describe('the app labelers', () => {
  it('always carry the primary, and drop it once it is gone', async () => {
    await checkCairnPrimaryLabeler(
      fakeFetch({status: 200, body: {did: PRIMARY}}),
    )
    configureGlobalAppLabelers([BSKY])
    expect(Client.appLabelers).toEqual([BSKY, PRIMARY])

    await checkCairnPrimaryLabeler(
      fakeFetch({status: 404, body: {error: 'NotPublished'}}),
    )
    configureGlobalAppLabelers([...Client.appLabelers])
    expect(Client.appLabelers).toEqual([BSKY])
  })

  it('are untouched without an operator cairn address', () => {
    delete process.env.EXPO_PUBLIC_CAIRN_URL
    configureGlobalAppLabelers([BSKY])
    expect(Client.appLabelers).toEqual([BSKY])
  })
})
