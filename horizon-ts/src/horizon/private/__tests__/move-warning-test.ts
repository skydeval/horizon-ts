import {describe, expect, it} from '@jest/globals'

import {moveWarning} from '../settings/post-settings'

describe('the move warning (2H design 12.1, T15)', () => {
  it('shows the interim line only while prism lacks private.threadAudience', () => {
    expect(
      moveWarning({isReply: false, threadAudienceServed: false}).interim,
    ).toBe(true)
    expect(
      moveWarning({isReply: false, threadAudienceServed: true}).interim,
    ).toBe(false)
  })

  it('words a branch root apart from a thread root', () => {
    expect(
      moveWarning({isReply: false, threadAudienceServed: true}).scope,
    ).toBe('thread')
    expect(moveWarning({isReply: true, threadAudienceServed: true}).scope).toBe(
      'branch',
    )
  })
})
