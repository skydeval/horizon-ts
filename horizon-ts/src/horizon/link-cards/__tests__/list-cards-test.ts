import {describe, expect, it, jest} from '@jest/globals'

import {handleListPage, handleStatus, type PagesContext} from '../handlers'
import {
  buildListCard,
  decodeListStatusId,
  encodeListStatusId,
  type ListCard,
  listContent,
  listLine,
  toMastodonListStatus,
} from '../list'
import {decodeProfileStatusId, encodeProfileStatusId} from '../profile'
import {decodeStatusId, encodeStatusId} from '../status'

/*
 * List link cards: a Horizon list link in Discord shows the owner, the
 * list's name, description, kind and size, and its picture. Synthetic
 * fixtures; the network is a fake.
 */

const DID = 'did:plc:wrenaaaaaaaaaaaaaaaaaaaa'
const RKEY = '3mlistaaaaaa2'
const ORIGIN = 'https://horizon-preview2.pages.dev'
const URL_ = `${ORIGIN}/profile/wren.example/lists/${RKEY}`
const DISCORD =
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const FIREFOX =
  'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'

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
    creator: {
      did: DID,
      handle: 'wren.example',
      displayName: 'Wren',
      avatar: 'https://cdn.example/avatar',
      labels: [],
    },
    ...over,
  }
}

function asList(card: ReturnType<typeof buildListCard>): ListCard {
  if (card.kind !== 'list') throw new Error('not a list card')
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

function network(view: unknown = list()) {
  const calls: string[] = []
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: {'content-type': 'application/json'},
    })
  const fetchImpl = jest.fn((url: string) => {
    calls.push(url)
    if (url.includes('resolveHandle')) return Promise.resolve(json({did: DID}))
    if (url.includes('getList')) {
      return Promise.resolve(
        view ? json({list: view, items: []}) : new Response('', {status: 400}),
      )
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

describe('the list card', () => {
  it('holds the name, owner, description, kind, size and picture', () => {
    const card = asList(
      buildListCard({list: list(), url: URL_, pronouns: 'she/they'}),
    )
    expect(card).toMatchObject({
      name: 'Birders',
      listKind: 'curated',
      memberCount: 1234,
      avatar: 'https://cdn.example/list-avatar',
    })
    expect(card.author).toMatchObject({
      handle: 'wren.example',
      displayName: 'Wren',
      pronouns: 'she/they',
    })
    expect(listLine(card)).toBe('List · 1,234 people')
    const html = listContent(card)
    expect(html).toContain('<b>Birders</b>')
    expect(html).toContain('People &amp; &lt;birds&gt;<br>second line')
    expect(html).toContain('📋 List · 1,234 people')
  })

  it('names moderation lists, and leaves out the count it wasn’t given', () => {
    const card = asList(
      buildListCard({
        list: list({
          purpose: 'app.bsky.graph.defs#modlist',
          listItemCount: undefined,
        }),
        url: URL_,
      }),
    )
    expect(listLine(card)).toBe('Moderation list')
  })

  it('leaves out adult images, the list’s or the owner’s', () => {
    for (const over of [
      {labels: [{val: 'porn'}]},
      {creator: {...list().creator, labels: [{val: 'sexual'}]}},
    ]) {
      const card = asList(buildListCard({list: list(over), url: URL_}))
      expect(card.avatar).toBeUndefined()
      expect(card.author.avatar).toBeUndefined()
      expect(listContent(card)).toContain('Images hidden')
    }
  })

  it('is the missing card without a list', () => {
    expect(buildListCard({list: undefined, url: URL_}).kind).toBe(
      'missing-list',
    )
  })

  it('becomes a Mastodon status: the owner as the account, the picture as the image', () => {
    const card = asList(buildListCard({list: list(), url: URL_}))
    const status = toMastodonListStatus(card, {id: 'x', origin: ORIGIN})
    expect(status.account).toMatchObject({
      display_name: 'Wren',
      acct: 'wren.example',
      avatar: 'https://cdn.example/avatar',
    })
    expect(status.media_attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        url: 'https://cdn.example/list-avatar',
      }),
    ])
  })

  it('has a status id of its own, never read as a post’s or profile’s', () => {
    const id = encodeListStatusId(DID, RKEY)
    expect(decodeListStatusId(id)).toEqual({did: DID, rkey: RKEY})
    expect(decodeStatusId(id)).toBeUndefined()
    expect(decodeProfileStatusId(id)).toBeUndefined()
    expect(decodeListStatusId(encodeStatusId(DID, RKEY))).toBeUndefined()
    expect(decodeListStatusId(encodeProfileStatusId(DID))).toBeUndefined()
  })
})

describe('the list handlers', () => {
  const path = `/profile/wren.example/lists/${RKEY}`
  const params = {name: 'wren.example', rkey: RKEY}

  it('a browser gets the app, with nothing fetched', async () => {
    const net = network()
    const c = ctx(path, FIREFOX, params)
    expect(await (await handleListPage(c, net.fetchImpl)).text()).toBe(
      'the app',
    )
    expect(net.calls).toEqual([])
  })

  it('Discord gets the card page, with the picture and the alternate link', async () => {
    const net = network()
    const c = ctx(path, DISCORD, params)
    const html = await (await handleListPage(c, net.fetchImpl)).text()
    expect(c.next).not.toHaveBeenCalled()
    expect(html).toContain(
      '<meta property="og:title" content="Birders – by Wren · she/they (@wren.example)">',
    )
    expect(html).toContain('og:image" content="https://cdn.example/list-avatar"')
    const id = encodeListStatusId(DID, RKEY)
    expect(html).toContain(`href="${ORIGIN}/users/wren.example/statuses/${id}"`)
  })

  it('the status answers for a list', async () => {
    const net = network()
    const id = encodeListStatusId(DID, RKEY)
    const res = await handleStatus(
      ctx(`/api/v1/statuses/${id}`, DISCORD, {id}),
      net.fetchImpl,
    )
    expect(res.status).toBe(200)
    const status = (await res.json()) as {url: string; content: string}
    expect(status.url).toBe(URL_)
    expect(status.content).toContain('1,234 people')
  })

  it('an unknown or taken-down list gets the not-found card', async () => {
    const net = network(null)
    const c = ctx(path, DISCORD, params)
    const html = await (await handleListPage(c, net.fetchImpl)).text()
    expect(html).toContain('List not found')
    expect(html).not.toContain('application/activity+json')
  })
})
