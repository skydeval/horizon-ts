import {describe, expect, it, jest} from '@jest/globals'

import {
  buildFeedCard,
  buildListCard,
  buildStarterPackCard,
  type CollectionCard,
  collectionContent,
  decodeCollectionStatusId,
  encodeCollectionStatusId,
  toMastodonCollectionStatus,
} from '../collection'
import {
  handleCollectionPage,
  handleStatus,
  type PagesContext,
} from '../handlers'
import {decodeProfileStatusId, encodeProfileStatusId} from '../profile'
import {decodeStatusId, encodeStatusId} from '../status'

/*
 * List, custom feed and starter pack link cards: a Horizon link to one in
 * Discord shows the owner, the name, description and facts, and its
 * pictures. Synthetic fixtures; the network is a fake.
 */

const DID = 'did:plc:wrenaaaaaaaaaaaaaaaaaaaa'
const RKEY = '3mlistaaaaaa2'
const ORIGIN = 'https://horizon-preview2.pages.dev'
const LIST_URL = `${ORIGIN}/profile/wren.example/lists/${RKEY}`
const DISCORD =
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const FIREFOX =
  'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'

const creator = {
  did: DID,
  handle: 'wren.example',
  displayName: 'Wren',
  avatar: 'https://cdn.example/avatar',
  labels: [] as unknown[],
}

function list(over: Record<string, unknown> = {}) {
  return {
    uri: `at://${DID}/app.bsky.graph.list/${RKEY}`,
    cid: 'bafy',
    name: 'Birders',
    purpose: 'app.bsky.graph.defs#curatelist',
    description: 'People & <birds>\nsecond line',
    avatar: 'https://cdn.example/list-avatar',
    listItemCount: 1234,
    indexedAt: '2026-11-01T00:00:00.000Z',
    labels: [],
    creator,
    ...over,
  }
}

function feed(over: Record<string, unknown> = {}) {
  return {
    uri: `at://${DID}/app.bsky.feed.generator/${RKEY}`,
    cid: 'bafy',
    did: 'did:web:feeds.example',
    displayName: 'Bird Watch',
    description: 'Only birds',
    avatar: 'https://cdn.example/feed-avatar',
    likeCount: 1,
    indexedAt: '2026-11-01T00:00:00.000Z',
    labels: [],
    creator,
    ...over,
  }
}

function member(n: number, labels: unknown[] = []) {
  return {
    uri: `at://${DID}/app.bsky.graph.listitem/${n}`,
    subject: {
      did: `did:plc:member${n}`,
      handle: `m${n}.example`,
      displayName: `Member ${n}`,
      avatar: `https://cdn.example/m${n}`,
      labels,
    },
  }
}

