import {describe, expect, it, jest} from '@jest/globals'

import {withoutCoveredImages, withoutCoveredLightboxImages} from '../lightbox'
import {
  mediaItemKeys,
  mediaSpoilerState,
  type MediaView,
  shownFlags,
} from '../read'

function lightbox(index: number, onIndexChange?: (i: number) => void) {
  return {
    images: ['a', 'b', 'c', 'd'],
    index,
    metricsContext: undefined,
    onIndexChange,
  }
}

describe('withoutCoveredLightboxImages (T8)', () => {
  it('returns the argument when nothing is covered', () => {
    const arg = lightbox(1)
    expect(withoutCoveredLightboxImages([true, true, true, true], arg)).toBe(
      arg,
    )
    expect(withoutCoveredLightboxImages(undefined, arg)).toBe(arg)
    expect(withoutCoveredImages(undefined, arg)).toBe(arg)
  })

  it('keeps the shown images and remaps the index', () => {
    const result = withoutCoveredLightboxImages(
      [true, false, true, false],
      lightbox(2),
    )
    expect(result?.images).toEqual(['a', 'c'])
    expect(result?.index).toBe(1)
  })

  it('maps onIndexChange back to the original index', () => {
    const onIndexChange = jest.fn<(i: number) => void>()
    const result = withoutCoveredLightboxImages(
      [false, true, false, true],
      lightbox(3, onIndexChange),
    )
    result?.onIndexChange?.(0)
    result?.onIndexChange?.(1)
    expect(onIndexChange.mock.calls).toEqual([[1], [3]])
  })

  it('opens nothing for a covered pressed image, or when all are covered', () => {
    expect(
      withoutCoveredLightboxImages([true, false, true, true], lightbox(1)),
    ).toBeUndefined()
    expect(
      withoutCoveredLightboxImages([false, false, false, false], lightbox(0)),
    ).toBeUndefined()
  })

  it('fails closed when the flags do not match the images', () => {
    expect(withoutCoveredLightboxImages([true, false], lightbox(0))).toBe(
      undefined,
    )
  })

  it('reads the scope', () => {
    const scope = {revealedFlags: () => [true, false, true, true]}
    expect(withoutCoveredImages(scope, lightbox(0))?.images).toEqual([
      'a',
      'c',
      'd',
    ])
  })
})

describe('reveals keyed by thumbnail (T8)', () => {
  function view(thumbs: string[]): MediaView {
    return {
      $type: 'app.bsky.embed.images#view',
      images: thumbs.map(thumb => ({
        thumb,
        fullsize: thumb + '/full',
        alt: '',
      })),
    } as MediaView
  }
  function record(flags: boolean[]) {
    return {
      embed: {
        $type: 'app.bsky.embed.images',
        images: flags.map(flag =>
          flag ? {alt: '', 'app.nearhorizon.spoiler': true} : {alt: ''},
        ),
      },
    }
  }

  it('keeps each reveal on its image when the view is rebuilt in another order', () => {
    const revealed = new Set(['t2'])
    const first = view(['t1', 't2', 't3'])
    const firstState = mediaSpoilerState(record([true, true, false]), first)
    expect(
      shownFlags(firstState.flags, mediaItemKeys(first), revealed),
    ).toEqual([false, true, true])

    const rebuilt = view(['t2', 't3', 't1'])
    const rebuiltState = mediaSpoilerState(record([true, false, true]), rebuilt)
    expect(
      shownFlags(rebuiltState.flags, mediaItemKeys(rebuilt), revealed),
    ).toEqual([true, true, false])
  })

  it('keys a video by its thumbnail, else its playlist', () => {
    const withThumb = {
      $type: 'app.bsky.embed.video#view',
      cid: 'c',
      playlist: 'https://v/p.m3u8',
      thumbnail: 'https://v/thumb.jpg',
    } as MediaView
    const withoutThumb = {
      $type: 'app.bsky.embed.video#view',
      cid: 'c',
      playlist: 'https://v/p.m3u8',
    } as MediaView
    expect(mediaItemKeys(withThumb)).toEqual(['https://v/thumb.jpg'])
    expect(mediaItemKeys(withoutThumb)).toEqual(['https://v/p.m3u8'])
  })
})
