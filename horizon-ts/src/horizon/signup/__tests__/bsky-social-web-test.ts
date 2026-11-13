import {describe, expect, it} from '@jest/globals'

import {signupNeedsBskyApp} from '../needs-bsky-app'

describe('signupNeedsBskyApp', () => {
  it('sends bsky.social sign-ups to bsky.app on the web only', () => {
    expect(signupNeedsBskyApp('https://bsky.social', true)).toBe(true)
    expect(signupNeedsBskyApp('https://bsky.social/', true)).toBe(true)
    expect(signupNeedsBskyApp('https://bsky.social', false)).toBe(false)
  })

  it('leaves other providers and bad input alone', () => {
    expect(signupNeedsBskyApp('https://pds.example.test', true)).toBe(false)
    expect(signupNeedsBskyApp('https://notbsky.social', true)).toBe(false)
    expect(signupNeedsBskyApp('not a url', true)).toBe(false)
  })
})
