import {describe, expect, it} from 'vitest'

import {notifySources, SERVICE_DID} from '../src/config'
import {buildMessage, classifyFailure} from '../src/fcm'
import {DID_DOC, readNotifyInput, readPushInput} from '../src/input'

describe('notifySources', () => {
  it("is Horizon's prism unless configured", () => {
    expect([...notifySources(undefined)]).toEqual(['did:web:prism.nearhorizon.app'])
    expect([...notifySources(' ')]).toEqual(['did:web:prism.nearhorizon.app'])
    expect([...notifySources('did:web:a.example, did:web:b.example,junk')]).toEqual([
      'did:web:a.example',
      'did:web:b.example',
    ])
  })
})

describe('readNotifyInput', () => {
  const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
  it('takes a list of DIDs, once each', () => {
    expect(readNotifyInput({dids: [A, A, 'did:web:example.com']})).toEqual([
      A,
      'did:web:example.com',
    ])
  })
  it('refuses empty, oversized and malformed lists', () => {
    expect(readNotifyInput({dids: []})).toMatch(/non-empty/)
    expect(readNotifyInput({dids: Array(101).fill(A)})).toMatch(/at most/)
    expect(readNotifyInput({dids: ['alice.example.com']})).toMatch(/DIDs/)
    expect(readNotifyInput(null)).toMatch(/non-empty/)
  })
})

const good = {
  serviceDid: SERVICE_DID,
  token: 'fcm-token-example-1234',
  platform: 'android',
  appId: 'app.nearhorizon',
}

describe('readPushInput', () => {
  it('accepts a Horizon Android registration', () => {
    expect(readPushInput({...good, ageRestricted: false})).toEqual(good)
  })

  it("refuses Bluesky's service, other apps, other platforms and bad tokens", () => {
    expect(readPushInput({...good, serviceDid: 'did:web:api.bsky.app'})).toMatch(/serviceDid/)
    expect(readPushInput({...good, appId: 'xyz.blueskyweb.app'})).toMatch(/appId/)
    expect(readPushInput({...good, platform: 'ios'})).toMatch(/platform/)
    expect(readPushInput({...good, token: 'x'})).toMatch(/token/)
    expect(readPushInput([])).toMatch(/object/)
  })
})

describe('DID document', () => {
  it('names the push service entry apps proxy to', () => {
    expect(DID_DOC.id).toBe(SERVICE_DID)
    expect(DID_DOC.service[0]).toMatchObject({
      id: '#horizon_push',
      serviceEndpoint: 'https://push.nearhorizon.app',
    })
  })
})

describe('Firebase messages', () => {
  it('carry no text, only which account should check', () => {
    const {message} = buildMessage('tok', 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(message.data).toEqual({kind: 'check', did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'})
    expect(message).not.toHaveProperty('notification')
    expect(message.android.priority).toBe('HIGH')
  })

  it('drop tokens Firebase no longer knows, retry on overload', () => {
    expect(classifyFailure(404, '')).toBe('gone')
    expect(classifyFailure(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}')).toBe(
      'gone',
    )
    expect(classifyFailure(400, 'The registration token is not a valid FCM registration token')).toBe(
      'gone',
    )
    expect(classifyFailure(429, '')).toBe('retry')
    expect(classifyFailure(503, '')).toBe('retry')
    expect(classifyFailure(403, '')).toBe('failed')
  })
})