function pack(over: Record<string, unknown> = {}) {
  return {
    uri: `at://${DID}/app.bsky.graph.starterpack/${RKEY}`,
    cid: 'bafy',
    record: {
      $type: 'app.bsky.graph.starterpack',
      name: 'Bird people',
      description: 'Start here',
      list: `at://${DID}/app.bsky.graph.list/x`,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    creator,
    list: {listItemCount: 50},
    listItemsSample: [
      member(1),
      member(2, [{val: 'porn'}]),
      member(3),
      member(4),
      member(5),
      member(6),
    ],
    feeds: [{}, {}],
    joinedAllTimeCount: 1200,
    labels: [],
    indexedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function shown(card: ReturnType<typeof buildListCard>): CollectionCard {
  if (card.kind !== 'collection') throw new Error('not a card')
  return card
}

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

function network(views: {list?: unknown; feed?: unknown; pack?: unknown}) {
  const calls: string[] = []
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: {'content-type': 'application/json'},
    })
  const answer = (key: string, view: unknown) =>
    Promise.resolve(
      view ? json({[key]: view}) : new Response('', {status: 400}),
    )
  const fetchImpl = jest.fn((url: string) => {
    calls.push(url)
    if (url.includes('resolveHandle')) return Promise.resolve(json({did: DID}))
    if (url.includes('getList?')) return answer('list', views.list)
    if (url.includes('getFeedGenerator?')) return answer('view', views.feed)
    if (url.includes('getStarterPack?')) {
      return answer('starterPack', views.pack)
    }
    if (url.startsWith('https://plc.directory/')) {
      return Promise.resolve(
        json({
          service: [
            {id: '#atproto_pds', serviceEndpoint: 'https://pds.example'},
          ],
        }),
      )
    }
    if (url.includes('getRecord')) {
      return Promise.resolve(json({value: {sets: [{forms: ['she', 'they']}]}}))
    }
    return Promise.resolve(new Response('not found', {status: 404}))
  })
  return {calls, fetchImpl}
}

describe('the cards', () => {
  it('a list holds the name, owner, description, kind, size and picture', () => {
    const card = shown(
      buildListCard({list: list(), url: LIST_URL, pronouns: 'she/they'}),
    )
    expect(card).toMatchObject({
      type: 'list',
      name: 'Birders',
      facts: 'List · 1,234 people',
      images: [{url: 'https://cdn.example/list-avatar'}],
    })
    expect(card.author).toMatchObject({
      handle: 'wren.example',
      displayName: 'Wren',
      pronouns: 'she/they',
    })
    const html = collectionContent(card)
    expect(html).toContain('<b>Birders</b>')
    expect(html).toContain('People &amp; &lt;birds&gt;<br>second line')
    expect(html).toContain('📋 List · 1,234 people')
  })

  it('a moderation list says so, and leaves out a count it wasn’t given', () => {
    const card = shown(
      buildListCard({
        list: list({
          purpose: 'app.bsky.graph.defs#modlist',
          listItemCount: undefined,
        }),
        url: LIST_URL,
      }),
    )
    expect(card.facts).toBe('Moderation list')
  })

  it('a feed holds its name, likes and picture', () => {
    const card = shown(buildFeedCard({feed: feed(), url: 'u'}))
    expect(card).toMatchObject({
      type: 'feed',
      name: 'Bird Watch',
      description: 'Only birds',
      facts: 'Feed · 1 like',
      images: [{url: 'https://cdn.example/feed-avatar'}],
    })
  })

  it('a starter pack holds its facts and its first members, never adult ones', () => {
    const card = shown(buildStarterPackCard({pack: pack(), url: 'u'}))
    expect(card).toMatchObject({
      type: 'starter-pack',
      name: 'Bird people',
      description: 'Start here',
      facts: 'Starter pack · 50 people · 2 feeds · 1,200 joined',
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    expect(card.images.map(image => image.url)).toEqual([
      'https://cdn.example/m1',
      'https://cdn.example/m3',
      'https://cdn.example/m4',
      'https://cdn.example/m5',
    ])
    expect(collectionContent(card)).toContain('🎒')
  })

  it('leaves out adult images, the record’s or the owner’s', () => {
    const adultOwner = {creator: {...creator, labels: [{val: 'sexual'}]}}
    for (const card of [
      buildListCard({list: list({labels: [{val: 'porn'}]}), url: 'u'}),
      buildListCard({list: list(adultOwner), url: 'u'}),
      buildFeedCard({feed: feed({labels: [{val: 'nudity'}]}), url: 'u'}),
      buildStarterPackCard({pack: pack(adultOwner), url: 'u'}),
    ].map(shown)) {
      expect(card.images).toEqual([])
      expect(card.author.avatar).toBeUndefined()
      expect(collectionContent(card)).toContain('Images hidden')
    }
  })

  it('is the missing card without a record', () => {
    expect(buildListCard({list: undefined, url: 'u'}).kind).toBe(
      'missing-collection',
    )
    expect(buildFeedCard({feed: {}, url: 'u'}).kind).toBe('missing-collection')
    expect(buildStarterPackCard({pack: null, url: 'u'}).kind).toBe(
      'missing-collection',
    )
  })

  it('becomes a Mastodon status: the owner as the account, the pictures as media', () => {
    const card = shown(buildStarterPackCard({pack: pack(), url: 'u'}))
    const status = toMastodonCollectionStatus(card, {id: 'x', origin: ORIGIN})
    expect(status.account).toMatchObject({
      display_name: 'Wren',
      acct: 'wren.example',
      avatar: 'https://cdn.example/avatar',
      url: `${ORIGIN}/profile/wren.example`,
    })
    expect(status.media_attachments).toHaveLength(4)
  })

  it('has status ids of their own, never read as a post’s or profile’s', () => {
    for (const type of ['list', 'feed', 'starter-pack'] as const) {
      const id = encodeCollectionStatusId(type, DID, RKEY)
      expect(decodeCollectionStatusId(id)).toEqual({type, did: DID, rkey: RKEY})
      expect(decodeStatusId(id)).toBeUndefined()
      expect(decodeProfileStatusId(id)).toBeUndefined()
    }
    expect(decodeCollectionStatusId(encodeStatusId(DID, RKEY))).toBeUndefined()
    expect(decodeCollectionStatusId(encodeProfileStatusId(DID))).toBeUndefined()
  })
})

describe('the handlers', () => {
  const params = {name: 'wren.example', rkey: RKEY}
  const views = {list: list(), feed: feed(), pack: pack()}

  it('a browser gets the app, with nothing fetched', async () => {
    const net = network(views)
    const c = ctx(`/profile/wren.example/lists/${RKEY}`, FIREFOX, params)
    expect(
      await (await handleCollectionPage('list', c, net.fetchImpl)).text(),
    ).toBe('the app')
    expect(net.calls).toEqual([])
  })

  it('Discord gets each card page, with the picture and the alternate link', async () => {
    const cases = [
      {
        type: 'list',
        path: `/profile/wren.example/lists/${RKEY}`,
        title: 'Birders – by Wren · she/they (@wren.example)',
        image: 'https://cdn.example/list-avatar',
      },
      {
        type: 'feed',
        path: `/profile/wren.example/feed/${RKEY}`,
        title: 'Bird Watch – by Wren · she/they (@wren.example)',
        image: 'https://cdn.example/feed-avatar',
      },
      {
        type: 'starter-pack',
        path: `/starter-pack/wren.example/${RKEY}`,
        title: 'Bird people – by Wren · she/they (@wren.example)',
        image: 'https://cdn.example/m1',
      },
    ] as const
    for (const {type, path, title, image} of cases) {
      const net = network(views)
      const c = ctx(path, DISCORD, params)
      const html = await (
        await handleCollectionPage(type, c, net.fetchImpl)
      ).text()
      expect(c.next).not.toHaveBeenCalled()
      expect(html).toContain(`<meta property="og:title" content="${title}">`)
      expect(html).toContain(`og:image" content="${image}"`)
      expect(html).toContain(`og:url" content="${ORIGIN}${path}"`)
      const id = encodeCollectionStatusId(type, DID, RKEY)
      expect(html).toContain(
        `href="${ORIGIN}/users/wren.example/statuses/${id}"`,
      )
    }
  })

  it('the status answers for each, linking back to its page', async () => {
    const cases = [
      ['list', `${ORIGIN}/profile/wren.example/lists/${RKEY}`, '1,234 people'],
      ['feed', `${ORIGIN}/profile/wren.example/feed/${RKEY}`, '1 like'],
      [
        'starter-pack',
        `${ORIGIN}/starter-pack/wren.example/${RKEY}`,
        '50 people',
      ],
    ] as const
    for (const [type, url, fact] of cases) {
      const net = network(views)
      const id = encodeCollectionStatusId(type, DID, RKEY)
      const res = await handleStatus(
        ctx(`/api/v1/statuses/${id}`, DISCORD, {id}),
        net.fetchImpl,
      )
      expect(res.status).toBe(200)
      const status = (await res.json()) as {url: string; content: string}
      expect(status.url).toBe(url)
      expect(status.content).toContain(fact)
    }
  })

  it('an unknown or taken-down record gets the not-found card', async () => {
    const net = network({})
    for (const [type, words] of [
      ['list', 'List not found'],
      ['feed', 'Feed not found'],
      ['starter-pack', 'Starter pack not found'],
    ] as const) {
      const c = ctx('/x', DISCORD, params)
      const html = await (
        await handleCollectionPage(type, c, net.fetchImpl)
      ).text()
      expect(html).toContain(words)
      expect(html).not.toContain('application/activity+json')
    }
  })
})
