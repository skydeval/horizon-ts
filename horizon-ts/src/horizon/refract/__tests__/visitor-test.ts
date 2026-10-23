/* oxlint-disable import/no-nodejs-modules -- reads the source files as text, in jest only */
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'

import {beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  REFRACT: true,
}))
let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => mockMembership,
  subscribeMembership: () => () => {},
  isPrivateMember: () => mockMembership === 'member',
  reportPrismError: () => {},
}))
jest.mock('#/horizon/routing/prism-direct', () => ({
  getDirectPrismClient: () => ({}),
  getDirectPrismToken: () => Promise.resolve('token'),
  startDirectTokenPrefetch: () => () => {},
}))

import {
  RF_DID,
  RF_STOCK_DID,
  rfAuthorFeedPage,
  rfPost,
  rfProfile,
  rfUri,
} from '#/horizon/refract/fixtures'
import {normalizeRestored} from '#/horizon/refract/normalize'
import {seedOwnRelations} from '#/horizon/refract/relations'
import {restoredActionsHidden} from '#/horizon/refract/visitor'
import {setupRefract} from './harness'

/*
 * 11.1 "visitor form" and "normalizer" (refract client design 9.2, 10).
 */

beforeEach(() => {
  mockMembership = 'member'
  setupRefract()
})

describe('visitor-form hiding', () => {
  it('hides like, repost and follow on visitor-stamped views, stock reposts included', () => {
    const page = rfAuthorFeedPage() as {feed: {post: object}[]}
    normalizeRestored(page, 'visitor')
    expect(restoredActionsHidden(page.feed[0].post)).toBe(true)
    expect(restoredActionsHidden(page.feed[1].post)).toBe(true)
  })

  it('shows them for a ready member on member-stamped views', () => {
    const post = rfPost('rf1')
    normalizeRestored(post, 'member')
    expect(restoredActionsHidden(post)).toBe(false)
  })

  it('a visitor view stays hidden after the reader becomes a ready member', () => {
    mockMembership = 'not-member'
    const post = rfPost('rf1')
    normalizeRestored(post, 'visitor')
    mockMembership = 'member'
    expect(restoredActionsHidden(post)).toBe(true)
  })

  it('a marker-only view (Thread Lens) follows the prediction now', () => {
    const post = rfPost('rf1')
    mockMembership = 'not-member'
    expect(restoredActionsHidden(post)).toBe(true)
    mockMembership = 'member'
    expect(restoredActionsHidden(post)).toBe(false)
  })

  it('viewerChecked reveals a listed post and nothing else', () => {
    const listed = rfPost('rf1', {viewer: {like: rfUri('like1')}})
    const unlisted = rfPost('rf2', {viewer: {like: rfUri('like2')}})
    const body = {
      posts: [listed, unlisted],
      viewerChecked: {posts: [rfUri('rf1')], actors: [], roots: []},
    }
    normalizeRestored(body, 'visitor')
    expect(restoredActionsHidden(listed)).toBe(false)
    expect(restoredActionsHidden(unlisted)).toBe(true)
    const none = rfPost('rf3')
    normalizeRestored({posts: [none]}, 'visitor')
    expect(restoredActionsHidden(none)).toBe(true)
  })

  it('plain stock views are untouched', () => {
    expect(
      restoredActionsHidden(rfPost('x', {did: RF_STOCK_DID, restored: false})),
    ).toBe(false)
  })
})

describe('the normalizer', () => {
  it('an own block record sets viewer.blocking; a muted DID sets viewer.muted', () => {
    seedOwnRelations({
      blocks: {[RF_DID]: 'at://reader/app.bsky.graph.block/1'},
      mutes: [RF_DID],
    })
    const profile = rfProfile()
    normalizeRestored({profiles: [profile]}, 'member')
    const viewer = profile.viewer as {blocking?: string; muted?: boolean}
    expect(viewer.blocking).toBe('at://reader/app.bsky.graph.block/1')
    expect(viewer.muted).toBe(true)
  })
})

/*
 * Every call site of the like, repost and follow mutation queues consults
 * the hook, apart from the allowlist (9.2).
 */
const SRC = join(__dirname, '../../..')
const QUEUES =
  /\b(usePostLikeMutationQueue|usePostRepostMutationQueue|useProfileFollowMutationQueue|useFollowMethods)\(/
const ALLOWLIST: Record<string, string> = {
  // A chat member is never a Refract view.
  'screens/Messages/ConversationSettings/Member.tsx': 'chat member',
  // The queue wrapper itself; its callers consult the hook.
  'components/hooks/useFollowMethods.ts': 'queue wrapper',
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

describe('queue call sites', () => {
  it('each one consults useRestoredActionsHidden', () => {
    const missing: string[] = []
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      if (rel.startsWith('state/queries/')) continue
      const text = readFileSync(file, 'utf8')
      if (!QUEUES.test(text)) continue
      if (ALLOWLIST[rel]) continue
      if (!text.includes('useRestoredActionsHidden(')) missing.push(rel)
    }
    expect(missing).toEqual([])
  })

  it('fails when a site is planted without the hook', () => {
    const planted = 'const [queueLike] = usePostLikeMutationQueue(post)'
    expect(
      QUEUES.test(planted) && !planted.includes('useRestoredActionsHidden('),
    ).toBe(true)
  })
})
