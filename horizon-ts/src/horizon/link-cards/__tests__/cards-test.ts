import {describe, expect, it, jest} from '@jest/globals'

import {formatPronounRecord} from '../fetch'
import {
  handlePostPage,
  handlePrivatePostPage,
  handleStatus,
  type PagesContext,
} from '../handlers'
import {isLinkFetcher, linkCardPage} from '../page'
import {
  buildPostCard,
  decodeStatusId,
  encodeStatusId,
  maskSpoilers,
  type PostCard,
  statusContent,
  toMastodonStatus,
} from '../status'

/*
 * Link cards (skydeval, 2026-10-27): style D for public posts, the hidden
 * card for kryphocron posts. Nothing hidden in Horizon reaches a card.
 */

const DID = 'did:plc:wrenaaaaaaaaaaaaaaaaaaaa'
const URI = `at://${DID}/app.bsky.feed.post/3mytuuvegrc2q`
const ORIGIN = 'https://horizon-preview2.pages.dev'
const URL_ = `${ORIGIN}/profile/wren.example/post/3mytuuvegrc2q`

function image(n: number, extra: Record<string, unknown> = {}) {
  return {
    view: {
      thumb: `https://cdn.example/thumb/${n}`,
      fullsize: `https://cdn.example/full/${n}`,
      alt: `photo ${n}`,
      aspectRatio: {width: 4, height: 3},
    },
    record: {alt: `photo ${n}`, ...extra},
  }
}

function post({
  text = 'first warm morning in weeks',
  facets,
  labels = [],
  selfLabels,
  embed,
  recordEmbed,
  reply,
  authorLabels = [],
}: {
  text?: string
  facets?: unknown[]
  labels?: string[]
  selfLabels?: string[]
  embed?: unknown
  recordEmbed?: unknown
  reply?: boolean
  authorLabels?: string[]
} = {}) {
  return {
    post: {
      uri: URI,
      author: {
        did: DID,
        handle: 'wren.example',
        displayName: 'Wren',
        avatar: 'https://cdn.example/avatar',
        labels: authorLabels.map(val => ({val, src: DID})),
      },
      record: {
        $type: 'app.bsky.feed.post',
        text,
        facets,
        createdAt: '2026-10-27T15:09:00.000Z',
        langs: ['en'],
        ...(reply
          ? {reply: {parent: {uri: 'at://x/p/1'}, root: {uri: 'at://x/p/1'}}}
          : {}),
        ...(selfLabels
          ? {
              labels: {
                $type: 'com.atproto.label.defs#selfLabels',
                values: selfLabels.map(val => ({val})),
              },
            }
          : {}),
        ...(recordEmbed ? {embed: recordEmbed} : {}),
      },
      embed,
      labels: labels.map(val => ({val})),
      replyCount: 4,
      repostCount: 10,
      quoteCount: 2,
      likeCount: 87,
      indexedAt: '2026-10-27T15:09:01.000Z',
    },
    parent: reply
      ? {post: {author: {did: 'did:plc:robin', handle: 'robin.example'}}}
      : undefined,
  }
}

function images(items: ReturnType<typeof image>[]) {
  return {
    embed: {
      $type: 'app.bsky.embed.images#view',
      images: items.map(item => item.view),
    },
    recordEmbed: {
      $type: 'app.bsky.embed.images',
      images: items.map(item => item.record),
    },
  }
}

function asPost(card: ReturnType<typeof buildPostCard>): PostCard {
  if (card.kind !== 'post') throw new Error(`expected a post card: ${card.kind}`)
  return card
}

