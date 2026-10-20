import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render} from '@testing-library/react-native'

let mockGtMobile = false

jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
  useBreakpoints: () => ({
    gtPhone: mockGtMobile,
    gtMobile: mockGtMobile,
    gtTablet: false,
  }),
}))

function mockMark(testID: string) {
  const {View} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return () => <View testID={testID} />
}

jest.mock('#/components/Typography', () => {
  const {Text} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {Text}
})
jest.mock('#/components/MediaInsetBorder', () => ({
  MediaInsetBorder: () => null,
}))
jest.mock('#/components/hooks/useInteractionState', () => ({
  useInteractionState: () => ({state: false, onIn: () => {}, onOut: () => {}}),
}))
jest.mock('#/components/icons/EyeSlash', () => ({
  EyeSlash_Stroke2_Corner0_Rounded: mockMark('eyeIcon'),
}))
jest.mock('#/components/icons/Lock', () => ({
  Lock_Stroke2_Corner0_Rounded: mockMark('lockIcon'),
}))
jest.mock('#/components/icons/Play', () => ({
  Play_Stroke2_Corner2_Rounded: mockMark('playIcon'),
}))
jest.mock('#/components/icons/SquareBehindSquare4', () => ({
  SquareBehindSquare4_Stroke2_Corner0_Rounded: mockMark('stackIcon'),
}))
jest.mock('#/horizon/media-spoilers/MediaSpoilerCover', () => ({
  MediaSpoilerPill: () => null,
}))
jest.mock('#/horizon/video/NoThumbnailTile', () => ({
  NoThumbnailTile: () => null,
}))

// A link renders its children and exposes where it goes.
jest.mock('#/components/Link', () => {
  const {View} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    Link: ({to, children}: {to: string; children: React.ReactNode}) => (
      <View testID="link" nativeID={to}>
        {children}
      </View>
    ),
  }
})

// No moderation blur: the content shows; the mask is not drawn.
jest.mock('#/components/moderation/Hider', () => ({
  Outer: ({children}: {children: React.ReactNode}) => <>{children}</>,
  Mask: () => null,
  Content: ({children}: {children: React.ReactNode}) => <>{children}</>,
}))

jest.mock('expo-image', () => {
  const {View} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    Image: ({
      blurRadius,
      source,
    }: {
      blurRadius: number
      source: {uri: string}
    }) => <View testID="thumb" nativeID={`${source.uri}|${blurRadius}`} />,
  }
})

import {type FeedPostSliceItem} from '#/state/queries/post-feed'
import {MEDIA_SPOILER_FIELD} from '#/horizon/media-spoilers/nsid'
import {MEDIA_SPOILER_BLUR_RADIUS} from '#/horizon/media-spoilers/read'
import {
  gridMediaOf,
  hasGridMedia,
  isMediaGridFeed,
  mediaGridColumns,
} from '../grid'
import {MediaGridRow} from '../MediaGrid'

i18n.loadAndActivate({locale: 'en', messages: {}})

const DID = 'did:plc:authorrrrrrrrrrrrrrrrrrr'
const PUBLIC_URI = `at://${DID}/app.bsky.feed.post/3kpublic`
const PRIVATE_URI = `at://${DID}/tools.kryphocron.feed.postPrivate/3kprivate`

const image = (n: number) => ({
  thumb: `https://cdn.test/thumb${n}.jpg`,
  fullsize: `https://cdn.test/full${n}.jpg`,
  alt: `alt ${n}`,
})

const imagesView = (count: number) => ({
  $type: 'app.bsky.embed.images#view',
  images: Array.from({length: count}, (_, i) => image(i + 1)),
})

function post({
  uri = PUBLIC_URI,
  embed,
  record = {$type: 'app.bsky.feed.post', text: 'x', createdAt: ''},
}: {
  uri?: string
  embed: unknown
  record?: Record<string, unknown>
}) {
  return {
    uri,
    cid: 'bafy',
    author: {did: DID, handle: 'author.test'},
    record,
    embed,
    indexedAt: '',
  }
}

const noModeration = {
  ui: () => ({blur: false, blurs: [], alerts: [], filters: [], informs: []}),
}

function item(p: ReturnType<typeof post>): FeedPostSliceItem {
  return {
    _reactKey: p.uri,
    uri: p.uri,
    post: p,
    record: p.record,
    moderation: noModeration,
  } as unknown as FeedPostSliceItem
}

function renderRow(items: FeedPostSliceItem[]) {
  return render(
    <I18nProvider i18n={i18n}>
      <MediaGridRow items={items} />
    </I18nProvider>,
  )
}

beforeEach(() => {
  mockGtMobile = false
})

