/* oxlint-disable import/no-nodejs-modules -- reads the source files as text, in jest only */
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

jest.mock('#/horizon/switches', () => ({
  ...jest.requireActual<object>('#/horizon/switches'),
  REFRACT: true,
}))
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
jest.mock('#/state/cache/post-shadow', () => ({
  updatePostShadow: () => {},
}))

import {XrpcResponseError} from '@atproto/lex'
import {i18n} from '@lingui/core'

import {
  classifyRefractError,
  devFixturesActive,
  REFRACT_TIMING,
  refractCall,
  refractRetryAt,
} from '#/horizon/refract/api'
import {markStockFailed} from '#/horizon/refract/fill'
import {
  RF_DID,
  RF_READER_DID,
  rfFillAnswer,
  rfPost,
  rfProfile,
  rfUri,
} from '#/horizon/refract/fixtures'
import {refractActive} from '#/horizon/refract/gate'
import {REFRACT_METHODS} from '#/horizon/refract/lexicon'
import {quoteStatusOf} from '#/horizon/refract/quote-status'
import {seedOwnRelations} from '#/horizon/refract/relations'
import {
  refractReplyFallback,
  ReplyParentUnavailableError,
  resolvedViaRestoredParent,
} from '#/horizon/refract/writes'
import {answerPrismFeatures} from '#/horizon/routing/features'
import {app} from '#/lexicons'
import {type Harness, setupRefract} from './harness'

/*
 * 11.1 "writes", "quotes", "health and throttle", "copy" and "logs".
 */

function xrpcError(status: number, error: string, headers = {}) {
  const body = {error, message: error}
  return new XrpcResponseError(
    app.bsky.actor.getProfile as never,
    new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json', ...headers},
    }),
    {encoding: 'application/json', body} as never,
  )
}

i18n.loadAndActivate({locale: 'en', messages: {}})

let h: Harness

beforeEach(() => {
  jest.useFakeTimers()
  h = setupRefract()
})

afterEach(() => {
  jest.useRealTimers()
})

async function result<T>(promise: Promise<T>, ms = 11_000) {
  let outcome: {value?: T; error?: unknown} | undefined
  void promise.then(
    value => {
      outcome = {value}
    },
    error => {
      outcome = {error}
    },
  )
  await jest.advanceTimersByTimeAsync(ms)
  return outcome
}

describe('reply fallback', () => {
  const PARENT = rfUri('rf1')

  it('gives uri, cid and root, and marks viaRestoredParent', async () => {
    markStockFailed(RF_DID)
    const post = rfPost('rf1', {
      reply: {parent: rfUri('p0'), root: rfUri('root')},
    })
    h.respond(() =>
      rfFillAnswer({profiles: [rfProfile()], posts: [post], withheld: []}),
    )
    const outcome = await result(refractReplyFallback(PARENT))
    expect(outcome?.value?.parent.uri).toBe(PARENT)
    expect(outcome?.value?.root.uri).toBe(rfUri('root'))
    expect(resolvedViaRestoredParent(PARENT)).toBe(true)
  })

  it('an own block refuses before the fill decides', async () => {
    seedOwnRelations({blocks: {[RF_DID]: 'at://reader/app.bsky.graph.block/1'}})
    const outcome = await result(refractReplyFallback(PARENT))
    expect(String((outcome?.error as Error).message)).toContain(
      'can’t reply to this post',
    )
  })

  it('blockedBy on the author’s profile refuses when the post is held back', async () => {
    markStockFailed(RF_DID)
    h.respond(() =>
      rfFillAnswer({
        profiles: [rfProfile(RF_DID, {viewer: {blockedBy: true}})],
        withheld: [],
      }),
    )
    const outcome = await result(refractReplyFallback(PARENT))
    expect(String((outcome?.error as Error).message)).toContain(
      'can’t reply to this post',
    )
  })

  it('a definitive answer with no post leaves ReplyDeletedError to the caller', async () => {
    markStockFailed(RF_DID)
    h.respond(() => rfFillAnswer({withheld: []}))
    const outcome = await result(refractReplyFallback(PARENT))
    expect(outcome).toEqual({value: undefined})
  })

  it('pending or a failed call throws ReplyParentUnavailableError with fixed text and no id', async () => {
    markStockFailed(RF_DID)
    h.respond(() => rfFillAnswer({pending: [RF_DID], withheld: []}))
    const pending = await result(refractReplyFallback(PARENT))
    const error = pending?.error as Error
    expect(error).toBeInstanceOf(ReplyParentUnavailableError)
    expect(error.message).toBe('This post can’t be replied to right now.')
    expect(error.message).not.toContain('not locate record')
    h.respond(() => {
      throw new TypeError('network down')
    })
    const failed = await result(refractReplyFallback(rfUri('rf2')))
    const failure = failed?.error as Error
    expect(failure).toBeInstanceOf(ReplyParentUnavailableError)
    expect(failure.message).toContain('server appears to be experiencing')
    expect(failure.message).not.toContain(RF_DID)
  })
})