describe('the post card', () => {
  it('names the author with pronouns, the reply, the counts and the images', () => {
    const card = asPost(
      buildPostCard({
        thread: post({reply: true, ...images([image(1), image(2)])}),
        url: URL_,
        pronouns: 'she/they',
      }),
    )
    const status = toMastodonStatus(card, {id: 'abc', origin: ORIGIN})
    const account = status.account as Record<string, unknown>
    expect(account.display_name).toBe('Wren · she/they')
    expect(account.acct).toBe('wren.example')
    expect(status.content).toContain('↳ replying to @robin.example')
    expect(status.content).toContain('first warm morning in weeks')
    expect(status.content).toContain('💬 4   🔁 12   ❤️ 87')
    const media = status.media_attachments as Record<string, unknown>[]
    expect(media.map(m => m.url)).toEqual([
      'https://cdn.example/full/1',
      'https://cdn.example/full/2',
    ])
    expect(media[0].description).toBe('photo 1')
    expect((status.application as {name: string}).name).toBe('Horizon')
  })

  it('shows at most four images', () => {
    const card = asPost(
      buildPostCard({
        thread: post(images([1, 2, 3, 4, 5].map(n => image(n)))),
        url: URL_,
      }),
    )
    expect(card.media).toHaveLength(4)
  })

  it('a content warning shows only its line: no text, no media', () => {
    const card = asPost(
      buildPostCard({
        thread: post({
          text: 'spiders\n||a very large spider photo||',
          selfLabels: ['app.nearhorizon.cw'],
          ...images([image(1)]),
        }),
        url: URL_,
      }),
    )
    expect(card.contentWarning).toBe('spiders')
    expect(card.text).toBe('')
    expect(card.media).toEqual([])
    const html = statusContent(card)
    expect(html).toContain('⚠️ spiders')
    expect(html).not.toContain('large spider')
  })

  it('masks spoilers by their facets, emoji before them included', () => {
    const text = '🐝 the ending: he was a ghost all along'
    const before = new TextEncoder().encode('🐝 the ending: ').length
    const facets = [
      {
        index: {byteStart: before, byteEnd: new TextEncoder().encode(text).length},
        features: [{$type: 'app.nearhorizon.richtext.facet#spoiler'}],
      },
    ]
    expect(maskSpoilers(text, facets)).toBe('🐝 the ending: ▒▒▒')
    const card = asPost(buildPostCard({thread: post({text, facets}), url: URL_}))
    expect(statusContent(card)).not.toContain('ghost')
  })

  it('leaves out media flagged as a spoiler, and says so', () => {
    const card = asPost(
      buildPostCard({
        thread: post(
          images([image(1), image(2, {'app.nearhorizon.spoiler': true})]),
        ),
        url: URL_,
      }),
    )
    expect(card.media.map(m => m.url)).toEqual(['https://cdn.example/full/1'])
    expect(card.mediaNote).toBe('1 item hidden as a spoiler.')
  })

  it('leaves out adult-labelled media, and says so', () => {
    const card = asPost(
      buildPostCard({
        thread: post({labels: ['porn'], ...images([image(1)])}),
        url: URL_,
      }),
    )
    expect(card.media).toEqual([])
    expect(card.mediaNote).toBe('Media hidden: marked as adult content.')
  })

  it('shows a signed-in-only author’s post in full, as bsky.app does', () => {
    // skydeval, 2026-10-27: cards show regardless of the sign-in setting
    const card = asPost(
      buildPostCard({
        thread: post({authorLabels: ['!no-unauthenticated']}),
        url: URL_,
      }),
    )
    const page = linkCardPage(card, ORIGIN)
    expect(page).toContain('Wren')
    expect(page).toContain('first warm')
  })

  it('plays a video from the author’s repo, and shows a Tenor GIF', () => {
    const video = asPost(
      buildPostCard({
        thread: post({
          embed: {
            $type: 'app.bsky.embed.video#view',
            cid: 'bafyvideo',
            thumbnail: 'https://video.example/thumb.jpg',
            playlist: 'https://video.example/playlist.m3u8',
            aspectRatio: {width: 16, height: 9},
          },
        }),
        url: URL_,
        videoUrl: cid => `https://pds.example/blob/${cid}`,
      }),
    )
    expect(video.media).toEqual([
      expect.objectContaining({
        type: 'video',
        url: 'https://pds.example/blob/bafyvideo',
        previewUrl: 'https://video.example/thumb.jpg',
      }),
    ])
    const gif = asPost(
      buildPostCard({
        thread: post({
          embed: {
            $type: 'app.bsky.embed.external#view',
            external: {
              uri: 'https://media.tenor.com/abc/bees.gif?hh=200&ww=300',
              title: 'bees',
              description: 'Alt: bees dancing',
            },
          },
        }),
        url: URL_,
      }),
    )
    expect(gif.media[0]).toEqual(
      expect.objectContaining({type: 'image', width: 300, height: 200}),
    )
  })

  it('a missing post gives the not-found card', () => {
    expect(buildPostCard({thread: undefined, url: URL_}).kind).toBe('missing')
  })
})

