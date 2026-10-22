import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'

let mockVideo = false
let mockGallery = false
// The interim behaviour is tested with each constant off; see the last case.
let mockQuoteWithMedia = false
let mockLangsLabels = false

jest.mock('#/horizon/private/server-support', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/private/server-support')},
    {
      PRIVATE_VIDEO: {get: () => mockVideo, enumerable: true},
      PRIVATE_GALLERY: {get: () => mockGallery, enumerable: true},
      PRIVATE_QUOTE_WITH_MEDIA: {
        get: () => mockQuoteWithMedia,
        enumerable: true,
      },
      PRIVATE_LANGS_LABELS: {get: () => mockLangsLabels, enumerable: true},
    },
  ),
)

import {
  type PostDraft,
  type ThreadDraft,
} from '#/view/com/composer/state/composer'
import {type WriteRoutes} from '#/horizon/routing/write-route'
import {
  privateAssetTypes,
  privateComposeAllows,
  privateComposeBlocker,
  privateRouteBlocker,
  privateRouteNote,
} from '../composer/blockers'

i18n.loadAndActivate({locale: 'en', messages: {}})

function routes(
  postingRoute: WriteRoutes['postingRoute'],
  extra: Partial<WriteRoutes> = {},
): WriteRoutes {
  return {
    repoRoute: postingRoute === 'locus' ? 'locus' : 'stock',
    postingRoute,
    reason: undefined,
    indexing: false,
    ...extra,
  }
}

const LOCUS = routes('locus')

function post(overrides: Partial<PostDraft> = {}): PostDraft {
  return {
    id: 'p',
    richtext: {text: 'hello'},
    labels: [],
    embed: {quote: undefined, media: undefined, link: undefined},
    shortenedGraphemeLength: 5,
    ...overrides,
  } as PostDraft
}

function thread(...posts: PostDraft[]): ThreadDraft {
  return {posts, postgate: {}, threadgate: []} as unknown as ThreadDraft
}

const quote = {type: 'link', uri: 'https://bsky.app/profile/a/post/3k'}
const images = {type: 'images', images: [{}]}
const video = {type: 'video', video: {status: 'done'}}

function gallery(count: number) {
  return {type: 'gallery', images: Array.from({length: count}, () => ({}))}
}

beforeEach(() => {
  mockVideo = false
  mockGallery = false
  mockQuoteWithMedia = false
  mockLangsLabels = false
})

describe('private compose blockers', () => {
  it('nothing blocks a plain post', () => {
    const t = thread(post())
    expect(privateComposeBlocker(t, LOCUS)).toBeUndefined()
    expect(privateComposeAllows(t, true, LOCUS)).toBe(true)
  })

  it('a video blocks only while PRIVATE_VIDEO is off', () => {
    const t = thread(
      post({embed: {quote: undefined, media: video, link: undefined}} as never),
    )
    expect(privateComposeBlocker(t, LOCUS)).toMatch(/video/)
    expect(privateComposeAllows(t, true, LOCUS)).toBe(false)
    mockVideo = true
    expect(privateComposeBlocker(t, LOCUS)).toBeUndefined()
    expect(privateComposeAllows(t, true, LOCUS)).toBe(true)
  })

  it('a gallery blocks only while PRIVATE_GALLERY is off; four images pass', () => {
    const five = thread(
      post({
        embed: {quote: undefined, media: gallery(5), link: undefined},
      } as never),
    )
    const four = thread(
      post({
        embed: {
          quote: undefined,
          media: {type: 'images', images: [{}, {}, {}, {}]},
          link: undefined,
        },
      } as never),
    )
    expect(privateComposeBlocker(five, LOCUS)).toMatch(/up to four images/)
    expect(privateComposeAllows(five, true, LOCUS)).toBe(false)
    expect(privateComposeBlocker(four, LOCUS)).toBeUndefined()
    mockGallery = true
    expect(privateComposeBlocker(five, LOCUS)).toBeUndefined()
    expect(privateComposeAllows(five, true, LOCUS)).toBe(true)
  })

  it('a quote with images blocks', () => {
    const t = thread(
      post({embed: {quote, media: images, link: undefined}} as never),
    )
    expect(privateComposeBlocker(t, LOCUS)).toMatch(/images and a quote/)
    expect(privateComposeAllows(t, true, LOCUS)).toBe(false)
  })

  it('a self-label blocks', () => {
    const t = thread(post({labels: ['sexual']} as never))
    expect(privateComposeBlocker(t, LOCUS)).toMatch(/content warnings/)
    expect(privateComposeAllows(t, true, LOCUS)).toBe(false)
  })

  it('a blocker in any post of a thread blocks', () => {
    const t = thread(post(), post({labels: ['nudity']} as never))
    expect(privateComposeAllows(t, true, LOCUS)).toBe(false)
  })

  it('with the 0.3.1 constants on (K-1, K-2), a quote with media and a content warning pass', () => {
    mockQuoteWithMedia = true
    mockLangsLabels = true
    const t = thread(
      post({
        labels: ['nudity'],
        embed: {quote, media: images, link: undefined},
      } as never),
    )
    expect(privateComposeBlocker(t, LOCUS)).toBeUndefined()
    expect(privateComposeAllows(t, true, LOCUS)).toBe(true)
  })

  it('nothing blocks a public compose', () => {
    const t = thread(
      post({
        labels: ['porn'],
        embed: {quote, media: video, link: undefined},
      } as never),
    )
    expect(privateComposeAllows(t, false, LOCUS)).toBe(true)
  })

  it('a private compose on posting route checking or none is blocked with the route’s text (2K T-13)', () => {
    const t = thread(post())
    expect(privateComposeBlocker(t, routes('checking'))).toBe(
      'Horizon is still checking your account.',
    )
    expect(privateComposeAllows(t, true, routes('checking'))).toBe(false)
    expect(privateComposeBlocker(t, routes('none'))).toBe(
      'Private posting isn’t available for your account yet. Your server doesn’t have it, and Horizon can’t prepare private posts for you right now.',
    )
    expect(privateComposeAllows(t, true, routes('none'))).toBe(false)
    // A public compose is never blocked by the route.
    expect(privateComposeAllows(t, false, routes('none'))).toBe(true)
    expect(privateRouteBlocker(LOCUS)).toBeUndefined()
    expect(privateRouteBlocker(routes('encode'))).toBeUndefined()
  })

  it('the none note words indexing and a missing encoder (8.1)', () => {
    expect(privateRouteNote(routes('none', {indexing: true}))).toBe(
      'Private posting isn’t available for your account yet. Horizon is still checking your account.',
    )
    expect(privateRouteNote(routes('none', {reason: 'no-encoder'}))).toBe(
      'Private posting isn’t available for your account yet. Posting privately from your server isn’t available in this app yet.',
    )
    expect(privateRouteNote(LOCUS)).toBeUndefined()
  })

  it('the media picker offers images only while private and PRIVATE_VIDEO is off', () => {
    expect(privateAssetTypes(undefined, true)).toBe('image')
    expect(privateAssetTypes('video', true)).toBe('image')
    expect(privateAssetTypes('video', false)).toBe('video')
    expect(privateAssetTypes(undefined, false)).toBeUndefined()
    mockVideo = true
    expect(privateAssetTypes(undefined, true)).toBeUndefined()
    expect(privateAssetTypes('video', true)).toBe('video')
    expect(privateAssetTypes('gif', true)).toBe('gif')
  })
})
