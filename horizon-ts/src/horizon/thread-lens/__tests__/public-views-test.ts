import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {moderatePost} from '@bsky/sdk/moderation'

import {
  checkLensNodes,
  EMPTY_BASE,
  postUrisToRead,
} from '#/horizon/thread-lens/nodes'
import {readPublicViews} from '#/horizon/thread-lens/public-views'
import {type app} from '#/lexicons'
import {
  BLOCKED,
  fakeAppview,
  gapNode,
  MODERATION_OPTS,
  postNode,
  privateUriOf,
  READER,
  RECORD_CID,
  uriOf,
  view,
} from './harness'

type PostView = app.bsky.feed.defs.PostView

const ANCHOR = uriOf('3kanchor22222')
const LIST_OWNER = 'did:plc:listownerfffffffffffffff'
const LIST = {
  uri: `at://${LIST_OWNER}/app.bsky.graph.list/3klist2222222`,
  cid: RECORD_CID,
  name: 'A list',
  purpose: 'app.bsky.graph.defs#modlist',
}
const BLOCK_URI = `at://${READER}/app.bsky.graph.block/3kblock222222`
/** The fixtures' label source, the labeler the `!warn` check subscribes to. */
const LABELER = 'did:plc:labelereeeeeeeeeeeeeeeee'

async function pass(raw: unknown[], posts: PostView[], fail = false) {
  const appview = fakeAppview({posts, fail: () => fail})
  const checked = checkLensNodes(raw)
  const uris = postUrisToRead(EMPTY_BASE, checked)
  const outcomes = await readPublicViews(appview.client, checked, uris)
  const asked = appview.calls
    .filter(call => call.nsid === 'app.bsky.feed.getPosts')
    .map(call => call.params.getAll('uris'))
  return {outcomes, asked}
}

const RESTORED = {community: 'A community', tier: 1}

/** prism's view of a post Bluesky's AppView withholds, marked restored. */
function restoredView(rkey: string, restored: unknown = RESTORED) {
  return view(rkey, {
    labels: [{val: 'community-label'}],
    likeCount: 7,
    extra: {restored},
  })
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('the public-view pass (6)', () => {
  it('reads public post nodes only, never a gap, private or embedded URI', async () => {
    const quoted = uriOf('3kquoted22222')
    const withQuote = view('3kanchor22222', {
      extra: {
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: {
            $type: 'app.bsky.embed.record#viewNotFound',
            uri: quoted,
            notFound: true,
          },
        },
      },
    })
    const reply = view('3kreply222222', {parent: ANCHOR})
    const priv = privateUriOf('3kpriv222222')
    const {asked} = await pass(
      [
        postNode(withQuote),
        postNode(reply),
        gapNode(uriOf('3kgap22222222', BLOCKED), 'blocking-you'),
        {uri: priv, post: {uri: priv}},
      ],
      [withQuote, reply],
    )
    expect(asked).toEqual([[ANCHOR, reply.uri]])
  })

  it('asks 25 at a time', async () => {
    const views = Array.from({length: 30}, (_, i) =>
      view(`3kmany${String(i).padStart(3, '0')}2222`),
    )
    const {asked, outcomes} = await pass(
      views.map(v => postNode(v)),
      views,
    )
    expect(asked.map(batch => batch.length)).toEqual([25, 5])
    expect(outcomes.size).toBe(30)
  })

  it('renders the public view, with its labels, for a post it returns', async () => {
    const prismView = view('3kanchor22222', {likeCount: 1})
    const publicView = view('3kanchor22222', {
      likeCount: 4,
      labels: [{val: '!warn'}],
    })
    const {outcomes} = await pass([postNode(prismView)], [publicView])
    const outcome = outcomes.get(ANCHOR)
    expect(outcome?.kind).toBe('view')
    const shown = outcome?.kind === 'view' ? outcome.view : undefined
    expect(shown?.likeCount).toBe(4)
    // Bluesky's warning applies through stock moderation (TL-23).
    const moderation = moderatePost(shown!, {
      ...MODERATION_OPTS,
      prefs: {
        ...MODERATION_OPTS.prefs,
        labelers: [{did: LABELER, labels: {}}],
      },
    })
    expect(moderation.ui('contentView').blur).toBe(true)
  })

  it('makes a post the AppView leaves out content-stripped', async () => {
    const {outcomes} = await pass([postNode(view('3kanchor22222'))], [])
    expect(outcomes.get(ANCHOR)).toEqual({
      kind: 'gap',
      gap: 'content-stripped',
    })
  })

  it.each([
    [{blockingByList: LIST, blocking: BLOCK_URI}, 'blocked-by-you', true],
    [{blocking: BLOCK_URI}, 'blocked-by-you', false],
    [{blockedBy: true}, 'blocking-you', false],
  ])(
    'makes a block flag %j the %s gap',
    async (authorViewer, gap, withList) => {
      const publicView = view('3kanchor22222', {authorViewer})
      const {outcomes} = await pass(
        [postNode(view('3kanchor22222'))],
        [publicView],
      )
      expect(outcomes.get(ANCHOR)).toMatchObject({kind: 'gap', gap})
      const outcome = outcomes.get(ANCHOR) as {list?: {uri: string}}
      expect(outcome.list?.uri).toBe(withList ? LIST.uri : undefined)
    },
  )

  it('fails the read when a batch fails (strict, R1-L4)', async () => {
    await expect(
      pass([postNode(view('3kanchor22222'))], [], true),
    ).rejects.toBeTruthy()
  })
})