describe('which feed is a grid, and its rows', () => {
  it('only a profile Media tab', () => {
    expect(isMediaGridFeed(`author|${DID}|posts_with_media`)).toBe(true)
    expect(isMediaGridFeed(`author|${DID}|posts_with_video`)).toBe(false)
    expect(isMediaGridFeed(`author|${DID}|posts_and_author_threads`)).toBe(
      false,
    )
    expect(isMediaGridFeed(`likes|${DID}`)).toBe(false)
    expect(isMediaGridFeed(undefined)).toBe(false)
  })

  it('3 tiles to a row on a phone, 4 from 800px', () => {
    expect(mediaGridColumns(false)).toBe(3)
    expect(mediaGridColumns(true)).toBe(4)
  })
})

describe('gridMediaOf', () => {
  it('images: the first thumbnail and the count', () => {
    expect(gridMediaOf(imagesView(3))).toEqual({
      kind: 'image',
      thumb: 'https://cdn.test/thumb1.jpg',
      alt: 'alt 1',
      count: 3,
    })
  })

  it('a gallery counts its image items only', () => {
    expect(
      gridMediaOf({
        $type: 'app.bsky.embed.gallery#view',
        items: [
          {$type: 'app.bsky.embed.gallery#viewOther'},
          {
            $type: 'app.bsky.embed.gallery#viewImage',
            thumbnail: 'https://cdn.test/g.jpg',
            fullsize: 'https://cdn.test/gf.jpg',
            alt: 'g',
          },
        ],
      }),
    ).toEqual({
      kind: 'image',
      thumb: 'https://cdn.test/g.jpg',
      alt: 'g',
      count: 1,
    })
  })

  it('a quote with media uses its media; a video has one item', () => {
    expect(
      gridMediaOf({
        $type: 'app.bsky.embed.recordWithMedia#view',
        record: {},
        media: imagesView(1),
      })?.count,
    ).toBe(1)
    expect(
      gridMediaOf({
        $type: 'app.bsky.embed.video#view',
        cid: 'bafy',
        playlist: 'https://video.test/p.m3u8',
        thumbnail: 'https://video.test/t.jpg',
      }),
    ).toEqual({
      kind: 'video',
      thumb: 'https://video.test/t.jpg',
      alt: '',
      count: 1,
    })
  })

  it('a post without media has no tile', () => {
    expect(hasGridMedia({embed: undefined})).toBe(false)
    expect(
      hasGridMedia({
        embed: {$type: 'app.bsky.embed.external#view', external: {}},
      }),
    ).toBe(false)
  })
})

describe('MediaGridRow', () => {
  it('a tap opens the post; several images show the stack mark', () => {
    const {getAllByTestId, queryAllByTestId} = renderRow([
      item(post({embed: imagesView(2)})),
    ])
    const [link] = getAllByTestId('link')
    expect(link.props.nativeID).toBe('/profile/author.test/post/3kpublic')
    expect(queryAllByTestId('mediaGridStack')).toHaveLength(1)
    expect(queryAllByTestId('mediaGridPrivateLock')).toHaveLength(0)
  })

  it('one image has no stack mark', () => {
    const {queryAllByTestId} = renderRow([item(post({embed: imagesView(1)}))])
    expect(queryAllByTestId('mediaGridStack')).toHaveLength(0)
  })

  it('a private post has the corner lock and opens its ppost path', () => {
    const {getAllByTestId, queryAllByTestId} = renderRow([
      item(post({uri: PRIVATE_URI, embed: imagesView(1)})),
    ])
    expect(queryAllByTestId('mediaGridPrivateLock')).toHaveLength(1)
    expect(getAllByTestId('link')[0].props.nativeID).toBe(
      '/profile/author.test/ppost/3kprivate',
    )
  })

  it('spoiler media stays blurred; other media is sharp', () => {
    const flagged = post({
      embed: imagesView(1),
      record: {
        $type: 'app.bsky.feed.post',
        text: 'x',
        createdAt: '',
        embed: {
          $type: 'app.bsky.embed.images',
          images: [{alt: '', image: {}, [MEDIA_SPOILER_FIELD]: true}],
        },
      },
    })
    const plain = post({uri: `${PUBLIC_URI}2`, embed: imagesView(1)})
    const {getAllByTestId} = renderRow([item(flagged), item(plain)])
    const [blurred, sharp] = getAllByTestId('thumb')
    expect(blurred.props.nativeID).toBe(
      `https://cdn.test/thumb1.jpg|${MEDIA_SPOILER_BLUR_RADIUS}`,
    )
    expect(sharp.props.nativeID).toBe('https://cdn.test/thumb1.jpg|0')
  })

  it('a short last row keeps its tiles the size of a full row', () => {
    mockGtMobile = true
    const {toJSON} = renderRow([item(post({embed: imagesView(1)}))])
    const json = JSON.stringify(toJSON())
    expect(json).toContain('"width":"25%"')
  })
})
