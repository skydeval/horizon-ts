import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The blocked-by-list row end to end (Phase 4 design 8.3, TL-18, P-10; live
 * check 16): a raw lens answer whose `blocked-by-you` gap carries
 * `blockingByListUri` goes through the read (`runLens`), the node map, the
 * stock-shaped answer (`select`), the row entry point and the real
 * `GapRow`, which names the list from the reader's own block lists and
 * links to its page.
 */

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  THREAD_LENS: true,
}))
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => 'not-member',
  reportPrismError: () => {},
  isPrivateMember: () => false,
}))
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))
let mockAppview: unknown
jest.mock('#/state/session', () => ({
  useSession: () => ({
    hasSession: true,
    currentAccount: {did: 'did:plc:readeraaaaaaaaaaaaaaaaaa'},
  }),
  useAppviewClient: () => mockAppview,
}))
jest.mock('#/horizon/private/membership', () => ({useIsMember: () => false}))
jest.mock('#/horizon/thread-lens/MarkerRow', () => ({MarkerRow: () => null}))
jest.mock('#/screens/PostThread/components/ThreadItemReadMore', () => ({
  ThreadItemReadMore: () => null,
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  tokens: {space: {lg: 16}},
  web: () => ({}),
  platform: () => ({}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({borderColor: '#000'})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
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
jest.mock('#/components/Button', () => {
  const {Text, View} = jest.requireActual<{
    Text: React.ComponentType<{children?: React.ReactNode}>
    View: React.ComponentType<{children?: React.ReactNode}>
  }>('react-native')
  return {
    Button: (props: {children?: React.ReactNode}) => (
      <View>{props.children}</View>
    ),
    ButtonText: (props: {children?: React.ReactNode}) => (
      <Text>{props.children}</Text>
    ),
    ButtonIcon: () => null,
  }
})
jest.mock('#/components/Link', () => {
  const {View} = jest.requireActual<{
    View: React.ComponentType<{
      children?: React.ReactNode
      testID?: string
      nativeID?: string
    }>
  }>('react-native')
  return {
    Link: (props: {children?: React.ReactNode; to: string; label: string}) => (
      <View testID={`link:${props.to}`} nativeID={props.label}>
        {props.children}
      </View>
    ),
  }
})
jest.mock('#/components/Loader', () => ({Loader: () => null}))
jest.mock('#/horizon/private/render/StandIn', () => ({StandIn: () => null}))
jest.mock('#/components/icons/CircleQuestion', () => ({
  CircleQuestion_Stroke2_Corner2_Rounded: () => null,
}))
jest.mock('#/components/icons/ExclamationCircle', () => ({
  ExclamationCircle_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/EyeSlash', () => ({
  EyeSlash_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Person', () => ({
  PersonX_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Trash', () => ({
  Trash_Stroke2_Corner0_Rounded: () => null,
}))

import {type ReactElement} from 'react'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {render, waitFor} from '@testing-library/react-native'

import {type ThreadItem} from '#/state/queries/usePostThread/types'
import {resetPrismFeatures} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {type LensSelected, selectLensAnswer} from '#/horizon/thread-lens/adapt'
import {resetLensRefusals, resetLensWaits} from '#/horizon/thread-lens/api'
import {runLens} from '#/horizon/thread-lens/fetch'
import {resetLensViewPool} from '#/horizon/thread-lens/public-views'
import {resetLensRegistry} from '#/horizon/thread-lens/registry'
import {renderThreadLensRow} from '#/horizon/thread-lens/rows'
import {
  lensQueryKey,
  resetLensQueues,
  snapshotOf,
} from '#/horizon/thread-lens/snapshot'
import {type app} from '#/lexicons'
import {
  BLOCKED,
  type Call,
  gapNode,
  lensAnswer,
  postNode,
  publishClients,
  READER,
  RECORD_CID,
  type Reply,
  server,
  uriOf,
  view,
} from './harness'

type PostView = app.bsky.feed.defs.PostView

i18n.loadAndActivate({locale: 'en', messages: {}})

const ROOT = uriOf('3kroot2222222')
const E1 = uriOf('3ke1222222222', BLOCKED)
const OWNER = 'did:plc:listownerffffffffffffffff'
const LIST = `at://${OWNER}/app.bsky.graph.list/3klist2222222`
const KEY = lensQueryKey({
  did: READER,
  anchor: ROOT,
  depth: 10,
  mode: 'lens',
  marked: false,
})

function listView(uri: string, name: string) {
  return {
    uri,
    cid: RECORD_CID,
    name,
    purpose: 'app.bsky.graph.defs#modlist',
    creator: {did: OWNER, handle: 'owner.test'},
    indexedAt: '2026-10-15T10:00:00.000Z',
  }
}

let appviewCalls: Call[]
/** prism's nodes after the root, when a test replaces the E1 gap. */
let mockPrismNodes: unknown[] | undefined
/** Public views beyond the root's. */
let mockExtraPosts: PostView[]

/**
 * Serve thread R with E1, a gap by `BLOCKED` under it, carrying `extra`
 * (prism's `blockingByListUri`). The AppView answers `getPosts` for R and
 * the reader's block lists and `getList` with `lists`.
 */
function setup({
  extra,
  blocks = () => ({status: 200, body: {lists: []}}),
  getList = () => ({status: 500, body: {error: 'InternalServerError'}}),
}: {
  extra: Record<string, unknown>
  blocks?: () => Reply
  getList?: (params: URLSearchParams) => Reply
}) {
  const root: PostView = view('3kroot2222222', {replyCount: 1})
  const prism = server(READER, call =>
    call.nsid === 'app.nearhorizon.threadLens.getThread'
      ? lensAnswer(ROOT, [
          postNode(root),
          ...(mockPrismNodes ?? [
            gapNode(E1, 'blocked-by-you', {parentUri: ROOT, ...extra}),
          ]),
        ])
      : undefined,
  )
  const appview = server(READER, call => {
    switch (call.nsid) {
      case 'app.bsky.feed.getPosts': {
        const wanted = call.params.getAll('uris')
        return {
          status: 200,
          body: {
            posts: [root, ...mockExtraPosts].filter(post =>
              wanted.includes(post.uri),
            ),
          },
        }
      }
      case 'app.bsky.graph.getListBlocks':
        return blocks()
      case 'app.bsky.graph.getList':
        return getList(call.params)
    }
    return undefined
  })
  appviewCalls = appview.calls
  mockAppview = appview.client
  return publishClients({prism: prism.client, appview: appview.client})
}

/** The gap row as the thread screen draws it, from the read's own answer. */
async function renderGapRow(qc: QueryClient) {
  const run = await runLens(KEY, {
    qc,
    stockKey: ['post-thread-v2', {anchor: ROOT}],
    readWith: {sort: 'oldest', below: 10},
  })
  qc.setQueryData(KEY, run.data)
  const answer = selectLensAnswer(run.data, {
    sort: 'oldest',
    view: 'linear',
    below: 10,
  }) as unknown as LensSelected
  const gapItem = answer.thread
    .filter(item => item.uri === E1)
    .map(
      item =>
        ({
          type: 'threadPost',
          key: item.uri,
          uri: item.uri,
          depth: item.depth,
          value: item.value,
          ui: {
            indent: 1,
            showParentReplyLine: true,
            showChildReplyLine: false,
            precedesChildReadMore: false,
            isLastChild: true,
            skippedIndentIndices: new Set<number>(),
          },
        }) as unknown as ThreadItem,
    )[0]
  const row = renderThreadLensRow(gapItem, {
    state: {lens: answer.lensState, view: 'linear'},
  }) as ReactElement
  return {
    snapshot: snapshotOf(run.data),
    screen: render(
      <QueryClientProvider client={qc}>
        <I18nProvider i18n={i18n}>{row}</I18nProvider>
      </QueryClientProvider>,
    ),
  }
}

beforeEach(() => {
  mockPrismNodes = undefined
  mockExtraPosts = []
  resetPrismHealth()
  resetPrismFeatures()
  resetLensWaits()
  resetLensRefusals()
  resetLensRegistry()
  resetLensQueues()
  resetLensViewPool()
})

describe('blocked by list, from a raw lens answer to the row (8.3)', () => {
  it('names the list from the reader’s block lists, with View list', async () => {
    const qc = setup({
      extra: {blockingByListUri: LIST},
      blocks: () => ({
        status: 200,
        body: {lists: [listView(LIST, 'Spam accounts')]},
      }),
    })
    const {snapshot, screen} = await renderGapRow(qc)
    expect(snapshot?.nodes.get(E1)).toMatchObject({
      kind: 'gap',
      gap: 'blocked-by-you',
      listUri: LIST,
    })
    await waitFor(() =>
      expect(screen.getByText('Blocked by Spam accounts')).toBeTruthy(),
    )
    const link = screen.getByTestId(
      'link:/profile/owner.test/lists/3klist2222222',
    )
    expect(link.props.nativeID).toBe('View list')
    expect(screen.getByText('View list')).toBeTruthy()
    expect(screen.queryByText('Post from someone you’ve blocked')).toBeNull()
    // The lookups take only the reader's identity: no gap URI, no author.
    for (const call of appviewCalls) {
      const sent = `${call.params.toString()} ${JSON.stringify(call.body ?? {})}`
      expect(sent).not.toContain(BLOCKED)
    }
    expect(
      appviewCalls.some(call => call.nsid === 'app.bsky.graph.getList'),
    ).toBe(false)
  })

  it('reads a list missing from the block lists by its URI', async () => {
    const asked: string[] = []
    const qc = setup({
      extra: {blockingByListUri: LIST},
      getList: params => {
        asked.push(params.get('list') ?? '')
        return {
          status: 200,
          body: {list: listView(LIST, 'Reply guys'), items: []},
        }
      },
    })
    const {screen} = await renderGapRow(qc)
    await waitFor(() =>
      expect(screen.getByText('Blocked by Reply guys')).toBeTruthy(),
    )
    expect(asked).toEqual([LIST])
    expect(
      screen.getByTestId('link:/profile/owner.test/lists/3klist2222222'),
    ).toBeTruthy()
  })

  it('keeps the row and its action when the name cannot be read', async () => {
    const qc = setup({
      extra: {blockingByListUri: LIST},
      blocks: () => ({status: 500, body: {error: 'InternalServerError'}}),
    })
    const {screen} = await renderGapRow(qc)
    expect(screen.getByText('Blocked by a list')).toBeTruthy()
    // The owner's DID while no handle is known.
    expect(
      screen.getByTestId(`link:/profile/${OWNER}/lists/3klist2222222`),
    ).toBeTruthy()
  })

  it('names the list the public view puts in `blocking` without its list view', async () => {
    const qc = setup({
      extra: {},
      blocks: () => ({
        status: 200,
        body: {lists: [listView(LIST, 'Spam accounts')]},
      }),
    })
    // prism showed E1 as a post; the public view says the reader blocks
    // its author through LIST, naming only the list's URI (6.3).
    const e1 = view('3ke1222222222', {
      did: BLOCKED,
      parent: ROOT,
      authorViewer: {blocking: LIST, blockedBy: false, muted: false},
    })
    mockPrismNodes = [postNode(e1)]
    mockExtraPosts = [e1]
    const {snapshot, screen} = await renderGapRow(qc)
    expect(snapshot?.nodes.get(E1)).toMatchObject({
      kind: 'gap',
      gap: 'blocked-by-you',
      listUri: LIST,
    })
    await waitFor(() =>
      expect(screen.getByText('Blocked by Spam accounts')).toBeTruthy(),
    )
  })

  it('is the plain row without the field (a direct block), and reads nothing', async () => {
    const qc = setup({extra: {}})
    const {snapshot, screen} = await renderGapRow(qc)
    expect(snapshot?.nodes.get(E1)).not.toHaveProperty('listUri')
    expect(screen.getByText('Post from someone you’ve blocked')).toBeTruthy()
    expect(screen.queryByText('View list')).toBeNull()
    expect(
      appviewCalls.some(call => call.nsid.startsWith('app.bsky.graph.')),
    ).toBe(false)
  })
})
