import {describe, expect, it} from '@jest/globals'

import {
  convertBskyAppUrlIfNeeded,
  isExternalUrl,
  isHorizonAppUrl,
} from '#/lib/strings/url-helpers'
import {
  HORIZON_PRIVACY_URL,
  HORIZON_SUPPORT_URL,
  HORIZON_TERMS_URL,
} from '#/horizon/support/links'

/*
 * The support, privacy and terms pages are plain pages beside the app, so
 * links to them open as web pages, not as (missing) app screens. Other
 * Horizon links still open in the app.
 */

describe('Horizon support links', () => {
  it('open as web pages', () => {
    for (const url of [
      HORIZON_SUPPORT_URL,
      HORIZON_PRIVACY_URL,
      HORIZON_TERMS_URL,
    ]) {
      expect(isHorizonAppUrl(url)).toBe(false)
      expect(isExternalUrl(url)).toBe(true)
      expect(convertBskyAppUrlIfNeeded(url)).toBe(url)
    }
  })

  it('leaves other Horizon links in the app', () => {
    const post = 'https://nearhorizon.app/profile/alice.test/post/3kabc'
    expect(isHorizonAppUrl(post)).toBe(true)
    expect(convertBskyAppUrlIfNeeded(post)).toBe(
      '/profile/alice.test/post/3kabc',
    )
    expect(isHorizonAppUrl('https://nearhorizon.app/aboutface')).toBe(true)
  })
})
