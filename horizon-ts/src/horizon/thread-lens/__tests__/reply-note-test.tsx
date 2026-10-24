import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The composer note end to end (Phase 4 design 8.5, TL-19, hook TH-10; live
 * check 17): a raw lens answer with a `blocking-you` gap goes through the
 * read (`runLens`) into the thread's lens entry, and the note the composer
 * mounts under the reply-to preview reads it: shown for a reply below the
 * gap, not for a reply to the root.
 */

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'member',
  reportPrismError: () => {},
  isPrivateMember: () => false,
}))
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({atoms: new Proxy({}, {get: () => ({})})}),
}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<{children?: React.ReactNode}>
  }>('react-native')
  return {
    Text: (props: {children?: React.ReactNode}) => (
      <Text>{props.children}</Text>
    ),
  }
})

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {type QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, render} from '@testing-library/react-native'

import {resetPrismFeatures} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {resetLensRefusals, resetLensWaits} from '#/horizon/thread-lens/api'
import {runLens} from '#/horizon/thread-lens/fetch'
import {resetLensViewPool} from '#/horizon/thread-lens/public-views'
import {resetLensRegistry} from '#/horizon/thread-lens/registry'
import {ThreadLensReplyNote} from '#/horizon/thread-lens/ReplyNote'
import {
  type LensKeyParams,
  lensQueryKey,
  resetLensQueues,
} from '#/horizon/thread-lens/snapshot'
import {
  BLOCKED,
  gapNode,
  lensAnswer,
  postNode,
  publishClients,
  READER,
  server,
  uriOf,
  view,
} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const NOTE =
  'Someone earlier in this thread has blocked you, so they won’t see your reply.'

const ROOT = uriOf('3kroot2222222')
const B1 = uriOf('3kb1222222222', BLOCKED)
const C1 = uriOf('3kc1222222222')
const D1 = uriOf('3kd1222222222')

function keyOf(anchor: string, params: Partial<LensKeyParams> = {}) {
  return lensQueryKey({
    did: READER,
    anchor,
    depth: 10,
    mode: 'lens',
    marked: false,
    ...params,
  })
}

/** Thread 1 of 14.2, as prism answers M: R, the gap B1, C1 under it, D1. */
function setup(blockingYou = true) {
  const root = view('3kroot2222222', {replyCount: 1})
  const c1 = view('3kc1222222222', {parent: B1, root: ROOT, replyCount: 1})
  const d1 = view('3kd1222222222', {parent: C1, root: ROOT})
  const posts = [root, c1, d1]
  const prism = server(READER, call => {
    if (call.nsid !== 'app.nearhorizon.threadLens.getThread') return undefined
    return lensAnswer((call.body?.anchor as string) ?? ROOT, [
      postNode(root),
      gapNode(B1, blockingYou ? 'blocking-you' : 'blocked-by-you', {
        parentUri: ROOT,
      }),
      postNode(c1),
      postNode(d1),
    ])
  })
  const appview = server(READER, call => {
    if (call.nsid !== 'app.bsky.feed.getPosts') return undefined
    const wanted = call.params.getAll('uris')
    return {
      status: 200,
      body: {posts: posts.filter(post => wanted.includes(post.uri))},
    }
  })
  return publishClients({prism: prism.client, appview: appview.client})
}

/** The thread screen's read: the lens entry, as the thread query writes it. */
async function readThread(qc: QueryClient, anchor = ROOT) {
  const key = keyOf(anchor)
  const run = await runLens(key, {
    qc,
    stockKey: ['post-thread-v2', {anchor}],
    readWith: {sort: 'oldest', below: 10},
  })
  qc.setQueryData(key, run.data)
}

/** The composer's note for a reply to `uri`, as `Composer.tsx` mounts it. */
function renderNote(qc: QueryClient, uri: string) {
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider i18n={i18n}>
        <ThreadLensReplyNote replyTo={{uri}} />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  resetPrismHealth()
  resetPrismFeatures()
  resetLensWaits()
  resetLensRefusals()
  resetLensRegistry()
  resetLensQueues()
  resetLensViewPool()
})

describe('the composer note, from the thread’s lens state (8.5)', () => {
  it('shows for a reply to D1, below the blocking-you gap B1', async () => {
    const qc = setup()
    await readThread(qc)
    expect(renderNote(qc, D1).getByText(NOTE)).toBeTruthy()
    // C1, directly under the gap, too.
    expect(renderNote(qc, C1).getByText(NOTE)).toBeTruthy()
  })

  it('shows nothing for a reply to the root', async () => {
    const qc = setup()
    await readThread(qc)
    expect(renderNote(qc, ROOT).queryByText(NOTE)).toBeNull()
  })

  it('shows from D1’s own screen, whose parents hold the gap', async () => {
    const qc = setup()
    await readThread(qc, D1)
    expect(renderNote(qc, D1).getByText(NOTE)).toBeTruthy()
  })

  it('shows nothing below a blocked-by-you gap', async () => {
    const qc = setup(false)
    await readThread(qc)
    expect(renderNote(qc, D1).queryByText(NOTE)).toBeNull()
  })

  it('appears when the lens entry lands with the composer open', async () => {
    const qc = setup()
    const screen = renderNote(qc, D1)
    expect(screen.queryByText(NOTE)).toBeNull()
    await act(async () => {
      await readThread(qc)
    })
    expect(screen.getByText(NOTE)).toBeTruthy()
  })
})
