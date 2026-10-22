import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render, within} from '@testing-library/react-native'

type ReactTestInstance = ReturnType<ReturnType<typeof render>['getByTestId']>

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

// A link renders its children and exposes where it goes and its label.
jest.mock('#/components/Link', () => {
  const {View} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    Link: ({
      to,
      label,
      children,
    }: {
      to: string
      label: string
      children: React.ReactNode
    }) => (
      <View
        testID="link"
        nativeID={to}
        accessibilityLabel={label}
        accessibilityHint="">
        {children}
      </View>
    ),
  }
})

/*
 * No moderation blur by default: the content shows; the mask is not drawn.
 * `mockHidden` flips it to the mask only.
 */
let mockHidden = false
jest.mock('#/components/moderation/Hider', () => ({
  Outer: ({children}: {children: React.ReactNode}) => <>{children}</>,
  Mask: ({children}: {children: React.ReactNode}) =>
    mockHidden ? <>{children}</> : null,
  Content: ({children}: {children: React.ReactNode}) =>
    mockHidden ? null : <>{children}</>,
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
  mockHidden = false
})

const videoView = (thumbnail?: string) => ({
  $type: 'app.bsky.embed.video#view',
  cid: 'bafy',
  playlist: 'https://video.test/p.m3u8',
  ...(thumbnail ? {thumbnail} : {}),
})

function flatStyle(node: {props: {style?: unknown}}): Record<string, unknown> {
  const {StyleSheet} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<
    string,
    unknown
  >
}

/** The testIDs of the corner row's marks, left to right. */
function cornerOrder(row: ReactTestInstance) {
  const marks = ['mediaGridStack', 'mediaGridPlay', 'mediaGridPrivateLock']
  return row
    .findAll(n => typeof n.type === 'string' && marks.includes(n.props.testID))
    .map(n => n.props.testID as string)
}

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

  it('the lock sits in the top-right row on a dark backing, no shadow', () => {
    const {getByTestId} = renderRow([
      item(post({uri: PRIVATE_URI, embed: imagesView(1)})),
    ])
    const row = getByTestId('mediaGridCornerMarks')
    expect(flatStyle(row)).toMatchObject({top: 6, right: 6})
    expect(flatStyle(row).left).toBeUndefined()
    expect(row.props.pointerEvents).toBe('none')
    const lock = within(row).getByTestId('mediaGridPrivateLock')
    const lockStyle = flatStyle(lock)
    expect(lockStyle.backgroundColor).toBeDefined()
    expect(lockStyle.backgroundColor).not.toBe('transparent')
    expect(lockStyle.borderRadius).toBe(4)
    expect(lockStyle.shadowColor).toBeUndefined()
    expect(lockStyle.position).toBeUndefined()
    expect(lock.props.accessible).toBe(false)
    expect(cornerOrder(row)).toEqual(['mediaGridPrivateLock'])
  })

  it('private with two images: stack, then the lock outermost', () => {
    const {getByTestId} = renderRow([
      item(post({uri: PRIVATE_URI, embed: imagesView(2)})),
    ])
    const row = getByTestId('mediaGridCornerMarks')
    expect(cornerOrder(row)).toEqual(['mediaGridStack', 'mediaGridPrivateLock'])
    expect(
      flatStyle(within(row).getByTestId('mediaGridStack')).backgroundColor,
    ).toBe('rgba(0, 0, 0, 0.5)')
  })

  it('private video with a thumbnail: play, then the lock', () => {
    const {getByTestId} = renderRow([
      item(
        post({uri: PRIVATE_URI, embed: videoView('https://video.test/t.jpg')}),
      ),
    ])
    const row = getByTestId('mediaGridCornerMarks')
    expect(cornerOrder(row)).toEqual(['mediaGridPlay', 'mediaGridPrivateLock'])
    expect(
      flatStyle(within(row).getByTestId('mediaGridPlay')).backgroundColor,
    ).toBe('rgba(0, 0, 0, 0.5)')
  })

  it('private video without a thumbnail: the lock only', () => {
    const {getByTestId} = renderRow([
      item(post({uri: PRIVATE_URI, embed: videoView()})),
    ])
    expect(cornerOrder(getByTestId('mediaGridCornerMarks'))).toEqual([
      'mediaGridPrivateLock',
    ])
  })

  it('a public image has no corner row', () => {
    const {queryAllByTestId} = renderRow([item(post({embed: imagesView(1)}))])
    expect(queryAllByTestId('mediaGridCornerMarks')).toHaveLength(0)
  })

  it('a hidden private post: the mask shows the lock top right', () => {
    mockHidden = true
    const {getByTestId, queryAllByTestId} = renderRow([
      item(post({uri: PRIVATE_URI, embed: imagesView(2)})),
    ])
    const row = getByTestId('mediaGridCornerMarks')
    expect(flatStyle(row)).toMatchObject({top: 6, right: 6})
    expect(cornerOrder(row)).toEqual(['mediaGridPrivateLock'])
    expect(queryAllByTestId('mediaGridStack')).toHaveLength(0)
  })

  it('private tile labels start with “Private”; public ones do not', () => {
    const label = (p: ReturnType<typeof post>) =>
      renderRow([item(p)]).getByTestId('link').props.accessibilityLabel
    const video = videoView('https://video.test/t.jpg')
    expect(label(post({uri: PRIVATE_URI, embed: imagesView(1)}))).toBe(
      'Private image post from author.test',
    )
    expect(label(post({uri: PRIVATE_URI, embed: imagesView(3)}))).toBe(
      'Private post from author.test with 3 images',
    )
    expect(label(post({uri: PRIVATE_URI, embed: video}))).toBe(
      'Private video post from author.test',
    )
    expect(label(post({embed: imagesView(1)}))).toBe(
      'Image post from author.test',
    )
    expect(label(post({embed: imagesView(3)}))).toBe(
      'Post from author.test with 3 images',
    )
    expect(label(post({embed: video}))).toBe('Video post from author.test')
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