describe('status ids', () => {
  it('round-trip a DID and rkey, and refuse anything else', () => {
    const id = encodeStatusId(DID, '3mytuuvegrc2q')
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeStatusId(id)).toEqual({did: DID, rkey: '3mytuuvegrc2q'})
    expect(decodeStatusId('not!an!id')).toBeUndefined()
    expect(decodeStatusId(btoa('https://evil.example x'))).toBeUndefined()
  })
})

describe('pronouns', () => {
  it('read the record as stored: each set is {forms}', () => {
    // skydeval's record shape, 2026-10-27 (pronouns were missing on cards)
    const record = {
      $type: 'app.nearhorizon.actor.pronouns',
      sets: [{forms: ['it', 'its']}, {forms: ['she', 'her']}],
      displayMode: 'firstOnly',
    }
    expect(formatPronounRecord(record)).toBe('it/its')
    expect(formatPronounRecord({...record, displayMode: 'all'})).toBe(
      'it/its · she/her',
    )
  })

  it('follow the spec: a record breaking a limit shows nothing', () => {
    const set = (...forms: string[]) => ({forms})
    expect(formatPronounRecord({sets: [set(' ze ', 'zir')]})).toBe('ze/zir')
    expect(formatPronounRecord({sets: []})).toBeUndefined()
    expect(formatPronounRecord(undefined)).toBeUndefined()
    // Bare lists aren't sets in the spec.
    expect(formatPronounRecord({sets: [['she', 'her']]})).toBeUndefined()
    // A set needs 1 to 12 forms; at most 10 sets.
    expect(formatPronounRecord({sets: [set()]})).toBeUndefined()
    expect(
      formatPronounRecord({sets: [set(...Array(13).fill('x'))]}),
    ).toBeUndefined()
    expect(
      formatPronounRecord({sets: Array(11).fill(set('x'))}),
    ).toBeUndefined()
    // Over 24 graphemes, or over 240 bytes (24 flags are about 384), breaks it.
    expect(formatPronounRecord({sets: [set('a'.repeat(25))]})).toBeUndefined()
    expect(formatPronounRecord({sets: [set('🏳️‍⚧️'.repeat(24))]})).toBeUndefined()
    expect(formatPronounRecord({sets: [set('🏳️‍⚧️'.repeat(10))]})).toBe(
      '🏳️‍⚧️'.repeat(10),
    )
    expect(formatPronounRecord({sets: [set('ü'.repeat(24))]})).toBe(
      'ü'.repeat(24),
    )
    // Another collection's $type is not a pronouns record.
    expect(
      formatPronounRecord({$type: 'app.other.pronouns', sets: [set('she')]}),
    ).toBeUndefined()
  })
})

