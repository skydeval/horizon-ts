import {describe, expect, it, jest} from '@jest/globals'

import {handleProfilePage, handleStatus, type PagesContext} from '../handlers'
import {
  buildProfileCard,
  countsLine,
  decodeProfileStatusId,
  encodeProfileStatusId,
  type ProfileCard,
  profileContent,
  toMastodonProfileStatus,
} from '../profile'
import {decodeStatusId, encodeStatusId} from '../status'

/*
 * Profile link cards: a Horizon profile link in Discord shows the avatar,
 * name and pronouns, the bio, the counts, and the banner. Synthetic
 * fixtures; the network is a fake.
 */

const DID = 'did:plc:wrenaaaaaaaaaaaaaaaaaaaa'
const ORIGIN = 'https://horizon-preview2.pages.dev'
const URL_ = `${ORIGIN}/profile/wren.example`
const DISCORD =
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const FIREFOX =
  'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'

function profile(over: Record<string, unknown> = {}) {
  return {
    did: DID,
    handle: 'wren.example',
    displayName: 'Wren',
    description: 'Birds & <code>\nsecond line',
    avatar: 'https://cdn.example/avatar',
    banner: 'https://cdn.example/banner',
    followersCount: 1234,
    followsCount: 56,
    postsCount: 1,
    createdAt: '2024-01-02T00:00:00.000Z',
    labels: [],
    ...over,
  }
}

function asProfile(card: ReturnType<typeof buildProfileCard>): ProfileCard {
  if (card.kind !== 'profile') throw new Error('not a profile card')
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

function network(view: unknown = profile()) {
  const calls: string[] = []
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: {'content-type': 'application/json'},
    })
  const fetchImpl = jest.fn((url: string) => {
    calls.push(url)
    if (url.includes('resolveHandle')) return Promise.resolve(json({did: DID}))
    if (url.includes('getProfile')) {
      return Promise.resolve(
        view ? json(view) : new Response('', {status: 400}),
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

describe('the profile card', () => {
  it('holds the name, pronouns, bio, counts, avatar and banner', () => {
    const card = asProfile(
      buildProfileCard({profile: profile(), url: URL_, pronouns: 'she/they'}),
    )
    expect(card.author).toMatchObject({
      handle: 'wren.example',
      displayName: 'Wren',
      pronouns: 'she/they',
      avatar: 'https://cdn.example/avatar',
      banner: 'https://cdn.example/banner',
    })
    expect(countsLine(card.counts)).toBe(
      '1,234 followers · 56 following · 1 post',
    )
    const html = profileContent(card)
    expect(html).toContain('Birds &amp; &lt;code&gt;<br>second line')
    expect(html).toContain('👥 1,234 followers · 56 following · 1 post')
  })

  it('falls back to Bluesky’s pronouns field, and leaves out adult images', () => {
    const card = asProfile(
      buildProfileCard({
        profile: profile({
          pronouns: 'he/him',
          labels: [{val: 'porn'}],
        }),
        url: URL_,
      }),
    )
    expect(card.author.pronouns).toBe('he/him')
    expect(card.author.avatar).toBeUndefined()
    expect(card.author.banner).toBeUndefined()
    expect(profileContent(card)).toContain('Images hidden')
  })

  it('is the missing card without a profile', () => {
    expect(buildProfileCard({profile: undefined, url: URL_}).kind).toBe(
      'missing-profile',
    )
  })

  it('becomes a Mastodon status: the profile as the account, the banner as the image', () => {
    const card = asProfile(buildProfileCard({profile: profile(), url: URL_}))
    const status = toMastodonProfileStatus(card, {id: 'x', origin: ORIGIN})
    expect(status.account).toMatchObject({
      display_name: 'Wren',
      acct: 'wren.example',
      avatar: 'https://cdn.example/avatar',
      followers_count: 1234,
      following_count: 56,
      statuses_count: 1,
    })
    expect(status.media_attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        url: 'https://cdn.example/banner',
      }),
    ])
  })

  it('has a status id of its own, never read as a post’s', () => {
    const id = encodeProfileStatusId(DID)
    expect(decodeProfileStatusId(id)).toBe(DID)
    expect(decodeStatusId(id)).toBeUndefined()
    expect(decodeProfileStatusId(encodeStatusId(DID, '3kpost'))).toBeUndefined()
  })
})

describe('the profile handlers', () => {
  it('a browser gets the app, with nothing fetched', async () => {
    const net = network()
    const c = ctx('/profile/wren.example', FIREFOX, {name: 'wren.example'})
    expect(await (await handleProfilePage(c, net.fetchImpl)).text()).toBe(
      'the app',
    )
    expect(net.calls).toEqual([])
  })

  it('Discord gets the card page, with the banner and the alternate link', async () => {
    const net = network()
    const c = ctx('/profile/wren.example', DISCORD, {name: 'wren.example'})
    const html = await (await handleProfilePage(c, net.fetchImpl)).text()
    expect(c.next).not.toHaveBeenCalled()
    expect(html).toContain(
      '<meta property="og:title" content="Wren · she/they (@wren.example)">',
    )
    expect(html).toContain('og:image" content="https://cdn.example/banner"')
    expect(html).toContain('summary_large_image')
    const id = encodeProfileStatusId(DID)
    expect(html).toContain(`href="${ORIGIN}/users/wren.example/statuses/${id}"`)
  })

  it('the status answers for a profile', async () => {
    const net = network()
    const id = encodeProfileStatusId(DID)
    const res = await handleStatus(
      ctx(`/api/v1/statuses/${id}`, DISCORD, {id}),
      net.fetchImpl,
    )
    expect(res.status).toBe(200)
    const status = (await res.json()) as {url: string; content: string}
    expect(status.url).toBe(`${ORIGIN}/profile/wren.example`)
    expect(status.content).toContain('1,234 followers')
  })

  it('an unknown profile gets the not-found card', async () => {
    const net = network(null)
    const c = ctx('/profile/wren.example', DISCORD, {name: 'wren.example'})
    const html = await (await handleProfilePage(c, net.fetchImpl)).text()
    expect(html).toContain('Profile not found')
    expect(html).not.toContain('application/activity+json')
  })
})
