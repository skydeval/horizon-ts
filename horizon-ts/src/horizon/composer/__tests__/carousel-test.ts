import {describe, expect, it, jest} from '@jest/globals'

/*
 * The composer's Gallery / Carousel choice: Carousel turns 2 to 4 images into
 * a gallery, the choice survives adding and removing images, a single image
 * is never a gallery, and Gallery turns it back into the usual images.
 */

jest.mock('#/state/gallery', () => ({
  createInitialImages: jest.fn(),
}))
jest.mock('#/logger', () => ({
  logger: {warn: jest.fn()},
}))
jest.mock('#/state/queries/postgate/util', () => ({
  createPostgateRecord: jest.fn(() => ({})),
}))
jest.mock('#/state/queries/threadgate', () => ({
  threadgateRecordToAllowUISetting: jest.fn(() => []),
}))

import {type ComposerImage} from '#/state/gallery'
import {
  composerReducer,
  type ComposerState,
  createComposerState,
} from '#/view/com/composer/state/composer'

function image(id: string): ComposerImage {
  return {
    alt: '',
    source: {
      id,
      path: `file:///${id}.jpg`,
      width: 10,
      height: 10,
      mime: 'image/jpeg',
    },
  }
}

function start(): ComposerState {
  return createComposerState({
    initText: undefined,
    initMention: undefined,
    initImageUris: undefined,
    initQuoteUri: undefined,
    initInteractionSettings: undefined,
  })
}

function post(
  state: ComposerState,
  postAction: Parameters<typeof composerReducer>[1] extends infer A
    ? A extends {type: 'update_post'; postAction: infer P}
      ? P
      : never
    : never,
) {
  return composerReducer(state, {
    type: 'update_post',
    postId: state.thread.posts[0].id,
    postAction,
  })
}

function media(state: ComposerState) {
  return state.thread.posts[0].embed.media
}

describe('Gallery or Carousel', () => {
  it('Carousel sends 2 images as a gallery, Gallery turns it back', () => {
    let state = post(start(), {
      type: 'embed_add_images',
      images: [image('a'), image('b')],
    })
    expect(media(state)?.type).toBe('images')

    state = post(state, {type: 'embed_set_carousel', carousel: true})
    expect(media(state)).toMatchObject({type: 'gallery', carousel: true})

    state = post(state, {type: 'embed_set_carousel', carousel: false})
    expect(media(state)?.type).toBe('images')
  })

  it('keeps the choice when images are added or removed', () => {
    let state = post(start(), {
      type: 'embed_add_images',
      images: [image('a'), image('b')],
    })
    state = post(state, {type: 'embed_set_carousel', carousel: true})
    state = post(state, {type: 'embed_add_images', images: [image('c')]})
    expect(media(state)).toMatchObject({type: 'gallery', carousel: true})

    state = post(state, {type: 'embed_remove_image', image: image('c')})
    expect(media(state)).toMatchObject({type: 'gallery', carousel: true})
  })

  it('a single image is never a gallery', () => {
    let state = post(start(), {
      type: 'embed_add_images',
      images: [image('a'), image('b')],
    })
    state = post(state, {type: 'embed_set_carousel', carousel: true})
    state = post(state, {type: 'embed_remove_image', image: image('b')})
    expect(media(state)?.type).toBe('images')
  })
})
