import {type Client} from '@atproto/lex'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {act, renderHook, waitFor} from '@testing-library/react-native'

/*
 * The draft save mutation against the real visibility table and compose
 * store, with the draft network call held open so the composer can close
 * (reset the compose to Public) or the account can change before it returns
 * (Phase 5 review pass 8, P5R8-L1).
 */
let releaseCall: (value: {id: string}) => void = () => {}
const mockCall = jest.fn(
  () =>
    new Promise<{id: string}>(resolve => {
      releaseCall = resolve
    }),
)
jest.mock('#/state/session', () => ({
  useAppviewClient: () => ({call: mockCall}),
  useChatClient: () => ({}),
}))
jest.mock('#/view/com/composer/drafts/state/api', () => ({
  composerStateToDraft: () =>
    Promise.resolve({draft: {posts: []}, localRefPaths: new Map()}),
  draftViewToSummary: () => undefined,
}))
jest.mock('#/view/com/composer/drafts/state/storage', () => ({
  mediaExists: () => true,
  saveMediaToLocal: () => Promise.resolve(),
  deleteMediaFromLocal: () => Promise.resolve(),
  ensureMediaCachePopulated: () => Promise.resolve(),
  loadMediaFromLocal: () => Promise.resolve(''),
}))
jest.mock('#/analytics', () => ({useAnalytics: () => ({})}))
jest.mock('#/analytics/identifiers', () => ({getDeviceId: () => 'device'}))
jest.mock('#/horizon/media-spoilers/drafts', () => ({
  recordDraftSpoilers: () => {},
}))

import {useSaveDraftMutation} from '#/view/com/composer/drafts/state/queries'
import {type ComposerState} from '#/view/com/composer/state/composer'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {writeLocal} from '#/horizon/session/local-store'
import {readDraftTable} from '../composer/drafts'
import {
  type ComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
} from '../composer/state'
import {AUDIENCE, DID, OTHER_AUDIENCE, OTHER_DID} from './fixtures'

const client = {} as Client

const COMPOSER_STATE = {
  thread: {posts: []},
  originalLocalRefs: undefined,
} as unknown as ComposerState

const CLOSE_FRIENDS: ComposeVisibility = {
  visibility: 'private',
  audience: {kind: 'list', uri: AUDIENCE},
  locked: false,
}

function signIn(did: string) {
  clearCurrentClients()
  publishCurrentClients({
    did,
    handle: `${did.slice(-4)}.test`,
    pdsUrl: 'https://pds.example',
    pdsClient: client,
    prismClient: client,
    appviewClient: client,
  })
}

/**
 * Starts a save of a new draft and waits until its network call is held, so
 * the save is in flight. `finish` runs `during` (the close or the switch),
 * then lets the call return `draftId` and waits for the save to settle.
 */
async function startSave() {
  const queryClient = new QueryClient({
    defaultOptions: {mutations: {retry: false}},
  })
  const {result, unmount} = renderHook(() => useSaveDraftMutation(), {
    wrapper: ({children}) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
  let saved: Promise<unknown> = Promise.resolve()
  act(() => {
    saved = result.current.mutateAsync({composerState: COMPOSER_STATE})
  })
  await waitFor(() => expect(mockCall).toHaveBeenCalled())
  return {
    async finish(draftId: string, during: () => void) {
      during()
      await act(async () => {
        releaseCall({id: draftId})
        await saved
      })
      unmount()
      queryClient.clear()
    },
  }
}

beforeEach(() => {
  mockCall.mockClear()
  writeLocal(`horizon:draft-visibility:${DID}`, undefined)
  writeLocal(`horizon:draft-visibility:${OTHER_DID}`, undefined)
  setComposeVisibility(PUBLIC_COMPOSE)
  signIn(DID)
})

describe('a draft save records the visibility it started with (P5R8-L1)', () => {
  it('a Private save whose composer closes before it returns records Private with its audience', async () => {
    setComposeVisibility(CLOSE_FRIENDS)
    const save = await startSave()
    // The composer unmounts: usePrivateComposeSession resets the compose.
    await save.finish('draft-1', () => setComposeVisibility(PUBLIC_COMPOSE))
    expect(readDraftTable(DID)).toEqual([
      {
        id: 'draft-1',
        visibility: 'private',
        audience: {kind: 'list', uri: AUDIENCE},
      },
    ])
  })

  it('keeps the audience it started with when a new compose picks another', async () => {
    setComposeVisibility(CLOSE_FRIENDS)
    const save = await startSave()
    await save.finish('draft-1', () =>
      setComposeVisibility({
        visibility: 'private',
        audience: {kind: 'list', uri: OTHER_AUDIENCE},
        locked: false,
      }),
    )
    expect(readDraftTable(DID)).toEqual([
      {
        id: 'draft-1',
        visibility: 'private',
        audience: {kind: 'list', uri: AUDIENCE},
      },
    ])
  })

  it('a Public save records Public', async () => {
    const save = await startSave()
    await save.finish('draft-1', () => setComposeVisibility(CLOSE_FRIENDS))
    expect(readDraftTable(DID)).toEqual([{id: 'draft-1', visibility: 'public'}])
  })

  it('an account switch mid-save records under the account that saved it', async () => {
    setComposeVisibility(CLOSE_FRIENDS)
    const save = await startSave()
    await save.finish('draft-1', () => {
      signIn(OTHER_DID)
      setComposeVisibility(PUBLIC_COMPOSE)
    })
    expect(readDraftTable(DID)).toEqual([
      {
        id: 'draft-1',
        visibility: 'private',
        audience: {kind: 'list', uri: AUDIENCE},
      },
    ])
    expect(readDraftTable(OTHER_DID)).toEqual([])
  })
})