describe('the quote slot', () => {
  const URI = rfUri('rf1')

  /*
   * skydeval 2026-10-27: "Deleted" at once, as stock shows it; a restored
   * post replaces it when one comes back.
   */
  it('"Deleted" before any answer, while pending, and on every failure', () => {
    for (const outcome of [
      undefined,
      {kind: 'author', author: 'pending'},
      {kind: 'author', author: 'unavailable'},
      {kind: 'gone'},
      {kind: 'missing'},
      {kind: 'unresolved'},
      {kind: 'unavailable'},
      {kind: 'failed', error: new Error('x')},
    ] as const) {
      expect(quoteStatusOf(URI, undefined, outcome).kind).toBe('deleted')
    }
  })

  it('a restored post replaces "Deleted" when it comes back', () => {
    const post = rfPost('rf1') as unknown as app.bsky.feed.defs.PostView
    expect(quoteStatusOf(URI, post, undefined)).toEqual({kind: 'post', post})
    expect(quoteStatusOf(URI, undefined, {kind: 'positive', post})).toEqual({
      kind: 'post',
      post,
    })
  })

  it('"Blocked" for blocks', () => {
    expect(quoteStatusOf(URI, undefined, {kind: 'blocked'}).kind).toBe(
      'blocked',
    )
    seedOwnRelations({blocks: {[RF_DID]: 'at://reader/app.bsky.graph.block/1'}})
    expect(quoteStatusOf(URI, undefined, undefined).kind).toBe('blocked')
  })
})

describe('health and throttle', () => {
  it('classifies errors by name, then status', () => {
    expect(classifyRefractError(xrpcError(400, 'NotEnabled'))).toBe(
      'not-enabled',
    )
    expect(classifyRefractError(xrpcError(401, 'InvalidToken'))).toBe('auth')
    expect(classifyRefractError(xrpcError(429, 'RateLimitExceeded'))).toBe(
      'transient',
    )
    expect(classifyRefractError(xrpcError(400, 'NotFound'))).toBe('not-found')
    expect(classifyRefractError(xrpcError(400, 'AccountTakedown'))).toBe(
      'restore-ended',
    )
    expect(classifyRefractError(xrpcError(400, 'InvalidRequest'))).toBe(
      'invalid',
    )
    expect(classifyRefractError(xrpcError(502, 'Whatever'))).toBe('transient')
    expect(classifyRefractError(new TypeError('fetch failed'))).toBe(
      'transient',
    )
  })

  it('a 429 sets retryAt with the hint as a floor; background calls then skip', async () => {
    h.respond(() => {
      throw xrpcError(429, 'RateLimitExceeded', {'retry-after': '120'})
    })
    await result(
      refractCall(REFRACT_METHODS.getReplies, {}, {foreground: true}),
      10,
    )
    expect(refractRetryAt(RF_READER_DID) - Date.now()).toBeGreaterThanOrEqual(
      119_000,
    )
    const skipped = await result(
      refractCall(REFRACT_METHODS.fill, {}, {foreground: false}),
      10,
    )
    expect((skipped?.error as Error).name).toBe('RefractSkippedError')
  })

  it('NotEnabled turns refract off until the next membership answer', async () => {
    h.respond(() => {
      throw xrpcError(400, 'NotEnabled')
    })
    await result(refractCall(REFRACT_METHODS.fill, {}, {foreground: true}), 10)
    expect(refractActive()).toBe(false)
    answerPrismFeatures(RF_READER_DID, ['private', 'refract'])
    expect(refractActive()).toBe(true)
  })

  it('paces background calls to 3 a second', async () => {
    h.respond(() => ({posts: []}))
    for (let i = 0; i < 6; i++) {
      void refractCall(REFRACT_METHODS.getReplies, {}, {foreground: false})
    }
    await jest.advanceTimersByTimeAsync(10)
    expect(h.calls).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(1_000)
    expect(h.calls.length).toBeLessThanOrEqual(4)
    expect(REFRACT_TIMING.backgroundDeadlineMs).toBe(7_000)
  })

  it('the dev fixtures are never on outside a development build', () => {
    expect(devFixturesActive(false)).toBe(false)
  })
})

/* Copy and logs, checked on the refract sources. */
const REFRACT_DIR = join(__dirname, '..')

function refractSources(dir = REFRACT_DIR, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) refractSources(path, out)
    else if (/\.(ts|tsx)$/.test(name) && name !== 'fixtures.ts') out.push(path)
  }
  return out
}

/** The user-facing strings: `t` and `l` templates and `<Trans>` bodies. */
function userStrings(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/\b[tl]`([^`]*)`/g)) found.push(match[1])
  for (const match of text.matchAll(/<Trans>([\s\S]*?)<\/Trans>/g)) {
    found.push(match[1])
  }
  return found
}

const FORBIDDEN = /refract|restored|banned|suspended|rfxcommunity|not found/i

describe('copy', () => {
  it('no user-facing string names the feature, a restore, a ban or the community', () => {
    const bad: string[] = []
    for (const file of refractSources()) {
      for (const text of userStrings(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN.test(text)) bad.push(text)
      }
    }
    expect(bad).toEqual([])
  })

  it('the pending and unconfirmed texts claim no server fault', () => {
    const copy = readFileSync(join(REFRACT_DIR, 'copy.ts'), 'utf8')
    const notNow = userStrings(copy).filter(text => text.includes('right now'))
    expect(notNow.length).toBe(2)
    expect(notNow.some(text => /server/i.test(text))).toBe(false)
  })

  it('fails when a string is planted', () => {
    expect(
      userStrings('const x = l`This account was restored`').some(text =>
        FORBIDDEN.test(text),
      ),
    ).toBe(true)
  })
})

describe('logs', () => {
  it('no log line carries a DID or a URI', () => {
    const bad: string[] = []
    for (const file of refractSources()) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/logger\.\w+\(([\s\S]*?)\)\n/g)) {
        if (/\b(did|uri|author|actor|anchor|root)\b/.test(match[1])) {
          bad.push(match[1])
        }
      }
    }
    expect(bad).toEqual([])
  })
})