describe('who gets a card', () => {
  it('chat apps do; a browser does not', () => {
    expect(
      isLinkFetcher(
        'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      ),
    ).toBe(true)
    expect(isLinkFetcher('TelegramBot (like TwitterBot)')).toBe(true)
    expect(
      isLinkFetcher(
        'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
      ),
    ).toBe(false)
    expect(isLinkFetcher(undefined)).toBe(false)
  })
})

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const FIREFOX = 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'

function ctx(
  path: string,
  ua: string,
  params: Record<string, string>,
): PagesContext & {next: jest.Mock<() => Promise<Response>>} {
  return {
    request: new Request(`${ORIGIN}${path}`, {headers: {'user-agent': ua}}),
    params,
    next: jest.fn(() => Promise.resolve(new Response('the app'))),
  }
}

/** A fake network: the AppView, the PLC directory and the author's PDS. */
function network() {
  const calls: string[] = []
  const fetchImpl = jest.fn((url: string) => Promise.resolve(answer(url)))
  function answer(url: string): Response {
    calls.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: {'content-type': 'application/json'},
      })
    if (url.includes('resolveHandle')) return json({did: DID})
    if (url.includes('getPostThread')) {
      return json({thread: post(images([image(1)]))})
    }
    if (url.startsWith('https://plc.directory/')) {
      return json({
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example',
          },
        ],
      })
    }
    if (url.includes('getRecord')) {
      return json({value: {sets: [{forms: ['she', 'they']}]}})
    }
    return new Response('not found', {status: 404})
  }
  return {calls, fetchImpl}
}

describe('the handlers', () => {
  it('a browser gets the app; nothing is fetched', async () => {
    const net = network()
    const c = ctx('/profile/wren.example/post/3mytuuvegrc2q', FIREFOX, {
      name: 'wren.example',
      rkey: '3mytuuvegrc2q',
    })
    const res = await handlePostPage(c, net.fetchImpl)
    expect(await res.text()).toBe('the app')
    expect(net.calls).toEqual([])
  })

  it('Discord gets the card page, with the alternate link to the status', async () => {
    const net = network()
    const c = ctx('/profile/wren.example/post/3mytuuvegrc2q', DISCORD, {
      name: 'wren.example',
      rkey: '3mytuuvegrc2q',
    })
    const html = await (await handlePostPage(c, net.fetchImpl)).text()
    expect(c.next).not.toHaveBeenCalled()
    expect(html).toContain('<meta property="og:title" content="Wren · she/they (@wren.example)">')
    expect(html).toContain('og:image" content="https://cdn.example/full/1"')
    const id = encodeStatusId(DID, '3mytuuvegrc2q')
    expect(html).toContain(
      `href="${ORIGIN}/users/wren.example/statuses/${id}"`,
    )
  })

  it('a kryphocron post gets the hidden card, with nothing looked up', async () => {
    const c = ctx('/profile/wren.example/ppost/3mz4kqx2lmn2a', DISCORD, {
      name: 'wren.example',
      rkey: '3mz4kqx2lmn2a',
    })
    const spy = jest.spyOn(globalThis, 'fetch')
    const html = await (await handlePrivatePostPage(c)).text()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect(html).toContain('🔒 Private post')
    expect(html).toContain('Only the people it was shared with can see this.')
    expect(html).not.toContain('application/activity+json')
    // Only the link itself names the handle; no name, avatar or image.
    expect(html).not.toContain('Wren')
    expect(html).not.toContain('og:image')
  })

  it('the status answers Discord in the Mastodon shape', async () => {
    const net = network()
    const id = encodeStatusId(DID, '3mytuuvegrc2q')
    const c = ctx(`/api/v1/statuses/${id}`, DISCORD, {id})
    const res = await handleStatus(c, net.fetchImpl)
    expect(res.status).toBe(200)
    const status = (await res.json()) as Record<string, unknown>
    expect(status.id).toBe(id)
    expect(status.url).toBe(`${ORIGIN}/profile/wren.example/post/3mytuuvegrc2q`)
    expect((status.media_attachments as unknown[]).length).toBe(1)
  })

  it('a malformed status id is a 404 with no lookups', async () => {
    const net = network()
    const res = await handleStatus(
      ctx('/api/v1/statuses/zzz!', DISCORD, {id: 'zzz!'}),
      net.fetchImpl,
    )
    expect(res.status).toBe(404)
    expect(net.calls).toEqual([])
  })
})
