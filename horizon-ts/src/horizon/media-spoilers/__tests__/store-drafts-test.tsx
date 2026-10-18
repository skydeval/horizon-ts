import {type Client} from '@atproto/lex'
import {beforeEach, describe, expect, it} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import {type ComposerImage} from '#/state/gallery'
import {type PostDraft} from '#/view/com/composer/state/composer'
import {DID} from '#/horizon/private/__tests__/fixtures'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {
  bindRestoredVideoSpoiler,
  contentWarningOf,
  EMPTY_COMPOSE_SPOILERS,
  getComposeSpoilers,
  isImageFlagged,
  isVideoFlagged,
  replaceComposeSpoilers,
  setContentWarning,
  setImageSpoiler,
  setVideoSpoiler,
  takeCwFocus,
  useComposeSpoilerSession,
} from '../compose-store'
import {
  applyDraftSpoilers,
  MAX_DRAFT_SPOILER_ENTRIES,
  readDraftSpoilerTable,
  recordDraftSpoilers,
} from '../drafts'

const client = {} as Client

/*
 * As the stock edit helpers (`cropImage`, `manipulateImage`,
 * `resetImageManipulation` in `#/state/gallery`) rebuild an image: a new
 * object that copies `source`. The module itself loads the UI under Jest.
 */
function rebuilt(img: ComposerImage): ComposerImage {
  return {alt: img.alt, source: img.source}
}
const TABLE = `horizon:draft-spoilers:${DID}`

beforeEach(() => {
  writeLocal(TABLE, undefined)
  replaceComposeSpoilers(EMPTY_COMPOSE_SPOILERS)
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl: 'https://pds.example',
    pdsClient: client,
    prismClient: client,
    appviewClient: client,
  })
})

let nextId = 0
function image(): ComposerImage {
  nextId++
  return {
    alt: '',
    source: {
      id: `img-${nextId}`,
      path: `file:///img-${nextId}.jpg`,
      width: 4,
      height: 3,
      mime: 'image/jpeg',
    },
    transformed: {
      path: 'file:///t.png',
      width: 2,
      height: 2,
      mime: 'image/png',
    },
  }
}

function post(
  id: string,
  media?:
    | {type: 'images'; images: ComposerImage[]}
    | {type: 'video'; video: {abortController: AbortController}},
): PostDraft {
  return {
    id,
    richtext: {text: ''},
    labels: [],
    embed: {quote: undefined, link: undefined, media},
    shortenedGraphemeLength: 0,
  } as unknown as PostDraft
}

describe('the compose store (T7)', () => {
  it('an image flag survives an edit that rebuilds the image', () => {
    const img = image()
    setImageSpoiler(img.source.id, true)
    const edited = rebuilt(img)
    expect(edited).not.toBe(img)
    expect(isImageFlagged(getComposeSpoilers(), edited)).toBe(true)
    setImageSpoiler(img.source.id, false)
    expect(isImageFlagged(getComposeSpoilers(), edited)).toBe(false)
  })

  it('a new video controller is not flagged', () => {
    const first = {abortController: new AbortController()}
    setVideoSpoiler(first.abortController, true)
    expect(isVideoFlagged(getComposeSpoilers(), first)).toBe(true)
    expect(
      isVideoFlagged(getComposeSpoilers(), {
        abortController: new AbortController(),
      }),
    ).toBe(false)
  })

  it('every change replaces the snapshot', () => {
    const before = getComposeSpoilers()
    setContentWarning('p1', '')
    expect(getComposeSpoilers()).not.toBe(before)
    const after = getComposeSpoilers()
    setContentWarning('p1', '')
    expect(getComposeSpoilers()).toBe(after)
  })

  it('takeCwFocus is true once, only for the post the toggle named', () => {
    setContentWarning('p1', '')
    expect(takeCwFocus('p2')).toBe(false)
    expect(takeCwFocus('p1')).toBe(true)
    expect(takeCwFocus('p1')).toBe(false)
    setContentWarning('p1', 'cw blood')
    expect(takeCwFocus('p1')).toBe(false)
    setContentWarning('p1', undefined)
    expect(contentWarningOf(getComposeSpoilers(), 'p1')).toBeUndefined()
  })

  it('the session resets the snapshot on mount and unmount', () => {
    setImageSpoiler('stale', true)
    function Session() {
      useComposeSpoilerSession()
      return null
    }
    const view = render(<Session />)
    expect(getComposeSpoilers()).toBe(EMPTY_COMPOSE_SPOILERS)
    act(() => setImageSpoiler('a', true))
    view.unmount()
    expect(getComposeSpoilers()).toBe(EMPTY_COMPOSE_SPOILERS)
  })
})

