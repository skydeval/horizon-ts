import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The post query's and the finders' modules also hold hooks that reach the
 * session and the UI; nothing here renders, so those are stand-ins.
 */
function mockModule(): unknown {
  const stub = function () {
    return mockModule()
  }
  return new Proxy(stub, {
    get: (_, key) => {
      if (key === '__esModule') return true
      if (key === 'then' || typeof key === 'symbol') return undefined
      return mockModule()
    },
  })
}
jest.mock('#/state/session', () => mockModule())
jest.mock('#/components/Toast', () => mockModule())
jest.mock('react-native-reanimated', () => mockModule())
jest.mock('react-native-worklets', () => mockModule())

let mockMediaSpoilers = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {MEDIA_SPOILERS: {get: () => mockMediaSpoilers, enumerable: true}},
  ),
)

import {CW_SELF_LABEL, MEDIA_SPOILER_FIELD} from '../nsid'
import {replyToMediaCovered} from '../reply-preview'

beforeEach(() => {
  mockMediaSpoilers = true
})

function record(flag: boolean, cw = false) {
  return {
    $type: 'app.bsky.feed.post',
    text: 'hello',
    createdAt: '2026-10-18T12:00:00.000Z',
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{alt: '', ...(flag ? {[MEDIA_SPOILER_FIELD]: true} : {})}],
    },
    ...(cw
      ? {
          labels: {
            $type: 'com.atproto.label.defs#selfLabels',
            values: [{val: CW_SELF_LABEL}],
          },
        }
      : {}),
  }
}

describe('replyToMediaCovered (T9)', () => {
  it('covers a found record with a flag or a CW', () => {
    expect(replyToMediaCovered(record(true))).toBe(true)
    expect(replyToMediaCovered(record(false, true))).toBe(true)
  })

  it('shows the images of a found record without either', () => {
    expect(replyToMediaCovered(record(false))).toBe(false)
  })

  it('covers while no matching record is known (loading or failed)', () => {
    expect(replyToMediaCovered(undefined)).toBe(true)
  })

  it('covers nothing with MEDIA_SPOILERS off', () => {
    mockMediaSpoilers = false
    expect(replyToMediaCovered(undefined)).toBe(false)
    expect(replyToMediaCovered(record(true))).toBe(false)
  })
})