describe('restored posts (6.3, S-15)', () => {
  it.each([
    ['without a labeler', RESTORED],
    ['with a labeler', {...RESTORED, tier: 2, labeler: 'did:plc:labeler'}],
  ])(
    'renders from prism view when the AppView leaves it out (%s)',
    async (_, restored) => {
      const prismView = restoredView('3kanchor22222', restored)
      const {outcomes, asked} = await pass([postNode(prismView)], [])
      expect(asked).toEqual([[ANCHOR]])
      const outcome = outcomes.get(ANCHOR)
      expect(outcome?.kind).toBe('restored')
      const shown = outcome?.kind === 'restored' ? outcome.view : undefined
      expect(shown?.likeCount).toBe(7)
      expect(shown?.labels?.map(label => label.val)).toEqual([
        'community-label',
      ])
      expect(shown?.record).toEqual(prismView.record)
    },
  )

  it.each(['!takedown', '!hide'])(
    'renders from prism view over Bluesky %s',
    async val => {
      const publicView = view('3kanchor22222', {labels: [{val}]})
      const {outcomes} = await pass(
        [postNode(restoredView('3kanchor22222'))],
        [publicView],
      )
      expect(outcomes.get(ANCHOR)?.kind).toBe('restored')
    },
  )

  it.each([
    [{blockingByList: LIST}, 'blocked-by-you'],
    [{blocking: BLOCK_URI}, 'blocked-by-you'],
    [{blockedBy: true}, 'blocking-you'],
  ])('still gives a block gap for %j', async (authorViewer, gap) => {
    const publicView = view('3kanchor22222', {authorViewer})
    const {outcomes} = await pass(
      [postNode(restoredView('3kanchor22222'))],
      [publicView],
    )
    expect(outcomes.get(ANCHOR)).toMatchObject({kind: 'gap', gap})
  })

  it.each([
    ['no marker', undefined],
    ['true', true],
    ['a string', 'restored'],
    ['no community', {tier: 1}],
    ['a non-string community', {community: 3, tier: 1}],
    ['tier 0', {community: 'c', tier: 0}],
    ['tier 3', {community: 'c', tier: 3}],
    ['tier "1"', {community: 'c', tier: '1'}],
  ])('treats %s as today: content-stripped', async (_, restored) => {
    const prismView = view('3kanchor22222', {
      extra: restored === undefined ? {} : {restored},
    })
    const {outcomes} = await pass([postNode(prismView)], [])
    expect(outcomes.get(ANCHOR)).toEqual({
      kind: 'gap',
      gap: 'content-stripped',
    })
  })

  it('handles a marked private URI as today, never asking for it', async () => {
    const priv = privateUriOf('3kpriv222222')
    const {asked, outcomes} = await pass(
      [{uri: priv, post: {uri: priv, restored: RESTORED}}],
      [],
    )
    expect(asked).toEqual([])
    expect(outcomes.size).toBe(0)
  })

  it('still fails the read on a failed batch', async () => {
    await expect(
      pass([postNode(restoredView('3kanchor22222'))], [], true),
    ).rejects.toBeTruthy()
  })
})