describe('the draft spoiler table (T7)', () => {
  it('round trips flags, the CW and a pending video', () => {
    const a = image()
    const b = image()
    const controller = new AbortController()
    setImageSpoiler(b.source.id, true)
    setVideoSpoiler(controller, true)
    setContentWarning('draft-post-0', 'cw blood')
    recordDraftSpoilers('draft-1', [
      post('draft-post-0', {type: 'images', images: [a, b]}),
      post('draft-post-1', {
        type: 'video',
        video: {abortController: controller},
      }),
    ])
    expect(readDraftSpoilerTable(DID)).toEqual([
      {
        id: 'draft-1',
        posts: [
          {imageCount: 2, images: [1], video: false, cw: {line: 'cw blood'}},
          {imageCount: 0, images: [], video: true},
        ],
      },
    ])

    replaceComposeSpoilers(EMPTY_COMPOSE_SPOILERS)
    const ra = image()
    const rb = image()
    applyDraftSpoilers('draft-1', [
      post('draft-post-0', {type: 'images', images: [ra, rb]}),
      post('draft-post-1'),
    ])
    const snap = getComposeSpoilers()
    expect(isImageFlagged(snap, ra)).toBe(false)
    expect(isImageFlagged(snap, rb)).toBe(true)
    expect(contentWarningOf(snap, 'draft-post-0')).toEqual({line: 'cw blood'})
    expect(snap.pendingVideoPosts.has('draft-post-1')).toBe(true)
    expect(takeCwFocus('draft-post-0')).toBe(false)

    const restored = new AbortController()
    bindRestoredVideoSpoiler('draft-post-0', restored)
    expect(
      isVideoFlagged(getComposeSpoilers(), {abortController: restored}),
    ).toBe(false)
    bindRestoredVideoSpoiler('draft-post-1', restored)
    expect(
      isVideoFlagged(getComposeSpoilers(), {abortController: restored}),
    ).toBe(true)
    expect(getComposeSpoilers().pendingVideoPosts.size).toBe(0)
  })

  it('a pending video still counts as flagged when saved again', () => {
    replaceComposeSpoilers({
      ...EMPTY_COMPOSE_SPOILERS,
      pendingVideoPosts: new Set(['draft-post-0']),
    })
    recordDraftSpoilers('draft-1', [
      post('draft-post-0', {
        type: 'video',
        video: {abortController: new AbortController()},
      }),
    ])
    expect(readDraftSpoilerTable(DID)[0]?.posts[0]?.video).toBe(true)
  })

  it('a count mismatch flags every restored image of the post', () => {
    const a = image()
    setImageSpoiler(a.source.id, true)
    recordDraftSpoilers('draft-1', [
      post('draft-post-0', {type: 'images', images: [a, image(), image()]}),
    ])
    const r1 = image()
    const r2 = image()
    applyDraftSpoilers('draft-1', [
      post('draft-post-0', {type: 'images', images: [r1, r2]}),
    ])
    const snap = getComposeSpoilers()
    expect(isImageFlagged(snap, r1)).toBe(true)
    expect(isImageFlagged(snap, r2)).toBe(true)
  })

  it('an entry with nothing set is removed', () => {
    setContentWarning('draft-post-0', '')
    recordDraftSpoilers('draft-1', [post('draft-post-0')])
    expect(readDraftSpoilerTable(DID)).toHaveLength(1)
    replaceComposeSpoilers(EMPTY_COMPOSE_SPOILERS)
    recordDraftSpoilers('draft-1', [post('draft-post-0')])
    expect(readLocal(TABLE)).toBeUndefined()
  })

  it('keeps at most 200 entries, oldest dropped', () => {
    setContentWarning('draft-post-0', '')
    for (let i = 0; i <= MAX_DRAFT_SPOILER_ENTRIES; i++) {
      recordDraftSpoilers(`draft-${i}`, [post('draft-post-0')])
    }
    const table = readDraftSpoilerTable(DID)
    expect(table).toHaveLength(MAX_DRAFT_SPOILER_ENTRIES)
    expect(table[0]?.id).toBe('draft-1')
  })

  it('opening draft B after draft A leaves no CW and no pending video', () => {
    setContentWarning('draft-post-0', 'cw a')
    const controller = new AbortController()
    setVideoSpoiler(controller, true)
    recordDraftSpoilers('draft-a', [
      post('draft-post-0', {
        type: 'video',
        video: {abortController: controller},
      }),
    ])
    applyDraftSpoilers('draft-a', [post('draft-post-0')])
    expect(getComposeSpoilers().pendingVideoPosts.has('draft-post-0')).toBe(
      true,
    )
    applyDraftSpoilers('draft-b', [post('draft-post-0')])
    const snap = getComposeSpoilers()
    expect(contentWarningOf(snap, 'draft-post-0')).toBeUndefined()
    expect(snap.pendingVideoPosts.size).toBe(0)
    expect(snap.videos.size).toBe(0)
  })

  it('ignores malformed entries', () => {
    writeLocal(
      TABLE,
      JSON.stringify([
        {id: 'x', posts: [{imageCount: 'two'}]},
        {id: 'y', posts: [{imageCount: 0, images: [], video: false}]},
        'nonsense',
      ]),
    )
    expect(readDraftSpoilerTable(DID).map(e => e.id)).toEqual(['y'])
  })
})
