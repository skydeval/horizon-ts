import {describe, expect, it} from '@jest/globals'

import {cleanSignInIdentifier} from '#/horizon/session/identifier'

/*
 * 2026-10-27: a tester's valid handle failed to sign in while their DID
 * worked. The OAuth client takes only a bare handle.
 */

const HANDLE = 'alice.example.com'

describe('cleanSignInIdentifier', () => {
  it('drops a leading @ and surrounding space', () => {
    expect(cleanSignInIdentifier(`@${HANDLE}`)).toBe(HANDLE)
    expect(cleanSignInIdentifier(`  @${HANDLE} `)).toBe(HANDLE)
  })

  it('drops invisible direction marks from a copied handle', () => {
    expect(cleanSignInIdentifier(`‪@${HANDLE}‬`)).toBe(HANDLE)
    expect(cleanSignInIdentifier(`‎${HANDLE}​`)).toBe(HANDLE)
  })

  it('lowercases a handle a phone keyboard capitalised', () => {
    expect(cleanSignInIdentifier('Alice.Example.Com')).toBe(HANDLE)
  })

  it('reads a pasted profile link as its handle or DID', () => {
    expect(cleanSignInIdentifier(`https://bsky.app/profile/${HANDLE}`)).toBe(
      HANDLE,
    )
    expect(
      cleanSignInIdentifier(
        'https://horizon-preview2.pages.dev/profile/did:plc:ffffffffffffffffffffffff/post/3abc',
      ),
    ).toBe('did:plc:ffffffffffffffffffffffff')
  })

  it('keeps a DID and a server address as typed', () => {
    expect(cleanSignInIdentifier(' did:plc:ffffffffffffffffffffffff ')).toBe(
      'did:plc:ffffffffffffffffffffffff',
    )
    expect(cleanSignInIdentifier('https://Pds.Example.Com')).toBe(
      'https://Pds.Example.Com',
    )
  })

  it('leaves nothing for an empty or invisible-only entry', () => {
    expect(cleanSignInIdentifier('  ​ ')).toBe('')
    expect(cleanSignInIdentifier('@')).toBe('')
  })
})
