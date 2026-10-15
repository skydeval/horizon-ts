import {describe, expect, it} from '@jest/globals'

import {type SessionAccount} from '#/state/session/types'
import {
  isOauthAccount,
  isOAuthSignedOut,
  isSignedInAccount,
  withoutSignedOutMark,
} from '../accounts'

const base: SessionAccount = {
  service: 'https://pds.example/',
  did: 'did:plc:aaaaaaaa',
  handle: 'alice.test',
}

describe('isSignedInAccount', () => {
  it('uses the stock rule for a password account', () => {
    const password = {...base, refreshJwt: 'r', accessJwt: 'a'}
    expect(isSignedInAccount(password, true)).toBe(true)
    expect(isSignedInAccount(password, false)).toBe(false)
    expect(isOauthAccount(password)).toBe(false)
  })

  it('treats an unmarked OAuth account as signed in, whatever the stock rule says', () => {
    const oauth = {...base, isOauthSession: true}
    expect(isSignedInAccount(oauth, false)).toBe(true)
    expect(isSignedInAccount(oauth, true)).toBe(true)
  })

  it('treats a marked OAuth account as signed out', () => {
    const marked = {...base, isOauthSession: true, oauthSignedOut: true}
    expect(isOAuthSignedOut(marked)).toBe(true)
    expect(isSignedInAccount(marked, true)).toBe(false)
    expect(isSignedInAccount(marked, false)).toBe(false)
  })

  it('strips the mark without reordering fields', () => {
    const marked = {
      ...base,
      pdsUrl: 'https://pds.example/',
      isOauthSession: true,
      oauthSignedOut: true,
    }
    const stripped = withoutSignedOutMark(marked)
    expect(Object.keys(stripped)).toEqual([
      'service',
      'did',
      'handle',
      'pdsUrl',
      'isOauthSession',
    ])
    expect(marked.oauthSignedOut).toBe(true)
  })
})
