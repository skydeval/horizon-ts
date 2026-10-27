import {describe, expect, it, jest} from '@jest/globals'

/*
 * A private post whose author has a self-label without `cts` (2026-10-27):
 * prism builds a self-label's `cts` from the labelled record's `createdAt`,
 * and a profile record with none gives a label without it. Horizon's check
 * used to require it through the strict `profileViewBasic`, so the post was
 * dropped: a reply's parent became the audience stand-in, and a list answer
 * holding one such post failed whole. Fixtures only.
 */

jest.unmock('multiformats/cid')
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  subscribeMembership: () => () => {},
  isPrivateMember: () => true,
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

import {privatePostView} from '#/horizon/lexicons/nearhorizon'
import {toTreeNode} from '#/horizon/private/thread/fetch'

const JANE = 'did:plc:jjjjjjjjjjjjjjjjjjjjjjjj'
const OWNER = 'did:web:owner.example.com'
const PARENT = `at://${JANE}/tools.kryphocron.feed.postPrivate/3kaaaaaaaaaa2`
const ANCHOR = `at://${OWNER}/tools.kryphocron.feed.postPrivate/3kaaaaaaaaab2`
const AUDIENCE = `at://${OWNER}/tools.kryphocron.policy.audience/3kaaaaaaaaac2`

/** The author as prism builds it from a profile record with no `createdAt`. */
function janeAuthor() {
  return {
    did: JANE,
    handle: 'jane.example.com',
    displayName: 'Jane Example',
    avatar: `https://cdn.bsky.app/img/avatar/plain/${JANE}/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@jpeg`,
    viewer: {muted: false, blockedBy: false},
    labels: [
      {
        src: JANE,
        uri: `at://${JANE}/app.bsky.actor.profile/self`,
        val: '!no-unauthenticated',
      },
    ],
  }
}

function view(uri: string, author: unknown, parent?: string) {
  return {
    uri,
    cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
    author,
    record: {
      $type: 'tools.kryphocron.feed.postPrivate',
      text: 'a reply',
      createdAt: '2026-10-22T16:06:00.000Z',
      audienceList: AUDIENCE,
      ...(parent
        ? {
            reply: {
              root: {
                uri: parent,
                cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
              },
              parent: {
                uri: parent,
                cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
              },
            },
          }
        : {}),
    },
    indexedAt: '2026-10-22T16:06:01.000Z',
    labels: [],
  }
}

describe('a private post whose author label has no cts', () => {
  it('passes the view check, author fields kept', () => {
    const value: unknown = view(PARENT, janeAuthor())
    if (!privatePostView.matches(value)) throw new Error('view refused')
    expect(value.author.displayName).toBe('Jane Example')
  })

  it('stays in the thread as a node', () => {
    const node = toTreeNode({post: view(PARENT, janeAuthor()), replies: []})
    expect(node?.input.view.uri).toBe(PARENT)
  })

  it('a post label without cts passes too', () => {
    const value = {
      ...view(PARENT, janeAuthor()),
      labels: [{src: JANE, uri: PARENT, val: 'nudity'}],
    }
    expect(privatePostView.matches(value)).toBe(true)
  })

  it('still refuses a view with no author DID or a bad URI', () => {
    expect(
      privatePostView.matches(view(PARENT, {handle: 'jane.example.com'})),
    ).toBe(false)
    expect(privatePostView.matches(view('not a uri', janeAuthor()))).toBe(false)
    expect(
      privatePostView.matches({...view(ANCHOR, janeAuthor()), labels: 'x'}),
    ).toBe(false)
  })
})
